# Changelog

## 0.1.0 — 2026-11-19

Initial release of pi-stick for Linux.

- `create project` clones a repository into a local Docker workspace.
- `pull` prepares a GitHub pull request for review without calling a model.
- `review` runs a private PR review. Use `--follow` to reconnect or `--resume` to continue an interrupted, prepared run.
- `cleanup` removes inactive review stacks and reports after confirmation; use `--dry-run` to preview.
- `doctor` checks the reviewer environment, and `update` upgrades the reviewer dependencies and image.
- Standalone Linux x64 and arm64 archives support mise. Set `PI_STICK_HOME` to keep projects and review state outside the versioned install.
