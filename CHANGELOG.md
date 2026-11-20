# Changelog

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
