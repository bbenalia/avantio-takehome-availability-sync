# PROCESS

I worked with Claude.

## What I delegated and what I did by hand

- **Delegated:** laying out the options for each decision with pros and cons, drafting `SPEC.md`, writing the tests, and writing the code. The code was written by an `implementer` agent that may not touch `service/test/`, and checked by a read-only `reviewer` agent, slice by slice.
- **By hand:** every design decision (I answered the AI's questions one at a time and overrode its recommendation on the stack, the metrics, the tests and the rate-limit scope), the scope cut, the workflow rules in `CLAUDE.md`, and the commits.
- **Why:** the design is where a wrong choice costs most, so I kept the choices. Typing the code and the first tests is mechanical once the spec is clear. My idea was to review the tests slice by slice, but in the end I reviewed them at the end of the process, after the code was written.

## Where the AI was wrong, and how I noticed

- It said a gap in a counter was "harmless". I challenged it ("we've lost the request"), and it turned out to hide a real ordering bug.
- It wrote its own recommendation into the spec before I had chosen. I noticed when reading the draft and had it reverted.
- It claimed "more workers never means more requests". I asked "are you sure?" and it was overstated.
- The first implementer said the window between the 429 check and the send could not be closed. The reviewer's finding made me question it, and it was wrong: with the pause kept in memory and no `await` before `fetch`, it can be closed.
- The design grew without anyone flagging the time. I asked directly whether it fit 3–4 hours, and the honest answer was 6–8, so I cut the check-and-fix after timeouts.
- The implementer used TypeScript syntax that Node's type stripping rejects. Vitest passed, but the service would not start. The main session found it only when it ran the service for real, and I read it in its report; `erasableSyntaxOnly` now makes `tsc` catch it.
- The first end-to-end test the AI wrote did not retry its own call to the portal, which fails at random, and showed up as a flaky run. Agents running tests together on one database gave false failures, and so did a service the AI left running in the background after a manual check. The main session saw failures the code could not explain and found the cause by looking at the running processes; I learned of it from its report.
- The reviewer flagged that the worker's query for due accommodations had no `ORDER BY` (the spec as I approved it did not have one). I asked to study it and fix it if it was small; the AI wrote a failing test first and then changed one query.

## What I left out, and what I would do next

Most of these are also listed in `SPEC.md` §17, with the reason for each.

- Late-applied timed-out `PUT`s: the fix is designed in `SPEC.md` §10.2 but not built. It was the most complex part for a rare case.
- Several service instances: the rate limiter and the 429 pause would have to move into the database.
- A periodic check of all accommodations against the portal (it would also catch changes made outside our service), at the cost of using quota all the time.
- A history of every portal attempt in the database, and per-update delivery tracking ("did update #42 arrive?"). Today there is only status per accommodation.
- Extra metrics such as `portal_pause_active`, plus the dashboards and alerting stack (the alerts are described in the spec, not deployed).
- Separate API and worker processes, and `LISTEN/NOTIFY` instead of polling every second.
- Rejecting unknown accommodation ids at intake, which would need a cached list from the portal.
- Authentication for our own API, deployment, and a startup check of the portal API key.
- Smaller notes from the review: the e2e test depends on a portal that fails at random, so it can still be flaky.
