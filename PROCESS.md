# PROCESS

I worked with Claude (chat for planning, Claude Code for the build). The full running log is in [`docs/process-notes.md`](docs/process-notes.md).

## What I delegated and what I did by hand

- **Delegated:** laying out the options for each decision with pros and cons, drafting `SPEC.md`, writing the tests, and writing the code. The code was written by an `implementer` agent that may not touch `service/test/`, and checked by a read-only `reviewer` agent, slice by slice.
- **By hand:** every design decision (I answered the AI's questions one at a time and overrode its recommendation on the stack, the metrics, the tests and the rate-limit scope), the scope cut, the workflow rules in `CLAUDE.md`, and the commits.
- **Why:** the design is where a wrong choice costs most, so I kept the choices. Typing the code and the first tests is mechanical once the spec is clear. In the last run I asked for one report at the end, so I did not review the tests between red and green.

## Where the AI was wrong, and how I noticed

- It said a gap in a counter was "harmless". I challenged it, and it turned out to hide a real ordering bug.
- It wrote its own recommendation into the spec before I had chosen. I caught it in review and it was reverted.
- It claimed "more workers never means more requests". I asked "are you sure?" and it was overstated.
- The first implementer said the window between the 429 check and the send could not be closed. That was wrong: with the pause kept in memory and no `await` before `fetch`, it can.
- I only asked about the time budget late. The design had grown to about 6–8 hours, so I cut the check-and-fix after timeouts.
- The implementer's code used TypeScript syntax that Node's type stripping rejects. Vitest passed, but starting the service for real failed, so I added `erasableSyntaxOnly`.
- My first end-to-end test did not retry its own call to the portal, which also fails at random. That showed up as a flaky run. Agents running tests together on one database gave false failures too.

## What I left out, and what I would do next

- Late-applied timed-out `PUT`s: the fix is designed in `SPEC.md` §10.2 but not built.
- Several service instances: the rate limiter would have to move into the database.
- A periodic check of the portal, per-attempt history in the database, extra metrics such as `portal_pause_active`, and separate API and worker processes.
- Smaller notes from the review: the worker's query for due accommodations has no `ORDER BY`, so more than 20 busy accommodations could starve some; the e2e test depends on a portal that fails at random.
