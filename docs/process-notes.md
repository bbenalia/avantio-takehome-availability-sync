# Process notes — running log for PROCESS.md

Kept during planning so PROCESS.md is written from facts, not memory.

## How the user works with the AI

Observed during planning, to describe the collaboration honestly in PROCESS.md:

- **Planning before code.** The user set the rule from the start: follow the README exactly, plan everything first, implement only after approving SPEC.md and these notes.
- **Asks for plain language and pictures.** Repeatedly asked for "easy and clear terms" and diagrams/schemas/code examples before deciding, and asked again when an explanation wasn't clear (e.g. the failed-days gap, Q16).
- **Questions every claim instead of accepting it.** Challenged statements that sounded fine but weren't exact: "a gap is harmless", "more workers never means more requests", "is 401 even possible?", "are these three columns necessary?", "why not the real portal for integration tests?". Several of these found real mistakes or simplifications.
- **Decides explicitly, one question at a time.** The AI recommends; the user chooses. When the AI recorded a recommendation as a decision before the user had chosen (Q6), the user caught it and it was reverted.
- **Uses the README as the yardstick for scope.** Rejected additions that went beyond it ("well-scoped, justified solution over an exhaustive one"), and also added things back when a real gap appeared (`sync_failed_days`).
- **Prefers clarity over cleverness.** Picked Express (familiar) over Fastify, separate tests over extra assertions in existing ones, and two clear columns over one subtle one.
- **Discuss first, change after.** For review rounds the user asks to discuss without touching the docs ("DON'T CHANGE ANYTHING YET"), then gives a numbered list of actions.
- **Wants the trail kept.** Asked for overrides, corrections and this working style to be recorded here as they happen.

## Decisions so far

| Topic | Decision | Why | Alternatives considered |
|---|---|---|---|
| Database | PostgreSQL | Real transactions; row/advisory locks are released automatically if a worker dies, so no lease timer to tune | MongoDB: the provided standalone server has no multi-document transactions, so it needs single-document tricks plus a time-based lease |
| Pending-work model | Per-day desired state: `updates` (append-only log) + `desired_days` (`version` / `synced_version`) | Always sends "what the day should be now"; no strict send order between updates; the check-and-fix after timeouts is a plain lookup; a failure only blocks those days | Ordered chunk queue (`sync_jobs`): less code, easy per-update tracking, but strict ordering and a harder check-and-fix |
| Marking days synced | After a 200, set `synced_version` to the version that was **sent**, never to the current one | A write that lands while the request is in flight keeps the day "to send" | — |
| Concurrency | Pool of workers in one process (`SYNC_CONCURRENCY`, default 4); one worker per accommodation via a **session-level advisory lock on a dedicated connection** | Frees itself if the worker dies; writes like "PUT started" commit normally while the lock is held; POSTs never blocked. All workers share one rate limiter, so more workers never take us above the limit; they only help use it fully when some calls are slow | Row lock held in an open transaction (a crash rolls back the "PUT started" record); one sequential worker with no lock (one slow call stalls everything; no protection against a second instance) |
| Process model and shutdown (Q15) | **One Node process** for API, workers and `/metrics`. Workers poll Postgres when idle, every `SYNC_POLL_INTERVAL_MS = 1000`, kept as a **code constant** (not an env var), passed as a default option so tests can use a shorter interval. `SIGTERM`: stop picking up work, let in-flight calls finish (bounded by the timeout), release locks, close the server. Hard crash: unsent days are still pending and simply sent again; proved by test 4. Shutdown later cut to a minimal version (see "Scope cut") | Single-instance scope; limiter, workers and metrics in one place. The wait only happens when idle, and the portal's rate limit is the real speed limit, so 1 s doesn't slow syncing | Separate API and worker processes (closer to production, but two entry points and two `/metrics`); Postgres `LISTEN/NOTIFY` (lower latency, but a listener connection and reconnect handling for little gain). User asked if 1 s was too much; after the explanation, kept 1 s as a constant "for now" |
| "PUT started" record and check scheduling — **superseded by the scope cut, not built** | **Two columns:** `in_flight_at` (set and committed before each PUT; tells us after a crash which days had a call running) and `check_after` (set = a check is needed at that time; `null` = no check). Set after a timeout, or when a dead worker's `in_flight_at` is found | Lets us know which days have an unknown outcome and must be verified with a GET | Earlier draft had a third column, `needs_check boolean`; dropped after the user asked whether all three were needed, because it duplicated "`check_after` is set". Going down to one column was possible but subtler, and would show "verifying" during every normal PUT |
| When to check the portal (Q6) — **superseded by the scope cut, not built** | Only after **uncertain** sends (timeout, crash mid-call), after waiting `CHECK_DELAY`. A newer successful PUT doesn't clear the check; only a matching GET does. Status shows "verifying" until then | 200/4xx/503 are definite answers; waiting lets a stuck request land first; keeps quota use low | Read back after every PUT (doubles calls, almost always finds nothing); periodic sweep of all accommodations (catches late landings and outside changes, but uses quota constantly and isn't asked for → next steps) |
| Failure handling (Q7) | 429 → global pause, not an attempt. 503/timeout/network → retry forever with capped exponential backoff (≈2 s … 5 min) + jitter. 401 → same retry, never failed, error log + metric. 400/404 → days marked failed, visible in status and in `sync_failed_days`, re-armed by a new POST. **Every error write has `AND version = $sentVersion`** (added after the implementer's finding, below) | "No update is lost even if the portal fails": never give up on errors that waiting fixes; only stop on errors that will fail every time | Cap attempts + dead-letter (a long outage turns good updates into failures needing manual replay). First proposal for 401 was a special global pause with timed retries; simplified after the user's question (see below) |
| Portal API key | `PORTAL_API_KEY`, default `sol-demo-key` (from API.md), added as `X-Api-Key` in one place, the portal client. Same pattern for `PORTAL_URL` | Works out of the box with the provided Docker setup; configurable like a real integration | — |
| `POST /updates` (Q8) | Never calls the portal. Local validation only: required fields and types, real dates, `to >= from`, price `>= 0` with ≤2 decimals, unknown fields rejected, **≤366 days per POST**. `accommodationId`: only non-empty string, max 64 chars, **no format check**. **Unknown ids accepted**; the portal's 404 marks days failed. `202` with `updateId` (for logs) after commit; `400` with the portal's error shape; `503` if Postgres is down. A duplicate POST is harmless (newest value wins), stated in 3.2 | Keeps intake working when the portal is down; accepting a non-existent id costs one 404, rejecting an existing one loses an update; 366-day cap stops one POST creating huge numbers of rows | Reject unknown ids using a cached copy of the portal's list (instant feedback, but depends on the portal, a stale list can reject a new accommodation, more code) |
| Stack (Q9) | **Express** + pino/`pino-http` + zod + `pg` with plain SQL + `.sql` migrations at startup + prom-client + native `fetch` + Vitest + npm | User knows Express; being able to explain and extend the code live matters more than saving a few lines. Plain SQL because the advisory locks and queue queries need it anyway | Fastify (my recommendation: built-in pino and schema validation, less wiring; user hasn't used it). NestJS + ORM (heavy for 3–4 h; key queries would bypass the ORM) |
| Tests (Q10, Q14) | Real Postgres + a scripted fake portal for integration; unit tests for pure logic; one end-to-end test against the real Portal Sol with `/__admin`. **9 tests**, each tied to one README claim: the original 7, plus **test 8 (metrics + sync-status with exact numbers)** and **test 9 (404 → failed → re-armed by a new POST, including `sync_failed_days`)** as **separate tests**. Priority: 3–6, then 8–9, then 7, then 1, then 2. After the scope cut, **test 6 was adapted, not removed**: a timed-out `PUT` is re-sent with the same values until a `200` | README: "a few tests that check what matters". The fake portal reproduces exact failures on demand; real Postgres is the only way to prove restart safety and locks. User chose separate tests "to keep it clear". User later asked why not use the real portal for integration tests too; kept the plan after the explanation (can't choose when it fails, flaky, shared per-minute limit; only the 404 part is predictable, and the re-arm part can't work with a made-up id) | Real portal only (slow, flaky, can't force a late write); mock portal and DB (can't prove restart or locks). For Q14: extend tests 5 and 7 with extra assertions (my recommendation); keep the list and check by hand |
| `sync-status` shape (Q12) | Summary + ranges: overall `state` (failed → verifying → pending → synced), counts per state, `oldestPendingSince`, `lastSyncedAt`, `nextAttemptAt`, `lastError`, and one `ranges` list of non-synced days grouped like PUTs, each with a `state` (and `errorCode` if failed). Never calls the portal. Unknown id → our own 404. Added `changed_at`, `synced_at`, `last_error_at`, `failed_at` columns to `desired_days` to support it | Answers "is it OK?" and "which dates, why?" in one small response; works when the portal is down | Summary only (doesn't say where); every day listed (hundreds of entries, noisy). One `ranges` list with a `state` per range rather than separate lists per state: my suggestion, shown in the example the user approved |
| Metrics and alerts (Q13, Q16) | **6 metrics: the README minimum + `sync_failed_days`.** `sync_pending_days`, `sync_oldest_pending_age_seconds`, `sync_failed_days` (all three gauges read from Postgres at scrape time), `portal_requests_total{method,outcome}`, `portal_request_duration_seconds{method}`, `sync_retries_total{reason}`. No `accommodationId` labels. 5 alerts: sync stuck (page), 401 (page), `sync_failed_days > 0` for 15 min (ticket), too many 429s (ticket), portal getting slow (ticket; user asked what it meant, kept it after the explanation) | Q13: user kept the README minimum ("no extra metrics for now"). Q16 found that with only a counter, days that **stay** failed vanish from metrics an hour after the failure, or after a restart. After the counter-vs-gauge explanation, the user added `sync_failed_days` | More failure signals (`sync_verifying_accommodations`, `portal_pause_active`, `sync_verification_mismatches_total`) → next steps. Five metrics only, relying on the 404 counter |
| Rate limit | In-memory limiter for all portal calls (`GET` and `PUT`), one call every `60 000 / PORTAL_MAX_REQUESTS_PER_MINUTE` ms, set just under the measured limit + a global pause on 429 until `Retry-After`. The pause is **checked in memory right before `fetch`, with no `await` in between**, and set in memory first on a 429; the DB copy is only for restarts (added after the implementer's finding, below). A 429 is not an attempt. **Single service instance assumed and stated in SPEC.md** | README: "we prefer a well-scoped, justified solution over an exhaustive one" | Reacting to 429s only (hits the wall repeatedly, visible in the portal log); shared rate-limit slots in Postgres (works with N instances, but beyond scope) |

## Scope cut after a time check (day 2)

- **The user asked whether the design fits the README's 3–4 hours.** The AI's honest answer: no, closer to 6–8 hours. The biggest single cost was check-and-fix after timeouts: the "PUT started" record, a delayed verification `GET`, re-sending wrong days and a "verifying" state, for a rare case, and the source of most of the implementer's race findings.
- **The user decided:**
  - **Check-and-fix is out of scope.** It stays written in SPEC §4.1 as a known limitation with the designed fix as a next step. A timeout now just re-sends the same `PUT` until there's a clear answer. The `in_flight_at` and `check_after` columns, `CHECK_DELAY_MS` and the "verifying" state are gone.
  - **Graceful shutdown is minimal:** stop the server and new work, let calls in progress finish, release locks, exit.
  - **The tests are kept, not trimmed**, because they are how the agents check their own work. Test 6 was adapted to the new timeout behaviour.
- The first implementation attempt lived in a separate worktree; the user discarded it to restart from the updated spec.
- **To stop the scope growing again, the user added a rule to the reviewer:** if it finds new work that wouldn't fit the 3–4 hour budget, it suggests moving it to SPEC §9 (out of scope) instead of asking for it to be built. **Important fixes are kept:** anything that breaks a README requirement or a spec rule (a lost update, a wrong final state, breaking the rate limit) stays blocking. The review report has a new "Suggested for out of scope" section for this.

## Findings from the implementer (first attempt) and what was done with them

1. **Error writes matched days by date only.** If the manager changed a day while a `PUT` was in progress, a late `404` would mark the *new* value failed although it was never sent, and a late `503` or timeout would delay it. **Valid; adopted:** every error write now has `AND version = $sentVersion` (SPEC §3.3, §4; reviewer rule 7).
2. **A turn taken from the limiter and then given up (because a pause started) isn't returned.** Harmless: it only makes us slightly slower, never faster. **Accepted as is.**
3. **A small window between checking the pause and sending**, so a 429 saved in that gap wasn't caught. The implementer said closing it was impossible with an HTTP call. **That conclusion was wrong:** it's only impossible when the check reads from the database. With a single process, the pause is kept in memory, set immediately on a 429, and checked synchronously right before `fetch` (no `await` in between), so nothing can run in the gap. **Adopted** (SPEC §5; reviewer rule 8).

## Small choices the AI made while writing up SPEC sections 5, 8 and 9

These were not discussed as separate questions; they follow from the decisions above but are the AI's defaults. The user approved the SPEC with them in place:

- **`Retry-After` missing or not a number → wait 60 s.** API.md always sends it on a 429, so this is only a safety default.
- **The limiter covers `GET` too** (the check-and-fix GETs), not just `PUT`s, because the portal limit counts every request.
- **AC5 "no call before `Retry-After`, also across a restart": the restart part is checked by hand**, not by an automated test.

## Where the AI was wrong or a proposal was discarded

1. **"A gap in `seq` is harmless" (MongoDB design).** I said it casually. The user challenged it ("we've lost the request"). Working through it showed (a) "accepted" must be defined as "202 only after a durable write", and (b) a real ordering bug: with "increment the counter, then insert", two concurrent requests can be inserted out of order.
2. **I first recommended the ordered queue, then switched to per-day state.** Once we agreed a check-and-fix step is needed after timeouts, per-day became simpler overall. The change of recommendation is recorded on purpose.
3. **I recommended a shared rate limiter in Postgres (option C) for multiple instances.** The user rejected it as beyond what the exercise asks, citing the README's "well-scoped, justified solution over an exhaustive one". We kept the single-instance limiter and state the assumption.
4. **I claimed "rejected requests count toward the limit."** API.md doesn't say so. To be verified with the probe before stating anything in SPEC.md.
5. **I jumped ahead to "commit SPEC.md now"** while planning was still open. The user corrected it: SPEC.md stays a working draft in the project and goes into the repo only when planning is done.
6. **I wrote my recommendation for Q6 into SPEC.md before the user had chosen.** The user's "let's move on with what you recommended" referred to Q5. The user caught it; I reverted the Q6 text, and only re-added it once the user chose option 1 explicitly.
7. **I proposed a special path for 401 (global pause + timed retries).** The user questioned whether 401 could even happen. It can only happen with a misconfigured API key, so we simplified: same retry as transient errors, never failed, plus a loud error and metric.
8. **I recommended Fastify; the user chose Express.** Reason: familiarity, so the code can be explained and extended confidently in the live session. The cost (adding pino-http and zod by hand) is small.
9. **My first test answer ("three layers") was vague about scope.** The user pointed back to the README's "a few tests that check what matters". That turned it into a fixed list of 7 tests, each mapped to one README claim, with a priority order.
10. **Earlier (round 1) I suggested `sync-status` should return 200 "in_sync" for a never-updated id.** In Q12 we settled on our own 404 instead: it's more honest ("we know nothing about it") and still distinct from the portal's NOT_FOUND, which shows as failed days.
11. **I recommended 9 metrics (README set + 4 failure signals); the user kept only the 5 the README asks for.** The alerts were rebuilt from those 5 alone.
12. **My 7-test list missed `/metrics` and the 404 → failed path** (caught by Q14). I recommended extending tests 5 and 7 with extra assertions to stay at 7 tests. The user chose **two separate tests instead, "to keep it clear"**. The list is now 9 tests.
13. **I proposed the poll interval as an env var (`SYNC_POLL_INTERVAL_MS`).** The user asked to keep it as a code constant (1 s) for now. It stays injectable as a default option so tests can shorten it.
14. **With five metrics, failed days that stay failed were invisible to metrics** (caught by Q16). My first explanation of the gap wasn't clear; the user asked for it in simpler terms. The counter-vs-gauge explanation made it clear, and the user added `sync_failed_days`.
15. **I wrote "more workers never means more requests per minute".** The user asked "are you sure?". It was overstated: more workers never take us **above** the limit, but they do increase the actual rate up to it (that's their purpose). Reworded in 3.3.
16. **The data model had a redundant column (`needs_check`).** The user asked whether `in_flight_at`, `needs_check` and `check_after` were all necessary. `needs_check` duplicated "`check_after` is set", so it was dropped and every reference in SPEC.md updated.
17. **I added low-value rows to "out of scope"** (detecting changes made directly on the portal, retention of old `updates` rows, `Idempotency-Key`). The user said they add no value. The first two were removed; the `Idempotency-Key` row was replaced by one sentence in 3.2 ("a duplicate POST is harmless: the newest value wins").

18. **The design grew beyond the README's 3–4 hour budget**, and I didn't flag it while we added pieces one by one. The user asked directly; the honest estimate was 6–8 hours, and the user cut check-and-fix (see "Scope cut").

## Questions from the user that checked the design

- *"With Postgres, can two workers handle the same accommodation and send updates out of order?"* No: only the oldest unfinished work can be picked, and it's locked. Led to stating the one-worker-per-accommodation rule explicitly.
- *"Isn't the MongoDB lease based on time a problem with slow portal calls?"* Yes. It became a main reason for choosing PostgreSQL.
- *"After reading the days to send, what if a new write updates them?"* Answered with the "mark only the version that was sent" rule.
- *"Won't 4 workers break the rate limit?"* No: workers share one limiter inside one process. The risk is several instances, which is documented as out of scope.
- *"Is 401 even possible if there's no auth?"* Our service has no auth, but Portal Sol does (`X-Api-Key`). 401 only means our config is wrong → simplified handling.
- *"How do we get the X-Api-Key?"* It's a fixed demo key in API.md; made it a config value with that default.
- *"Why accept unknown ids?"* Compared the cost of the two mistakes (one wasted 404 vs a lost update). The user agreed and asked for a minimal id check (non-empty, max length, no format), documented in the spec.
- *README: "a few tests that check what matters"* → tests cut down to a 7-item list tied to README claims.
- *"Isn't 1 s polling too much?"* The wait only happens when the worker is idle, and the portal's rate limit is the real speed limit. Kept at 1 s as a constant.
- *"I still don't understand the failed-days issue."* Re-explained with counter vs gauge → user added `sync_failed_days`.
- *"More workers never means more requests per minute: are you sure?"* → wording corrected (#15).
- *"Are these three columns necessary?"* → `needs_check` dropped (#16).
- *"What does 'portal getting slow' mean?"* Explained p95 vs the timeout as an early warning; kept.
- *"Why don't we use the real portal for integration tests as well?"* Explained; plan kept.
- *"Implement with two agents (implementer + reviewer), `/goal` and TDD?"* The user proposed it. Agreed, with guardrails: one goal per slice (never the whole project), tests committed before code, the implementer may not touch `service/test/`, the reviewer is read-only, and the user decides and commits.
- *"Why a session-level lock instead of a transaction-level one?"* A transaction-level lock ends at `COMMIT`, so it can't cover a sequence of small commits around slow portal calls; holding one transaction open instead would block a connection the whole time. Explained; kept.
- *"Failed attempts of an overwritten version are lost for ever. Isn't a history useful for statistics?"* Partly: the update is kept in `updates`, and each failure is in the logs and counted in metrics, but there is no queryable history. **The user added "history of every portal attempt" to out of scope.**
- *"Does this fit the 3–4 hours?"* → no; scope cut (#18).
- *"Who writes the tests?"* The drafts didn't say clearly. Options: main session drafts and the user reviews (A), the user writes them by hand (B), a third `test-writer` agent (C), or a mix. **The user chose A.** `CLAUDE.md` now says it explicitly.

## To verify with a probe against Portal Sol (before fixing defaults)

- Requests-per-minute limit and the typical `Retry-After` value.
- Fixed window (resets on the minute) or sliding window.
- Whether 429-rejected requests count toward the limit.
- How slow the "slow" responses are → `PORTAL_TIMEOUT_MS`.
- Whether a request we time out on (`clientDisconnected: true` in `/__admin/requests`) still changes the data afterwards, and how long after → shows how real the known limitation in SPEC §4.1 is.
- What the portal answers for dates outside its ~90 days of data (past dates, or beyond 90 days) → may change intake rules.

## Left out on purpose / next steps

- Shared rate limiter for several instances (Postgres slots or Redis).
- Periodic background check of all accommodations against the portal (catches late-landing requests after our check, and changes made outside our service).
- Check-and-fix for a timed-out request applied late, after a newer one (designed in SPEC §4.1).
- History of every portal attempt in the database (e.g. a `sync_attempts` table).
- Extra metrics such as `portal_pause_active`.
- Separate API and worker processes; `LISTEN/NOTIFY` wake-up instead of polling.
- Per-update delivery tracking (`source_update_id` on `desired_days`).
- Rejecting unknown accommodation ids at intake (would need a cached portal list).
- Dashboards and an alerting stack (not asked for).

## Delegated to the AI vs done by hand

**Planning (done, in Claude, before any code):**

- **Delegated to the AI:** reading the README/API.md/compose file; laying out the options for each decision with pros, cons and diagrams; recommending one; drafting every section of SPEC.md and keeping these notes.
- **Done by the user:** every decision (Q1–Q16) and the review of the full draft. The user overrode the AI's recommendation on the stack (Express), the metrics (README minimum, then one gauge), the tests (separate tests 8 and 9), the poll interval (code constant) and the rate-limit scope (single instance); challenged several AI claims; and in review simplified the data model and trimmed low-value out-of-scope items.

**Implementation (in Claude Code, on the user's machine):**

- **Workflow (set up before coding):** `CLAUDE.md` with the rules, plus two Claude Code agents in `.claude/agents/`: `implementer` (writes code for one slice until its tests pass, never touches tests) and `reviewer` (read-only, checks the diff against SPEC.md and reports). Per slice: red (main session drafts the tests, the user reviews and commits them) → green (`implementer`, driven by `/goal`) → review (`reviewer`) → the user decides and commits. Slices with nothing to test-drive (probe, scaffold, migrations, shutdown) are done in a normal session.
- **First attempt discarded:** after the scope cut, the user deleted the first worktree and restarted from the updated SPEC. Its useful output was the three findings above.
- _Per-slice notes to fill in._

## Practical note

The planning sandbox had no Docker, so nothing could be run against PostgreSQL or Portal Sol during planning. Implementation moves to Claude Code on the user's machine, where Docker, PostgreSQL and Portal Sol are available, so the probe and the integration/end-to-end tests can run there.
