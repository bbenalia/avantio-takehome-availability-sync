# CLAUDE.md — working rules for this repo

This is an Avantio take-home exercise. Read these files before doing anything:

- `README.md` — the brief from Avantio. It is the final word on what is asked.
- `SPEC.md` — the agreed design. **It is the source of truth for every implementation decision.** Section 2 lists every decision and where it is described.
- `API.md` — Portal Sol's API. We don't have its code; treat it as a real external portal.
- `docs/process-notes.md` — the log of how the human and the AI worked together. It feeds `PROCESS.md`.

## Ground rules

1. **Follow `SPEC.md`. Don't change the design on your own.** If something in the spec looks wrong, unclear or missing, **stop and say so**, and propose the change. Spec changes are approved by the user and go in their own commit.
2. **Stay in scope.** Build only what the spec describes. SPEC §17 (Out of scope) lists what is left out on purpose. Don't add features, endpoints, metrics, config options or libraries that aren't in the spec without asking.
3. **Keep it simple and explainable.** The user must be able to explain and extend every line in a live session. Prefer plain, boring code over clever code. Comment only *why* something non-obvious is done, never *what*.
4. **Never commit or push unless the user asks.** When asked to commit, make small commits with a prefix (`test:`, `feat:`, `fix:`, `docs:`, `chore:`) and a message that names the slice.
5. **Never weaken, skip or delete a test to make it pass.** If a test looks wrong, stop and say so.

## Code layout

The stack is in SPEC §5, and configuration and code constants are in SPEC §14. This section only adds where things go:

- Node.js 24, TypeScript in strict mode, ES modules. All code lives in `service/`.
- Migrations: plain `.sql` files in `service/migrations/`, run in filename order at startup.
- Tests: `service/test/` (`unit/`, `integration/`, `e2e/`). The scripted fake portal lives in `service/test/support/`.

## Running things

Integration and end-to-end tests need Docker running. If they fail with a connection error, check Docker first; don't change the code.

## How we work: one slice at a time, test first

The slices and their order are listed in the plan the user follows (probe, scaffold, migrations, intake, ranges, portal client, fake portal, worker, status, metrics, shutdown, end-to-end, README). For each slice:

1. **Red.** The **main Claude Code session** (not an agent) drafts the slice's tests from SPEC §16 (test plan) and §15 (acceptance criteria), runs them and confirms they **fail for the right reason**. The **user reviews every test** ("if the code were wrong, would this test fail?"), fixes or asks for changes, and commits them (`test: ... (red)`). The tests define "done", so nothing moves to green until the user has approved them.
2. **Green.** The `implementer` agent writes the code until the tests pass. It **must not change any file under `service/test/`**.
3. **Review.** The `reviewer` agent checks the diff against `SPEC.md` and reports. It doesn't edit anything.
4. **Decide.** The user reads the report and the diff, accepts or sends it back, and commits (`feat: ... (green)`).

Slices without anything to test-drive (probe, scaffold, migrations, shutdown) are done in a normal session, without the red/green steps. The scripted fake portal (`service/test/support/`) is also written in a normal session, reviewed by the user, and from then on treated like a test file: the implementer never changes it.

## Process notes

When the AI gets something wrong, proposes something the user rejects, or the user writes something by hand, add a short factual line to `docs/process-notes.md` under the right section. Don't rewrite past entries.
