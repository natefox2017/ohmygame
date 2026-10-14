# Repository instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, verification, formatting, and
the contribution workflow. [docs/README.md](docs/README.md) maps modules to
their code, documentation, and tests.

## Git

- Prefer small PRs focused on one feature, one bug fix, one chore, or one refactor.
- Use branches:
  - `feat/<short-name>`
  - `fix/<short-name>`
  - `chore/<short-name>`
  - `refactor/<short-name>`
  - `docs/<short-name>`
- Use Conventional Commit style for PR titles:
  - `feat(editor): add marquee selection`
  - `fix(runtime): handle missing tween state`
  - `docs(agents): update collaboration rules`
- PR descriptions must include:
  - What changed
  - Why it changed
  - How it was checked

## Authority and scope

- Work in `natefox2017/ohmygame` (`main`). `WhiteTowerAI/ohmygame` is upstream, not the delivery repository; its issues and roadmap do not automatically authorize changes in this fork.
- Before editing, inspect current code, this file and any applicable nested `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, relevant approved requirements and existing tests. Do not infer approval or design decisions from chat history alone.
- Reuse existing implementations and dependencies; preserve unrelated edits and keep changes within the approved request or a demonstrated bug. Avoid unrelated refactors, features and invented technical standards.

## Tasks and coordination

- For work tracked here, use the existing GitHub Issue forms and status labels documented in `.github/LABELS.md`. Check actual issues, owners, branches and PRs first; do not create a parallel board, speculative backlog items or task-tracking Markdown. If a different tracker is expressly adopted, use its live records without duplicating them.
- A substantive tracked task must be independently executable without chat history: project and approval/requirement or evidenced bug (actual versus expected), verified baseline/commit, affected real paths/interfaces, goal and exclusions, dependencies and related work, one owner, objective `AC-...` IDs, finite `T-...` IDs with environment/steps and PASS criteria, required QA/review, and Done conditions.
- Confirm an eligible task's owner, state and blockers before taking it; coordinate shared files and branches to prevent duplicate work. Record handoffs, blockers and completion in the original tracked task.

## Development and verification

- Follow existing implementation and test conventions. `CONTRIBUTING.md` requests `bun run test`, `bun run typecheck`, `bun run build` and `bun run test:node-runtime` before a PR. Add or update `test/` coverage for changed behavior; include a screenshot or recording for UI changes. Follow its existing formatting instructions.
- Define a finite verification set from the approved acceptance criteria and all existing mandatory checks; do not grow it speculatively. Record the exact command/case, environment, tested commit SHA, and `PASS`, `FAIL` or `NOT RUN`. Green CI or tests from an earlier SHA are not proof of the change's acceptance.
- Fix in-scope failures, preserve evidence of unrelated baseline failures, and state unavailable-environment blockers. Do not repeat unchanged failing checks indefinitely; allow at most one justified transient-infrastructure retry.

## QA, PR, CI and delivery

- Arrange independent QA only if the approved task or existing policy requires it. Separate execution cannot be replaced with developer notes unless evidence reuse is explicitly authorized and matches the tested SHA, cases, fixtures and environment.
- `.github/workflows/ci.yml` runs on PRs and pushes to `main`; preserve its checks and verify live review/branch rules before merging rather than assuming branch protection is enabled. CI does not replace task-specific acceptance or QA.
- `.github/workflows/sync-upstream.yml` keeps `WhiteTowerAI/ohmygame` upstream synchronized every three hours using a tested non-force merge; it is not blanket permission for direct pushes or skipped review.
- Example games live upstream at `WhiteTowerAI/ohmygame-examples` and are intentionally pinned only by `config/examples.json`, not checked into this repository. `.github/workflows/sync-examples.yml` verifies example-pin PRs and checks for updates daily; it may advance only that pin on `main` after `bun run prepare:examples --require`, all existing typecheck/test/runtime checks and a complete build pass. Both synchronization jobs must not overwrite concurrent main changes. Desktop installer releases are paused: `.github/workflows/release-desktop.yml` is manual-dispatch only, and its Windows/macOS packaging jobs remain disabled. No tag push starts packaging or publication. Preserve release scripts and signing configuration for later re-enablement; do not initiate a release without explicit authorization.
- Use the existing PR conventions above. Never weaken mandatory checks, force-push over others, or enable privileged auto-merge/deployment. Declare Done only when acceptance, required tests, QA/reviews and authorized delivery have been verified; link real PR/commit evidence and update the original task where one exists.
- The repository owner has explicitly authorized independent PR merges without asking for per-merge confirmation (2026-10-13). Once applicable acceptance and mandatory checks/reviews have passed and GitHub reports no merge blocker, merge the PR yourself (prefer a squash merge for focused changes), confirm the resulting commit and update the tracked issue. Do not leave a ready PR waiting only for owner approval. This never authorizes bypassing branch protection, required review, security checks, or unresolved data-loss concerns.
- If manual desktop or external-service QA cannot run, record the exact missing environment as NOT RUN and keep any safety-critical or destructive change in draft until its known blockers are resolved. Post-merge issues reported by the owner are handled as focused bug fixes rather than holding otherwise verified routine changes for new confirmation.
- Keep enduring requirements and architecture in their existing documents; do not create separate `TODO.md`, `STATUS.md`, `BUGS.md`, QA logs or duplicate task records.
