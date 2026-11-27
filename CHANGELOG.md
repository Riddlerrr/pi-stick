# Changelog

## Unreleased

- Customize agent guidance with `SYSTEM.md` and `APPEND_SYSTEM.md` in the pi-stick home. New runs snapshot the text for every agent. Rebuild the agent image once after upgrading for the new run protocol; later prompt edits need no rebuild.

## 0.3.1 — 2026-11-26

- Codemode gets structured results from `find` and `grep`; direct model calls still get text. `find.query` is a literal path substring and `grep` no longer takes an offset. Narrow truncated searches instead of paging.

- `pistick resume` restores interrupted delegations instead of abandoning the batch. In both stages and delegations, workers that finished keep their answers; a worker whose request already failed before interruption gets a new attempt in the same conversation.

- `pistick follow` reports model retry waits and context compaction. Failed submissions report a reason such as `turn_limit` without exposing raw provider errors.

- A report writer that returns no text gets one reminder in the same conversation. A read-only orchestrator without delegation warns if tracked-file status changes during its turn.

- Runs can be inspected and stopped even if their original project directory is no longer present. Tool images are fitted before entering the model transcript.

Rebuild the agent image with `pistick containers build` and start new runs; existing sessions are not migrated.

## 0.3.0 — 2026-11-25

- Use `pistick projects` to list workspaces and `pistick show RUN_ID` to inspect the current phase, session usage and latest published report. Public run commands accept an unambiguous prefix of at least eight lowercase hex digits.

- Each `continue` preserves earlier reports and subagent outputs in `turns/<n>/`; `resume` stays in the same turn. The top-level `report.md` and `outputs/` point to the latest published result.

- Runs pin the entire action directory. Hooks can use sibling scripts and templates even after the original action is changed or removed. Symlinks and special files in actions are rejected. Nested prepared context files are listed by relative path.

- Actions can pass all earlier stage results with `stageContext: all`, configure per-agent thinking levels, or use a single final-stage agent's answer as the report without an orchestrator.

- The agent-facing `exec` tool is now `bash`: update explicit tool lists and prompts. Bash can target permitted Compose services, supports timeouts, and spills long output to scratch. `grep` and `find` are opt-in.

- Dev installs use atomic, owner-only settings files. `--fresh` refuses to wipe unknown task stacks rather than guessing their Compose project names.

- Updated `pi-durable` and its companion Pi runtime packages to `1.6.1`. Rebuild the agent image with `pistick containers build` to use the upgrade.

- The Linux installer now takes the CLI and runtime from the same release archive. Upgrades no longer mix release files with the local checkout or allow per-file selection.

- Run recovery now uses one versioned `run.json` checkpoint. A follow-up is accepted atomically, and a failed final Compose stop can be retried without restarting the stack. Start a new run for tasks created with the previous format; their files are not migrated or deleted.

- The agent mounts the task workspace rather than the nested checkout path and rejects a missing or symlinked checkout at startup. Rebuild the agent image to enable the startup check. The checkout path remains `/workspace/repo`.

- Added `pistick kill RUN_ID` to interrupt an active task while preserving its workspace and session for inspection or resume.

- Moved `pistick stop` and `pistick update` to `pistick containers stop` and `pistick containers build`. The build uses the shipped lockfile without updating dependencies or changing installed files. `containers status`, `doctor`, and the installers check the image’s build-input fingerprint to detect when a rebuild is needed. The old commands are no longer accepted.

- Agent file tools and runner `exec` now share the checkout path `/workspace/repo`. Rebuild locally built agent images and update any custom agent instructions that use absolute `/workspace/<file>` paths. Repo-relative paths are unchanged.

## 0.2.0 — 2026-11-21

Platform pivot to an action-agnostic, multi-agent isolated Docker workspace runner:

- Renamed the CLI command to `pistick` (and dev wrapper to `pistick-dev`) while keeping the `pi-stick` package name.
- Replaced hardcoded PR-review commands (`pull`, `review`, `review-method.md`) with a user-extensible actions system (`action.json` + Markdown rules + trusted host `prepare`/`after` hooks).
- Replaced the persistent agent container with hardened ephemeral per-task agent containers (`docker run --rm --read-only --cap-drop ALL`) attached to each task's Docker Compose network with scoped `/workspace`, `/scratch`, `/context:ro`, and `/sessions` mounts.
- Added per-task isolated checkouts, per-run locking for concurrent tasks, automatic `compose stop` on completion (`--keep-up` to leave running), `changes.patch` capture, and task lifecycle commands: `create action`, `actions`, `run`, `runs`, `follow`, `resume`, `continue`, `stop`, and `diff`.
- Added native in-container file tools (`read`, `write`, `edit`, `grep`, `find`), multiplexed host-brokered Compose tools (`exec`, `logs`, `ps`, `restart`), and multi-provider model resolution via local Pi (`pi auth`).
- Added multi-agent orchestration supporting both static parallel fan-out `stages` and dynamic orchestrator `delegate`, with per-agent tool/service permissions, isolated `/scratch/<agent-name>` directories for `read-only` agents, and post-round repository cleanliness checks.
- Added isolated dev mode (`./pistick-dev`, `--dev`, `PI_STICK_DEV=1`, or uncompiled `./pistick` without `PI_STICK_HOME`) backed by `~/pi-stick-dev` and `pi-stick:dev`.
- Added interactive Linux installer (`scripts/install.sh`) and npm package distribution (`npm run pack:npm`).
- Updated `@earendil-works/*` agent runtime dependencies to `1.6.0`.

## 0.1.0 — 2026-11-19

Initial release of pi-stick for Linux.

- `create project` clones a repository into a local Docker workspace.
- `pull` prepares a GitHub pull request for review without calling a model.
- `review` runs a private PR review. Use `--follow` to reconnect or `--resume` to continue an interrupted, prepared run.
- `cleanup` removes inactive review stacks and reports after confirmation; use `--dry-run` to preview.
- `doctor` checks the reviewer environment, and `update` upgrades the reviewer dependencies and image.
- Standalone Linux x64 and arm64 archives support mise. Set `PI_STICK_HOME` to keep projects and review state outside the versioned install.
