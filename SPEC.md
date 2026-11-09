# SPEC — Availability sync service

> **Status:** draft for review, written before any code. It may change during implementation; the git history shows how.
>
> **How to read it.** Section 1 is the overview and section 2 lists every decision on one page. Sections 3–13 take one decision each, always in the same order: **Decision** → **How it works** (tables, Zod schemas, SQL) → **Alternatives considered**.

---

## 1. Overview

### 1.1 What we are building

A Node.js 24 + TypeScript service that:

1. accepts availability/price updates through `POST /updates`;
2. stores them in PostgreSQL;
3. syncs them to Portal Sol, respecting its rate limit and surviving its failures;
4. exposes `GET /accommodations/:id/sync-status`;
5. exposes structured logs and Prometheus metrics on `GET /metrics`.

### 1.2 What "no update is lost" means

An update is **accepted** when we answer `202 Accepted`. We only answer `202` **after** the update is committed to PostgreSQL. From that moment on it survives restarts and will reach the portal. If the service dies *before* answering, the update was not accepted: the client gets an error and must retry.

### 1.3 Assumptions

- **One service instance.** The rate limiter lives in memory (section 11).
- **Portal limits are unknown until measured.** API.md doesn't give the requests-per-minute limit or how slow "slow" is. A probe against Portal Sol sets those defaults (section 18).

### 1.4 Architecture at a glance

```
   POST /updates        GET /accommodations/:id/sync-status        GET /metrics
        │                            │                                  │
┌───────▼────────────────────────────▼──────────────────────────────────▼───────┐
│ One Node process                                                              │
│                                                                               │
│  HTTP API (Express) ── 1 transaction ──►  PostgreSQL                          │
│        ▲                                  ├─ updates        (append-only log) │
│        └────────── reads only ──────────  ├─ desired_days   (state per day)   │
│                                           └─ portal_state   (429 pause)       │
│                                                  ▲                            │
│  Worker pool (SYNC_CONCURRENCY = 4) ─────────────┘  poll due days,            │
│        │                                            1 advisory lock per       │
│        ▼                                            accommodation             │
│  Portal client: shared rate limiter + shared 429 pause + timeout              │
└────────┼──────────────────────────────────────────────────────────────────────┘
         ▼
     Portal Sol   (PUT ≤ 31 days per request)
```

**Life of one update**

1. `POST /updates` is validated, then saved in one transaction. Then the client gets `202`.
2. A worker finds an accommodation with days that are "to send" and takes its lock.
3. It joins neighbouring days with the same values into ranges of at most 31 days.
4. For each range it waits for a turn from the rate limiter, then sends a `PUT`.
5. It saves the result per day, but only for days that still hold the value it sent.

---

## 2. Decisions at a glance

| # | Topic | Chosen | Main alternatives | Section |
|---|---|---|---|---|
| D1 | Database | PostgreSQL | MongoDB | 3 |
| D2 | How pending work is stored | Per-day desired state (`desired_days` with `version` / `synced_version`) | Ordered queue of chunks | 4 |
| D3 | Stack | Express, pino, zod, `pg` with plain SQL, prom-client, Vitest | Fastify; NestJS with an ORM | 5 |
| D4 | Intake | Validate locally, save, answer `202`; never call the portal; accept unknown ids | Call the portal on intake; reject unknown ids using a cached list | 6 |
| D5 | Concurrency | Worker pool, one worker per accommodation through a session-level advisory lock | Row lock in an open transaction; transaction-level advisory lock; one sequential worker | 7 |
| D6 | Process model and shutdown | One process, polling every 1 s, minimal `SIGTERM` | Separate API and worker processes; `LISTEN/NOTIFY` | 8 |
| D7 | Failures | Retry forever with capped backoff; only `400`/`404` mark days failed | Attempt cap with a dead-letter state; special pause for `401` | 9 |
| D8 | Timeouts | Re-send the same `PUT`; a late-applied request is a known limitation | Check-and-fix with a verification `GET`; read back after every `PUT` | 10 |
| D9 | Rate limit | In-memory limiter plus a global pause on `429`, checked right before `fetch` | React to `429` only; shared limiter in Postgres; pause read from the database | 11 |
| D10 | Sync status | Summary plus ranges of non-synced days, built from Postgres only | Summary only; every day listed | 12 |
| D11 | Observability | 6 metrics (the README minimum plus `sync_failed_days`), 5 alerts, pino logs | More failure signals; 5 metrics only | 13 |
| D12 | Tests | 9 tests against real Postgres and a scripted fake portal, plus 1 end-to-end test | Real portal only; mock everything | 16 |

---

## 3. D1 — Database: PostgreSQL

**Decision.** PostgreSQL.

**What we need from the database.**

1. Save an update **and** its pending work in one atomic step.
2. Let only **one worker handle an accommodation at a time**, and free that lock by itself if the worker dies.
3. Answer status and metrics questions with simple queries.

| Need | PostgreSQL | MongoDB (standalone, as in `docker-compose.yml`) |
|---|---|---|
| Atomic "save update + pending work" | One transaction across tables | No multi-document transactions on a standalone server, so everything must fit in **one document** |
| One worker per accommodation | Advisory lock, **released automatically** when the connection drops | A lease with an expiry time (`leaseUntil`) |
| Status and metrics queries | Plain SQL | Aggregation pipelines |

**Why.** PostgreSQL gives the shortest correctness argument: one transaction, and one lock that frees itself.

**Alternatives considered.**

| Alternative | Pros | Cons / why not chosen |
|---|---|---|
| **MongoDB** (standalone) | Flexible documents; also offered by the README | The pending queue must live inside the accommodation document so one write can save it. Locks become **time-based leases**: if a portal call takes longer than the lease, a second worker can take over and send a newer value first, and then the slow, older request lands last and overwrites it. A long lease makes crash recovery slow. Durable writes must be configured explicitly (`{ w: 1, j: true }`). We also found an ordering bug in the first sketch ("increment a counter, then insert"): two concurrent requests could be stored out of order. |

---

## 4. D2 — Pending work: per-day desired state

**Decision.** We store **what each day should look like on the portal now**: one row per accommodation and day. Each row has a `version`, which changes on every update, and a `synced_version`, the last version the portal confirmed. A day is **to send** when `version > synced_version` and it isn't failed.

### 4.1 The problem it solves

Updates can overlap:

- **A** sets Oct 1–7 to price 100.
- **B**, accepted later, sets Oct 3–4 to price 200.

The portal must end with **200 on Oct 3–4 and 100 on the other days**. "Later" means the order in which our service accepted the updates.

```
After A:   Oct1 100 v1 | Oct2 100 v1 | Oct3 100 v1 | Oct4 100 v1 | Oct5 100 v1 | ...
After B:   Oct1 100 v1 | Oct2 100 v1 | Oct3 200 v2 | Oct4 200 v2 | Oct5 100 v1 | ...
Worker:    PUT 1–2 @100              | PUT 3–4 @200              | PUT 5–7 @100
```

We always send the newest value, so the order in which updates are sent no longer matters.

### 4.2 Database tables

```sql
-- Every accepted request, never modified (history / audit, and updateId for logs).
CREATE TABLE updates (
  id               bigserial     PRIMARY KEY,
  accommodation_id text          NOT NULL,
  from_date        date          NOT NULL,
  to_date          date          NOT NULL,
  available        boolean       NOT NULL,
  price_per_night  numeric(10,2) NOT NULL,
  accepted_at      timestamptz   NOT NULL DEFAULT now()
);

-- One global counter, so every change gets a bigger number than the ones before it.
CREATE SEQUENCE desired_version_seq;

-- What each day should look like on the portal right now.
CREATE TABLE desired_days (
  accommodation_id text          NOT NULL,
  date             date          NOT NULL,
  available        boolean       NOT NULL,
  price_per_night  numeric(10,2) NOT NULL,
  version          bigint        NOT NULL,            -- nextval('desired_version_seq') on every change
  synced_version   bigint        NOT NULL DEFAULT 0,  -- last version the portal confirmed
  changed_at       timestamptz   NOT NULL DEFAULT now(), -- when `version` last changed (oldestPendingSince)
  synced_at        timestamptz,                       -- when the portal last confirmed this day (lastSyncedAt)
  attempts         int           NOT NULL DEFAULT 0,  -- failed tries for the current version (backoff)
  next_attempt_at  timestamptz   NOT NULL DEFAULT now(), -- not sent again before this time
  last_error_code  text,                              -- e.g. UNAVAILABLE, TIMEOUT, NOT_FOUND
  last_error_at    timestamptz,
  failed_at        timestamptz,                       -- set on 400/404 (section 9); cleared by a new POST
  PRIMARY KEY (accommodation_id, date)
);

-- Keeps "find days to send" fast: only rows that still need work are indexed.
CREATE INDEX desired_days_due ON desired_days (next_attempt_at)
  WHERE version > synced_version AND failed_at IS NULL;

-- Global portal state: exactly one row.
CREATE TABLE portal_state (
  id           int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  paused_until timestamptz                            -- set on 429 from Retry-After (section 11)
);
INSERT INTO portal_state (id) VALUES (1) ON CONFLICT DO NOTHING;
```

**What each table is for.**

| Table | Written by | Read by | Purpose |
|---|---|---|---|
| `updates` | `POST /updates` | Logs only | Log of every accepted request; never changed |
| `desired_days` | `POST /updates` (new values), workers (results) | Workers, `sync-status`, `/metrics` | The state of each day: what it should be, and whether the portal has it |
| `portal_state` | Portal client on `429` | Portal client at startup | Survive a restart in the middle of a `429` pause |

**State of one day** (the first rule that matches):

| Day state | Rule |
|---|---|
| `failed` | `failed_at IS NOT NULL` |
| `pending` | `version > synced_version` |
| `synced` | none of the above |

**Alternatives considered.**

| Alternative | Pros | Cons / why not chosen |
|---|---|---|
| **Ordered queue**: each update split into chunks of at most 31 days, stored in a `sync_jobs` table and sent strictly in order per accommodation | Less code. Easy to answer "did update #42 reach the portal?" (one row per chunk) | Every update is sent even if a newer one already replaced it. One stuck chunk blocks every later update for that accommodation. Checking the portal later means rebuilding "what each day should be" from the whole log. |

| | Ordered queue | Per-day state (chosen) |
|---|---|---|
| Final state correct | Yes | Yes |
| Send order between updates matters | Yes, strictly | No |
| Requests to the portal | One per chunk, even if overwritten | Fewer when days change often |
| One failure blocks… | Every later update for the accommodation | Only those days |
| Checking the portal later (section 10, not built) | Rebuild from the log | Direct comparison |
| "Did update #42 arrive?" | Easy | Harder; not required (the README asks for status **per accommodation**). A `source_update_id` column per day would answer it. |

---

## 5. D3 — Stack

**Decision.**

| Need | Choice | Why |
|---|---|---|
| HTTP server | **Express** | The framework I know best, so every line is easy to explain and extend live |
| Structured logs | **pino** + `pino-http` | JSON logs with request ids; fast; standard in Node |
| Validation | **zod** | Types and runtime checks from one schema (request body, config) |
| Database access | **`pg`** (node-postgres), plain SQL | The design relies on advisory locks on dedicated connections and hand-written queries; an ORM would be bypassed anyway |
| Migrations | Plain `.sql` files, run in order at startup | No extra tool; the schema is readable as-is |
| Metrics | **prom-client** | Prometheus text format on `/metrics` |
| Portal calls | Native `fetch` + `AbortSignal.timeout()` | Built into Node 24; no extra dependency |
| Tests | **Vitest** | Fast and TypeScript-native |
| Package manager | npm | Comes with Node |

**Note for developers.** `pg` returns `bigint` and `numeric` columns as **strings**. Keep `version` as a string, and turn `price_per_night` into a number only when building the `PUT` body.

**Alternatives considered.**

| Alternative | Pros | Cons / why not chosen |
|---|---|---|
| **Fastify** | Built-in pino logs and schema validation; a bit less wiring | I haven't used it, and explaining the code live matters more than saving a few lines |
| **NestJS + an ORM** | More structure | Heavy for 3–4 hours, and our key queries (locks, guarded updates) would bypass the ORM |

---

## 6. D4 — Intake: `POST /updates`

**Decision.** `POST /updates` **never calls the portal**. It checks the request itself, saves it in one transaction, and answers `202`. If the portal is down or rate-limited, managers can still send updates; they sync later.

### 6.1 Request schema (Zod)

```ts
import { z } from 'zod';

// Real calendar day in YYYY-MM-DD ("2026-02-30" is rejected).
const isoDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isRealCalendarDay, 'Not a real calendar day');

export const UpdateRequest = z.object({
  accommodationId: z.string().min(1).max(64),            // no format check (see 6.4)
  from:            isoDate,
  to:              isoDate,
  available:       z.boolean(),
  pricePerNight:   z.number()
                    .nonnegative()
                    .max(99_999_999.99)                   // fits numeric(10,2)
                    .refine(hasAtMostTwoDecimals, 'At most 2 decimals'),
}).strict()                                               // unknown fields → 400
  .refine(u => u.to >= u.from,                            // same day or later
          { path: ['to'], message: '`to` must be on or after `from`' })
  .refine(u => daysInclusive(u.from, u.to) <= 366,        // our cap, per POST
          { path: ['to'], message: 'At most 366 days per update' });

export type UpdateRequest = z.infer<typeof UpdateRequest>;
```

| Field | Rule | Why |
|---|---|---|
| `accommodationId` | Non-empty string, max 64 characters, no format check | The format (`acc-1234`) belongs to the portal and could change |
| `from`, `to` | Real days in `YYYY-MM-DD`; `to >= from` | Comparing the strings works because the format is fixed |
| Range length | At most **366 days** per `POST`, counting both ends (`400 RANGE_TOO_LARGE`) | Stops one request creating tens of thousands of rows. This is separate from the portal's **31-day limit per request**, which the worker handles by splitting (section 7); the manager never sees it |
| `pricePerNight` | `>= 0`, at most 2 decimals, fits `numeric(10,2)` | Otherwise Postgres would silently round the price, or fail with a `500` |
| Other fields | Rejected | Typos don't pass silently |

### 6.2 Storage: one transaction

```sql
BEGIN;

INSERT INTO updates (accommodation_id, from_date, to_date, available, price_per_night)
VALUES ($1, $2, $3, $4, $5)
RETURNING id;                                              -- updateId

INSERT INTO desired_days (accommodation_id, date, available, price_per_night, version)
SELECT $1, d::date, $4, $5, nextval('desired_version_seq')
FROM generate_series($2::date, $3::date, interval '1 day') AS d
ON CONFLICT (accommodation_id, date) DO UPDATE SET
  available       = EXCLUDED.available,
  price_per_night = EXCLUDED.price_per_night,
  version         = nextval('desired_version_seq'),        -- taken after the row lock, so always newer
  changed_at      = now(),
  attempts        = 0,                                     -- the new value starts fresh
  next_attempt_at = now(),
  failed_at       = NULL;                                  -- a new POST re-arms failed days

COMMIT;                                                    -- only now do we answer 202
```

The `version` in the update branch is taken **inside** `DO UPDATE`, after Postgres has locked the row. If two POSTs change the same day at the same time, the one that writes last always gets the bigger version, so its value is the one that gets sent.

### 6.3 Responses

```ts
export const AcceptedResponse = z.object({   // 202
  updateId:        z.number().int(),
  accommodationId: z.string(),
  from:            z.string(),
  to:              z.string(),
  statusUrl:       z.string(),               // "/accommodations/acc-1003/sync-status"
});

export const ErrorResponse = z.object({      // 400, 404, 503: same shape as Portal Sol
  error: z.object({ code: z.string(), message: z.string() }),
});
```

| Case | Answer |
|---|---|
| Saved | `202` with `updateId`. It means **saved and will be synced**, not "already on the portal". |
| Invalid body | `400`, nothing saved, e.g. `{ "error": { "code": "INVALID_DATE", "message": "..." } }`. Codes (the same names as Portal Sol): `INVALID_DATE` for any problem with `from` or `to`, including `to` before `from`; `RANGE_TOO_LARGE` for more than 366 days; `INVALID_BODY` for everything else (wrong type, missing or unknown field, bad price, malformed JSON). |
| PostgreSQL unavailable | `503` with code `UNAVAILABLE`, nothing saved. The update was **not** accepted and the client must retry (1.2). |
| Anything unexpected | `500` with code `INTERNAL`, nothing saved (the transaction is rolled back). |

- Sending the same update twice (a client retry, say) is harmless: it is stored twice, but the newest value wins anyway, so the portal ends the same.
- `updateId` appears in the logs ("update 42 accepted"), so someone on call can follow one request.

### 6.4 Unknown accommodation ids are accepted

Checking ids would need the portal, or a cached copy of its list, which breaks the main rule. A stale list could also reject an accommodation that was just added. The two possible mistakes don't cost the same:

| Mistake | Cost |
|---|---|
| Accept an id that doesn't exist | One wasted `PUT` and a `404`. The days show as **failed** (`NOT_FOUND`) in sync status and are counted in `sync_failed_days` |
| Reject an id that does exist | A good update is lost |

Downside, accepted on purpose: the manager gets `202` for an update that will never sync, and finds out through sync status, metrics and alerts.

**Alternatives considered.**

| Alternative | Pros | Cons / why not chosen |
|---|---|---|
| **Send to the portal during the request** | The client knows straight away whether it worked | Intake would stop whenever the portal is down or rate-limited, and the client would have to retry; that is the opposite of "no update is lost" |
| **Reject unknown ids using a cached copy of the portal's list** | Instant feedback on typos | Depends on the portal; a stale list can reject a new accommodation (a lost update); more code |
| **Check the id format** (`acc-1234`) | Catches obvious typos | The format belongs to the portal and could change |

---

## 7. D5 — Workers and the sync cycle

**Decision.** One process runs a small **pool of workers** (`SYNC_CONCURRENCY`, default 4). Each worker handles **one accommodation at a time**, and two workers never handle the same one, thanks to a **session-level advisory lock** taken on the worker's own database connection.

All workers share the **same rate limiter and the same 429 pause** (section 11), so more workers can never take us **above** the limit. They only help us **use** it fully: while one worker waits on a slow portal call, the others use the free turns.

### 7.1 The lock

Each worker holds its **own dedicated connection** (not borrowed from the shared pool) and takes the lock on it:

```sql
SELECT pg_try_advisory_lock(hashtext($1));   -- true = this worker owns the accommodation
-- ... sync it, one small transaction per range ...
SELECT pg_advisory_unlock(hashtext($1));
```

- The lock isn't tied to a transaction, so the worker can **commit each result while holding it**, instead of keeping a transaction open across slow portal calls.
- It doesn't lock any table rows, so incoming POSTs are never blocked.
- If the worker dies, Postgres closes its connection and **the lock disappears**. There is no lease timer to tune.
- The connection must stay with the worker while it holds the lock. If it went back to a shared pool, the lock could end up on a connection someone else is using.
- Two ids could hash to the same number. Then those two accommodations simply never sync at the same time, which is harmless.

### 7.2 Steps for one accommodation

1. **Find work and lock it.**
   ```sql
   SELECT accommodation_id FROM desired_days
   WHERE version > synced_version AND failed_at IS NULL AND next_attempt_at <= now()
   GROUP BY accommodation_id
   ORDER BY min(next_attempt_at)         -- the one that has waited longest goes first
   LIMIT 20;
   ```
   Try the lock on each id in turn. If it's taken, try the next one.
2. **Read its due days.**
   ```sql
   SELECT date, available, price_per_night, version, attempts
   FROM desired_days
   WHERE accommodation_id = $1
     AND version > synced_version AND failed_at IS NULL AND next_attempt_at <= now()
   ORDER BY date;
   ```
3. **Join days into ranges** (pure function, unit test 1). Neighbouring calendar days with the **same values** go into one range of **at most 31 days** (the portal limit), and each range becomes one `PUT`. Each range remembers the **version of every day** it carries.
   ```ts
   type DueDay = { date: string; available: boolean; pricePerNight: string; version: string; attempts: number };
   type PortalRange = {
     from: string; to: string; available: boolean; pricePerNight: string;
     days: { date: string; version: string }[];   // what was read, so results can be guarded
   };
   function toRanges(days: DueDay[], maxDays = 31): PortalRange[];
   ```
4. **Send.** For each range, take a turn from the rate limiter (section 11), then send the `PUT`.
5. **Save the result, per day, only where the day still has the version we sent.**
   ```sql
   -- On 200. $2 = dates sent, $3 = the version of each of those days when it was read.
   UPDATE desired_days d
   SET    synced_version = s.version, synced_at = now()
   FROM   unnest($2::date[], $3::bigint[]) AS s(date, version)
   WHERE  d.accommodation_id = $1
     AND  d.date = s.date
     AND  d.version = s.version;      -- changed while we were sending? leave it "to send"
   ```
   If a new POST changed a day while the request was in flight, that day stays "to send" and goes out again with the new value. Error writes use the same guard (section 9).
6. **Release the lock** and look for the next accommodation.

**Why the guard is per day and not per range.** One range can join days with different versions, when they have the same values. A single "range version" could mark a day as synced although its newest value was never sent. Comparing each day with the exact version that was read avoids that.

**Alternatives considered.**

| Alternative | Pros | Cons / why not chosen |
|---|---|---|
| **Row lock held in an open transaction** (`FOR UPDATE SKIP LOCKED` across the `PUT`) | Also frees itself if the worker dies | A transaction stays open during every slow call, holding a connection and row locks the whole time |
| **Transaction-level advisory lock** (`pg_try_advisory_xact_lock`) | Released automatically at `COMMIT` | It ends at the first `COMMIT`, so it can't cover a series of small commits around slow portal calls |
| **One sequential worker, no lock** | Least code; ordering comes for free with one instance | One slow call (up to the full timeout) stops every accommodation, and a second instance started by mistake wouldn't be blocked |

---

## 8. D6 — Process model and shutdown

**Decision.** **One Node process** runs the HTTP API, the worker pool and `/metrics`; only the workers call the portal. Workers find work by **polling** Postgres. Shutdown on `SIGTERM` is **minimal**.

### 8.1 Polling

```
each worker, in a loop:
  find an accommodation with due work (7.2, step 1)
  ├─ found → lock it and sync it, then look again straight away
  └─ none  → sleep SYNC_POLL_INTERVAL_MS, then look again
```

The wait only happens when there is nothing to do, so it never slows down a busy period; the portal's rate limit is the real speed limit. `SYNC_POLL_INTERVAL_MS = 1000` is a **code constant**, not an environment variable. The worker takes it as an option with that default, so tests can pass a much shorter interval.

### 8.2 Normal stop (`SIGTERM`), kept minimal

1. Stop the HTTP server, and stop workers picking up new accommodations.
2. Let portal calls already sent finish (at most `PORTAL_TIMEOUT_MS`) and save their results.
3. Release the advisory locks, close the database pool, and exit.

Nothing more is needed, because a crash is safe anyway (8.3).

### 8.3 Hard crash (`kill -9`, power cut)

Nothing finishes, but nothing accepted is lost, because every update is already in PostgreSQL. Postgres drops the dead connections and their locks. Days whose `PUT` never got a clear answer still have `version > synced_version`, so after the restart they are simply sent again; sending the same `PUT` twice is safe. Test 4 proves this. The one case this doesn't cover is in section 10.

**Alternatives considered.**

| Alternative | Pros | Cons / why not chosen |
|---|---|---|
| **Separate API and worker processes**, talking only through Postgres | A worker crash wouldn't stop intake; closer to production | Two entry points and two `/metrics` endpoints; more than one instance needs |
| **Postgres `LISTEN/NOTIFY`** to wake workers when an update commits | Lower latency | A dedicated listener connection and reconnect handling, to save up to 1 s when the rate limit spaces calls about that far apart anyway |
| **Environment variable for the poll interval** | Tunable without a deploy | Nothing to tune for now; a constant keeps the config small |

---

## 9. D7 — Failures and retries

**Decision.** "No update is lost, even if the portal fails." So we **never give up on an error that waiting can fix**, and we only stop on errors that will fail again every time. Retrying the same `PUT` is safe because it is idempotent (API.md).

### 9.1 What we do with each answer

| Portal answer | What we do | What we write (only days still at the version sent) |
|---|---|---|
| `200` | Done | `synced_version`, `synced_at` (7.2, step 5) |
| `429 RATE_LIMITED` | Global pause until `Retry-After` (section 11). **Not** an attempt. | Nothing; the days stay "to send" |
| `503`, timeout, network error | Retry with backoff. **No attempt limit.** After a timeout the same `PUT` is sent again (section 10). | `attempts + 1`, `next_attempt_at`, `last_error_code`, `last_error_at` |
| `401 UNAUTHORIZED` | Same retry as `503`, **never** marked failed: the update is fine and our API key is wrong. Error log + metric `outcome="401"` (pages someone). | Same as `503` |
| `400`, `404` | Mark the days **failed**. Other days and accommodations keep syncing. A new `POST` for those days re-arms them (6.2). | `failed_at`, `last_error_code`, `last_error_at` |

`last_error_code` is the portal's error code (e.g. `UNAVAILABLE`, `NOT_FOUND`), or `TIMEOUT` / `NETWORK_ERROR` when there was no answer.

```sql
-- Retryable error. Same per-day guard as on 200.
UPDATE desired_days d
SET    attempts = d.attempts + 1, next_attempt_at = $4,
       last_error_code = $5, last_error_at = now()
FROM   unnest($2::date[], $3::bigint[]) AS s(date, version)
WHERE  d.accommodation_id = $1 AND d.date = s.date AND d.version = s.version;
```

**Only the version that was sent.** If the manager changed a day while the call was in progress, the error belongs to the old value, so it isn't written. The new value keeps its fresh start and goes out normally.

### 9.2 Backoff

- About 2 s, 4 s, 8 s … capped at **5 minutes**, with random jitter (±20%).
- The worker works out **one** `next_attempt_at` per range, from the highest `attempts` among its days, so the range stays together on the next try.
- The cap keeps a long outage at about 12 retries per hour per accommodation, and the rate limiter still caps the total. Jitter stops every accommodation retrying in the same second when the portal comes back.

### 9.3 Notes

- A `400` should never happen, because we validate on intake and split ranges to ≤31 days. If it happens, it's a bug on our side: failed + error log.
- A `401` only happens if `PORTAL_API_KEY` is wrong (API.md gives a fixed demo key, `sol-demo-key`). Optional: one `GET /api/v1/accommodations` at startup, to fail loudly on a wrong key.

**Alternatives considered.**

| Alternative | Pros | Cons / why not chosen |
|---|---|---|
| **Cap attempts and move to a dead-letter state** after N tries | Bounded work per update | A long outage would turn good updates into failures that need a manual replay, against "no update is lost" |
| **Special global pause for `401`**, with timed retries | Stops hammering the portal with a bad key | A `401` only means our config is wrong. The normal retry plus a paging alert is enough, with less code. |

---

## 10. D8 — Timeouts

**Decision.** Every portal call has a timeout (`PORTAL_TIMEOUT_MS`, through `AbortSignal.timeout`). After a timeout we **send the same `PUT` again** with the normal backoff until we get a clear answer. One rare case is a **known limitation**, written down here and not handled.

### 10.1 Known limitation: a timed-out request applied late

When a `PUT` times out, we don't know whether the portal applied it, and API.md warns it may still be processed later. Usually that's harmless: we send the same `PUT` again, and the same values win. The bad case is rarer:

1. We send Oct 3 = 100. It times out, but it's still stuck inside the portal.
2. The manager changes Oct 3 to 200, and we send it: `200 OK`.
3. The old, stuck request is applied last. The portal now shows 100, and we think it shows 200.

The same can happen if the service crashes in the middle of a `PUT` and a newer value is sent after the restart.

**Why we don't handle it.** Handling it properly takes a lot: a "PUT started" record before every call, a wait, a `GET` to compare the portal with `desired_days`, re-sending the wrong days, and a "verifying" state in sync status. It would be the most complex part of the design, for a rare case, so it doesn't fit the README's 3–4 hour budget or its request for a well-scoped solution. The probe (section 18) will show how real the case is.

### 10.2 Designed, not built (next step)

- Before each `PUT`, save "PUT started" (`in_flight_at`).
- After a timeout, or when a "PUT started" is found after a crash, schedule a check for those days a little later (`check_after`, with a delay measured with the probe).
- When the check is due, `GET` those days from the portal and compare them with `desired_days`. Matching days are done. Wrong days get a new `version`, so the normal flow sends them again.
- Only a matching `GET` clears the check, not a later `200`, and sync status shows "verifying" until then.

The per-day model (section 4) makes this a simple comparison, so it can be added later without changing the rest of the design.

**Alternatives considered.**

| Alternative | Pros | Cons / why not chosen |
|---|---|---|
| **Check-and-fix after uncertain sends** (10.2) | Fixes the late-applied case | The most complex part of the design, for a rare case; beyond the 3–4 h budget |
| **Read back after every `PUT`** | Simple rule | About doubles the calls against a limited quota, and almost every check finds nothing |
| **Periodic check of all accommodations** | Also catches changes made outside our service | Uses quota all the time; not asked for |

---

## 11. D9 — Rate limiting

**Decision.** Two rules, both in memory and shared by every worker:

1. **Space out the requests (limiter).** One call every `60 000 / PORTAL_MAX_REQUESTS_PER_MINUTE` ms, for **all** portal calls (`GET` and `PUT`). The value is set a bit below the limit measured with the probe, so we rarely hit `429` at all. The `/__admin/...` endpoints don't count, and the service never calls them.
2. **Stop everything on a `429` (pause).** On any `429`, **all** portal calls stop until `now + Retry-After`, because the limit is for our whole API key, not one accommodation. If `Retry-After` is missing or not a number, we wait 60 s.

### 11.1 Where the pause lives

- **In memory**, as the value every call checks. On a `429` it is set **straight away**, before anything else.
- **In the database** (`portal_state.paused_until`, section 4.2), only so a restart in the middle of a pause doesn't start sending too early. It is loaded into memory at startup.

### 11.2 Check right before sending

After taking its turn from the limiter, a call checks the in-memory pause and then calls `fetch`, with **no `await` in between**. Node runs one piece of code at a time, so nothing (such as another call's `429` handling) can happen between the check and the send.

```ts
// Shared by all workers in the process.
class Limiter {
  private nextSlot = 0;
  constructor(private intervalMs: number) {}
  async takeTurn(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);   // first free slot
    this.nextSlot = slot + this.intervalMs;       // book it
    await sleep(slot - now);
  }
}

const pause = { until: 0 };                        // loaded from portal_state at startup

async function callPortal(req: PortalRequest): Promise<Response | 'paused'> {
  await waitUntil(pause.until);                    // wait out a pause we already know about
  await limiter.takeTurn();                        // rule 1: one call every N ms
  if (Date.now() < pause.until) return 'paused';   // check again, then send at once:
  const res = await fetch(url(req), opts(req));    // no await between check and fetch
  if (res.status === 429) {
    pause.until = Math.max(pause.until, Date.now() + retryAfterMs(res)); // memory first
    await db.setPausedUntil(pause.until);                                  // then the database
    return 'paused';                               // the days stay "to send"
  }
  return res;
}
```

- If a call gives up its turn because a pause started while it waited, the turn is simply lost. That only makes us slightly slower, never faster.
- Calls **already sent** when a `429` comes back can't be stopped: we didn't know about the pause when we sent them.
- A `429` is **not** a failed attempt: `attempts` and the backoff don't change (section 9).
- If saving the pause to the database fails, the error is logged and the call still returns "paused": the in-memory pause already protects the rate limit, and the pause is only lost if the service restarts before the next `429`.

**Why both rules.** The pause alone is what API.md asks for, but without the limiter every busy period ends in a burst of rejected requests. The limiter alone breaks when our guess of the limit is wrong. Together, `429`s are rare and always respected.

**Single instance.** Two instances would each send at the full rate, and the pause would have to be shared through the database, not just loaded at startup. To run several instances, the limiter would move into the database too (section 17).

**Alternatives considered.**

| Alternative | Pros | Cons / why not chosen |
|---|---|---|
| **React to `429` only** | Less code; no need to know the limit | Keeps hitting the wall, which is visible in `/__admin/requests` and fits poorly with "does not overwhelm it" |
| **Shared limiter in PostgreSQL** (one row handing out time slots) | Works with any number of instances | Beyond the single-instance scope; the README prefers a well-scoped solution |
| **Read the pause from the database before each call** | One source of truth | There is an `await` between the check and the send, so a `429` saved in that gap is missed |

---

## 12. D10 — `GET /accommodations/:id/sync-status`

**Decision.** One small response that answers the two questions someone on call has: *"Is this accommodation OK on the portal?"* and, if not, *"Which dates, and why?"*. It is built from `desired_days` only, so it **never calls the portal**: it is fast, and it works when the portal is down.

### 12.1 Response schema (Zod)

```ts
const DayState = z.enum(['failed', 'pending', 'synced']);    // most urgent first

export const SyncStatusResponse = z.object({
  accommodationId:    z.string(),
  state:              DayState,                // most urgent day state present
  days: z.object({
    total:   z.number().int(),                 // days we have ever received updates for
    synced:  z.number().int(),
    pending: z.number().int(),
    failed:  z.number().int(),
  }),
  oldestPendingSince: z.string().datetime().nullable(), // earliest changed_at among pending days
  lastSyncedAt:       z.string().datetime().nullable(), // latest synced_at
  nextAttemptAt:      z.string().datetime().nullable(), // earliest next_attempt_at among pending days
  lastError: z.object({ code: z.string(), at: z.string().datetime() }).nullable(),
  ranges: z.array(z.object({                   // only non-synced days, grouped like the PUTs
    from:      z.string(),
    to:        z.string(),
    state:     z.enum(['pending', 'failed']),
    errorCode: z.string().optional(),          // failed ranges only
  })),
});
```

**Example.**

```json
{
  "accommodationId": "acc-1003",
  "state": "failed",
  "days": { "total": 40, "synced": 33, "pending": 5, "failed": 2 },
  "oldestPendingSince": "2026-11-08T10:15:00Z",
  "lastSyncedAt": "2026-11-08T10:20:12Z",
  "nextAttemptAt": "2026-11-08T10:21:00Z",
  "lastError": { "code": "UNAVAILABLE", "at": "2026-11-08T10:20:30Z" },
  "ranges": [
    { "from": "2026-12-01", "to": "2026-12-05", "state": "pending" },
    { "from": "2027-01-03", "to": "2027-01-04", "state": "failed", "errorCode": "NOT_FOUND" }
  ]
}
```

### 12.2 Rules

- Day states as in section 4.2. The overall `state` is the most urgent one present: `failed` → `pending` → `synced`.
- `ranges` lists only the days that are **not synced**, joined into neighbouring days with the same state, so the list stays short. It is empty when everything is synced.
- An id we have **never received an update for** gets `404` with our usual error shape (`NOT_FOUND`). It means "we know nothing about it", which is different from the portal's `404`, shown as failed days.
- `lastError` is the most recent error recorded on any of the accommodation's days, even if those days have synced since; `state` and `ranges` say whether anything is still wrong.
- A global `429` pause isn't shown here, because it affects every accommodation; it shows in metrics (section 13). Here it appears as `pending` with a later `nextAttemptAt`.

**Alternatives considered.**

| Alternative | Pros | Cons / why not chosen |
|---|---|---|
| **Summary only** | Smaller | Says something is wrong without saying where |
| **Every day listed** | Complete | Up to hundreds of entries; too noisy to read |
| **Separate lists per state** (`pendingRanges`, `failedRanges`) | Easy to pick one list | One `ranges` list with a `state` per range is simpler to read and to build |
| **`200` with `"in_sync"` for an unknown id** | Never an error | Misleading: we know nothing about that id |

---

## 13. D11 — Observability: metrics, alerts and logs

**Decision.** Keep to the **README minimum** (pending work, portal call outcomes and latency, retries) **plus one gauge for failed days**: six metrics in total. Five alerts are described, built from those metrics, and the logs are pino JSON. No Prometheus, Grafana or alerting stack is run.

### 13.1 Metrics (`GET /metrics`, Prometheus text format)

| Metric | Type | What it tells you | README item |
|---|---|---|---|
| `sync_pending_days` | gauge | Days not yet confirmed by the portal (failed days excluded) | Pending work |
| `sync_oldest_pending_age_seconds` | gauge | Age of the oldest of those days (`now() - min(changed_at)`). **The best "is it stuck?" number.** 0 when nothing is pending | Pending work |
| `portal_requests_total{method, outcome}` | counter | Portal calls by result. `method`: `GET`, `PUT`. `outcome`: `ok`, `429`, `503`, `timeout`, `network_error`, `401`, `400`, `404` | Call outcomes |
| `portal_request_duration_seconds{method}` | histogram | How long portal calls take | Latency |
| `sync_retries_total{reason}` | counter | Retries scheduled, by reason: `503`, `timeout`, `network_error`, `401` (a `429` is a pause, not a retry) | Retries |
| `sync_failed_days` | gauge | Days the portal rejected (`400`/`404`) that are **still** failed; back to 0 once a new `POST` re-arms them and they sync | Extra (below) |

- The three gauges are **read from PostgreSQL when `/metrics` is scraped**, so they are correct straight after a restart.
- **No `accommodationId` label** on any metric: one series per accommodation would explode the number of time series. That detail lives in the logs and in `sync-status`.

**Why `sync_failed_days`.** A failed day is never retried, so after the first `400`/`404` the outcome counter never moves again, and failed days are excluded from `sync_pending_days`. Without this gauge, an hour after the failure (or right after a restart, when counters start from zero) every metric would look healthy while days were still not synced. The counter says *a failure happened*; the gauge says *failures are still there*.

### 13.2 Alerts (described, not deployed)

*Page* = wake someone now. *Ticket* = look during working hours.

| Alert | Example rule | Why | Level |
|---|---|---|---|
| Sync stuck | `sync_oldest_pending_age_seconds > 900` for 5 min | Retries are capped at 5 min, so 15 min means at least 3 failed tries: the portal, or we, are broken. Also catches a dead worker | Page |
| Wrong API key | `increase(portal_requests_total{outcome="401"}[5m]) > 0` | Every sync is stuck until the config is fixed | Page |
| Failed days present | `sync_failed_days > 0` for 15 min | The portal rejected some days (bad id, or a bug on our side). Needs a person, but nothing gets worse. Stays on until fixed, also across restarts | Ticket |
| Limiter set too high | `429`s are more than 10% of portal calls for 10 min | `PORTAL_MAX_REQUESTS_PER_MINUTE` is above what the portal allows | Ticket |
| Portal getting slow | p95 of `portal_request_duration_seconds` above 80% of `PORTAL_TIMEOUT_MS` for 10 min | Timeouts and retries are about to start | Ticket |

### 13.3 Logs

pino JSON on stdout (`pino-http` for HTTP requests). Every sync line carries `accommodationId`, `from`, `to`, `attempt`, `outcome` and `durationMs`, and intake lines carry `updateId`, so one update can be followed from "accepted" to "on the portal", or to the reason it isn't there.

| Level | When |
|---|---|
| `info` | Update accepted; range sent and confirmed |
| `warn` | `429` pause started; `503`/timeout/network error and retry scheduled |
| `error` | `401`; days marked failed (`400`/`404`); unexpected exceptions |

**Alternatives considered.**

| Alternative | Pros | Cons / why not chosen |
|---|---|---|
| **More failure signals**, e.g. `portal_pause_active` | Answers "are we paused right now?" | Beyond what the README asks for; a next step |
| **Five metrics only, no failed-days gauge** | Exactly the README list | Days that stay failed become invisible to metrics after the moment of the `400`/`404` |
| **`accommodationId` label on metrics** | Per-accommodation graphs | One time series per accommodation; the detail is already in logs and `sync-status` |

---

## 14. Configuration

**Decision.** All settings come from environment variables, validated with Zod at startup, with defaults that work with the provided `docker-compose.yml`. A bad value stops the service at startup with a clear message.

```ts
export const Config = z.object({
  PORTAL_URL:                     z.string().url().default('http://localhost:4000'),
  PORTAL_API_KEY:                 z.string().min(1).default('sol-demo-key'), // sent as X-Api-Key
  PORTAL_TIMEOUT_MS:              z.coerce.number().int().positive().default(5000), // probe: normal answers < 1 s, slow ones ~10 s
  PORTAL_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(25),  // probe: the portal allows 30
  SYNC_CONCURRENCY:               z.coerce.number().int().positive().default(4),
  DATABASE_URL:                   z.string().default('postgres://sync:sync@localhost:5432/sync'),
  PORT:                           z.coerce.number().int().positive().default(3000), // HTTP port of this service
});
export type Config = z.infer<typeof Config>;
```

| Variable | Default | What it is |
|---|---|---|
| `PORTAL_URL` | `http://localhost:4000` | Portal Sol base URL |
| `PORTAL_API_KEY` | `sol-demo-key` | Sent as `X-Api-Key` on every `/api/` call, added in one place (the portal client) |
| `PORTAL_TIMEOUT_MS` | `5000` | Timeout per portal call (probe: normal answers take under 1 s, slow ones about 10 s) |
| `PORTAL_MAX_REQUESTS_PER_MINUTE` | `25` | Limiter setting, just under the measured limit of 30 |
| `SYNC_CONCURRENCY` | `4` | Number of workers (section 7) |
| `DATABASE_URL` | `postgres://sync:sync@localhost:5432/sync` | PostgreSQL connection |
| `PORT` | `3000` | HTTP port of this service |

**Code constants**, not environment variables: `SYNC_POLL_INTERVAL_MS = 1000` (section 8); backoff from about 2 s, capped at 5 min (section 9); 366 days per `POST` (section 6); 31 days per `PUT` (section 7).

---

## 15. Acceptance criteria

The service is done when all of these hold. Each one names how it is checked (test numbers from section 16).

| # | Criterion | Checked by |
|---|---|---|
| AC1 | A valid `POST /updates` gets `202` with an `updateId` **only after** it is committed. An invalid one gets `400` with the `{ "error": { "code", "message" } }` shape and nothing is stored. If PostgreSQL is down, the answer is `503`. | Test 2; integration tests |
| AC2 | Updates accepted before the service is killed (`kill -9`) or restarted still reach the portal after it starts again. | Test 4 |
| AC3 | With overlapping updates, the portal ends with the **latest accepted** value on every day. | Tests 3, 7 |
| AC4 | No portal request covers more than 31 days. Longer updates are split, and neighbouring days with the same values are joined into as few requests as possible. | Tests 1, 7 (`/__admin/requests`) |
| AC5 | After a `429`, no portal call is made before `Retry-After` has passed, also across a restart. | Tests 5, 7; the restart case by hand |
| AC6 | `503`s, timeouts and network errors are retried with backoff until they succeed. No accepted update is ever dropped. | Tests 5, 6 |
| AC7 | A `PUT` that times out is sent again with the same values until it gets a clear answer, and the days end synced. (The rarer late-applied case is a known limitation, section 10.) | Test 6 |
| AC8 | A `400`/`404` marks only the affected days **failed**. Other days and accommodations keep syncing, and a new `POST` for those days re-arms them. | Test 9 |
| AC9 | `sync-status` reports the right state, counts and ranges (`pending`, `failed`, `synced`), and `404` for an id it has never seen. | Tests 8, 9 |
| AC10 | `/metrics` serves the six metrics of section 13.1 in Prometheus text format, with values that match what happened (gauges correct after a restart). | Tests 8, 9 |
| AC11 | Logs are pino JSON, and every sync line carries `accommodationId`, `from`, `to`, `attempt`, `outcome` and `durationMs` (`updateId` on intake). | By hand |
| AC12 | `service/README.md` explains how to install, start the service, run the tests, and configure the Portal Sol URL (default `http://localhost:4000`). | By hand |

---

## 16. D12 — Test plan

**Decision.** The README asks for *"a few tests that check what matters over many that check nothing"*. So each test proves one README claim, and nothing is tested for its own sake (no tests for getters, thin wrappers or Express wiring).

**What the tests run against.**

- **Real PostgreSQL** (`docker compose --profile postgres`). The key claims are database claims (survives a restart, locks), and a mocked database can't prove them.
- **A scripted fake portal** for integration tests: a tiny HTTP server inside the test run whose answers we control call by call (`503`, `429` + `Retry-After`, a response slower than the timeout, `200`). The real portal fails at random, so it can't reproduce a specific failure on demand.
- **The real Portal Sol** for one end-to-end test, with `POST /__admin/reset` before and `GET /__admin/requests` after.

| # | Test | Layer | README claim it proves |
|---|---|---|---|
| 1 | Joining days into ranges: same values, gaps, the 31-day split, a 366-day range | Unit | "Respects the portal's limits" (31 days per request) |
| 2 | Validation: bad dates, `to < from`, price with 3 decimals, over 366 days | Unit | Intake rules (section 6) |
| 3 | Overlapping updates A then B → the portal ends with B on its days and A on the rest | Integration | "Final state reflects what the manager asked for" |
| 4 | Accept updates, kill the service, restart → everything still syncs | Integration | "No accepted update is lost if the service restarts" |
| 5 | `503`s and a `429` with `Retry-After` → retries, no call before the pause ends | Integration | "No update lost even if the portal fails or throttles"; "does not overwhelm it" |
| 6 | The fake portal makes a `PUT` time out, then answers `200` on the retry → the same values are sent again, the days end `synced`, and a `timeout` outcome and a retry are counted | Integration | "No update lost even if the portal fails" (timeouts, section 10) |
| 7 | Full run against the real Portal Sol: overlapping updates, wait for "synced", compare the portal's days, check `/__admin/requests` for no call before `Retry-After` | End-to-end | Everything works against the real thing |
| 8 | Fake portal scripted with two `503`s, one `429`, then `200`s → `/metrics` shows the exact numbers (`portal_requests_total{outcome="503"} == 2`, `{outcome="429"} == 1`, `sync_retries_total{reason="503"} == 2`, the latency histogram count, `sync_pending_days == 0` at the end), and `sync-status` shows `pending` with `lastError` and `nextAttemptAt` while retrying, then `synced` | Integration | "Is observable"; evaluation: "observability that actually works" |
| 9 | Fake portal answers `404` for one accommodation → its days become `failed` with `NOT_FOUND`, a `404` outcome is counted, `sync_failed_days` equals the number of those days, and the other accommodation still syncs. A new `POST` re-arms them, they sync, and `sync_failed_days` returns to 0 | Integration | Failure handling (section 9) and "exposes the sync status" |

- Tests 8 and 9 are **separate on purpose**, rather than extra assertions inside tests 5 and 7: each test checks one thing, and its name says what broke.
- **Priority if time runs short:** tests 3–6 first (the hard claims), then 8 and 9, then 7, then 1. Test 2 goes last, because zod already covers most of it.
- **Where they run.** Unit tests need nothing. Integration and end-to-end tests need Docker: `docker compose --profile postgres up -d`, then `npm test`.

**Alternatives considered.**

| Alternative | Pros | Cons / why not chosen |
|---|---|---|
| **Real portal only** | Tests the real thing | Slow and flaky; can't choose when it fails; shares a per-minute limit |
| **Mock both the portal and the database** | Fast; no Docker | Can't prove restart safety or the locks |
| **Extend tests 5 and 7** instead of adding tests 8 and 9 | Fewer tests | Each test would check several things, and a failure wouldn't say what broke |

---

## 17. Out of scope

**Not asked for by the README:** authentication for our service, deployment, a user interface, dashboards or an alerting stack (metrics are exposed and alerts described only), 100% test coverage.

**Left out on purpose (possible next steps):**

| Item | Why it's left out |
|---|---|
| Several service instances (shared rate limiter in PostgreSQL or Redis) | Single instance assumed (section 11) |
| Check-and-fix for a timed-out request applied late, after a newer one | Designed in section 10.2, not built: the most complex part for a rare case, beyond the 3–4 h budget |
| Periodic background check of all accommodations against the portal | Would also catch changes made outside our service, but uses quota all the time |
| History of every portal attempt in the database (e.g. a `sync_attempts` table) | Useful for statistics and support. Today each attempt is in the logs and counted in the metrics, but it can't be queried per accommodation |
| Extra metrics such as `portal_pause_active` | Beyond the README's metric list (section 13) |
| Separate API and worker processes; `LISTEN/NOTIFY` instead of polling | More moving parts than one instance needs (section 8) |
| Per-update delivery tracking (`source_update_id` per day) | The README asks for status per accommodation (section 4) |
| Rejecting unknown accommodation ids on intake | Would need the portal or a cached list; a stale list could lose a good update (section 6) |

---

## 18. Open questions

To measure with a probe against Portal Sol before fixing the defaults:

- The requests-per-minute limit and typical `Retry-After` values → `PORTAL_MAX_REQUESTS_PER_MINUTE`.
- Whether the window resets on the minute or slides, and whether rejected requests count toward the limit.
- How slow the "slow" responses are → `PORTAL_TIMEOUT_MS`.
- Whether a request we time out on (`clientDisconnected: true` in `/__admin/requests`) still changes the data afterwards, and how late. This shows how real the known limitation in section 10 is.
- What the portal answers for dates outside its ~90 days of data (past dates, or more than 90 days ahead). It could change the intake rules in section 6.
