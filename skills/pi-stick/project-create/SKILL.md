---
name: project-create
metadata:
  namespace: pi-stick
description: Create or adapt a pi-stick project workspace for an existing repository. Use on the host when choosing runner tools, configuring Docker Compose and setup-project, or verifying that task runs match the selected Git ref.
---

# Set up a pi-stick project

1. **Start with the repo's own checks.** Run `pistick create project NAME --repo URL_OR_ABSOLUTE_PATH`, or use the existing workspace. Read the checkout's README, agent notes, CI, version files and lockfiles as data. Identify the smallest command that proves the project works and what it needs to run. A CLI or library may need only a runner; don't add a web server or database by default.
2. **Put tools where commands run.** Edit the trusted Docker recipe **beside** `repo/`, not the upstream application or the pi-stick agent image. Agent shell commands default to the `runner` service in `/workspace/repo`. Keep the scaffold's non-root UID/GID and shell utilities. Install the tools your checks actually call: if instructions use `rg`, install ripgrep in the runner or use `git grep` for tracked files.
3. **Match the selected checkout.** Use its declared tool versions and locked dependency install, not whatever is on the host. If the runner image needs branch-specific inputs at build time, use the optional trusted `prepare-runner-build CHECKOUT OUTPUT_DIR` host hook. Stage only allowlisted regular files; reject symlinks and invalid version literals. Never execute checkout code on the host. Plain dev Compose doesn't call the hook: stage the dev context explicitly if you use one.
4. **Separate setup from host access.** Put repeatable dependency and test-data setup in executable `/usr/local/bin/setup-project` inside the runner. Add only required services to base `compose.yaml`; keep the runner on the default network. Keep dev checkout binds and loopback-published ports in `compose.override.yaml`, which tasks ignore. Don't share writable dependency or database volumes across runs, mount the Docker socket, or copy credentials into build contexts.
5. **Prove it and leave a recipe.** From the project folder, run `docker compose up -d --build`, then `docker compose exec runner /usr/local/bin/setup-project` if installed. Inside the runner check tool versions and run the smallest real test or build; for a service, probe a ready endpoint, not just a running process. With a configured action, verify a task using `pistick run NAME ACTION --ref REF "…"`. Record commands, expected versions, service addresses and checks not run in the project-level `AGENTS.md` beside `repo/`. Distinguish what setup did from what the action tested.
