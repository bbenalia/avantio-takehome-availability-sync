# Availability sync service

Accepts availability/price updates, stores them in PostgreSQL and syncs them to Portal Sol without losing any, respecting its rate limit. The design is in [`../SPEC.md`](../SPEC.md).

Requires Node.js 24 and Docker.

## Install and start

```bash
# from the repository root: Portal Sol + PostgreSQL
docker compose --profile postgres up -d

cd service
npm install
npm start
```

The service creates its tables at startup and listens on `http://localhost:3000` (set `PORT` to change it).

```bash
curl -X POST localhost:3000/updates -H 'content-type: application/json' \
  -d '{"accommodationId":"acc-1003","from":"2026-12-01","to":"2026-12-10","available":false,"pricePerNight":120}'
curl localhost:3000/accommodations/acc-1003/sync-status
curl localhost:3000/metrics
```

## Configuration

Environment variables (SPEC §14):

| Variable | Default | |
|---|---|---|
| `PORTAL_URL` | `http://localhost:4000` | Portal Sol base URL |
| `PORTAL_API_KEY` | `sol-demo-key` | Sent as `X-Api-Key` |
| `PORTAL_TIMEOUT_MS` | `5000` | Timeout per portal call (normal answers take under 1 s, slow ones about 10 s) |
| `PORTAL_MAX_REQUESTS_PER_MINUTE` | `25` | Our limiter; the portal allows 30 |
| `SYNC_CONCURRENCY` | `4` | Number of workers |
| `DATABASE_URL` | `postgres://sync:sync@localhost:5432/sync` | PostgreSQL |
| `PORT` | `3000` | HTTP port of this service |

## Tests

```bash
docker compose --profile postgres up -d   # integration and end-to-end tests need Docker
npm test
npx tsc --noEmit
```

- `test/unit`: pure functions (ranges, validation). No Docker needed.
- `test/integration`: real PostgreSQL and a scripted fake portal (`test/support/fake-portal.ts`).
- `test/e2e`: the real Portal Sol on `localhost:4000`.

Test files share one database, so they run one after another. Don't run two test sessions at the same time.
