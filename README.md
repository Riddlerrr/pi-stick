# pi-stick

A Linux CLI platform for running independent, isolated AI tasks against local Docker project workspaces with the full project environment up and running.

- **Full local fidelity**: Every task runs against its own isolated repository copy and its own running Docker Compose stack, so agents can verify anything a developer can verify locally (tests, linters, APIs, databases, browsers, logs).
- **Container isolation**: The agent runtime runs in a hardened ephemeral container (`docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true`) attached to the task's Docker network, with scoped mounts for only that task. No Docker socket is ever mounted into any container.
- **Zero built-in actions**: `pi-stick` ships no opinionated workflows out of the box. You author your own actions—from single-agent scripts to multi-agent orchestrations with parallel subagents, per-agent models, and per-agent permissions.
- **Plain-text durable execution**: Tasks run in detached background workers backed by Pi Durable SQLite sessions. Pipes, reattached terminals, `follow`, `resume`, and `continue` all share the same plain-text stream.

## Development

- `npm run check` — Biome lint/format check (warnings are errors) and `tsc --noEmit`.
- `npm run lint -- --write` — Apply safe Biome fixes.
- `npm test` — Run `node --test test/*.test.ts`.
- `npm run build:image:dev` — Build the dev agent image (`pi-stick:dev`).
- `./pi-stick-dev ...` (or `./pi-stick ...` without `PI_STICK_HOME`, `pi-stick --dev ...`, `PI_STICK_DEV=1`) — Run in isolated **dev mode**:
  - Data (`projects/`, `actions/`, `state/`) lives in `~/pi-stick-dev` (override with `PI_STICK_DEV_HOME`), keeping both the Git checkout and your installed `~/pi-stick` untouched.
  - Settings are read from `~/pi-stick-dev/settings.json` instead of `~/.config/pi-stick/settings.json`.
  - Templates, schema, and `Dockerfile` are read live from the checkout (`ASSETS`).
  - Uses Docker image `pi-stick:dev` (override with `PI_STICK_IMAGE`).
- `npm run build:binary` / `npm run pack:npm` — Build Linux release archive or npm package (uses Bun pinned in `mise.toml`).

## Install

Requires Linux, Git, util-linux `flock`, Docker with Compose/Buildx, and Pi (`pi auth`) for model credentials. The default images assume host UID 1000. `npm` is needed for `pi-stick update`.

### Interactive Linux installer

From this checkout, run `./scripts/install.sh` as your normal user (no sudo). It installs the CLI and runtime files into `~/pi-stick` (or `$PI_STICK_HOME`), creates `projects/`, `actions/`, and `state/`, installs a launcher in `~/.local/bin/pi-stick`, and offers to build `pi-stick:current` and run `pi-stick doctor`. Projects, actions, and run state are never overwritten on upgrade.

### Source install (Node.js 24.12+)

The host CLI runs directly from TypeScript using Node built-ins only (no host npm runtime dependencies). Dependencies for `agent-runtime.ts` (`@earendil-works/*`) live inside the Docker image:

```sh
docker build -t pi-stick:current .
ln -s "$PWD/pi-stick" ~/.local/bin/pi-stick
pi-stick doctor
```

## Create a project

```sh
pi-stick create project my-app               # prompts for Git URL or local path
pi-stick create project my-app --repo https://github.com/OWNER/REPO.git
```

By default workspaces live under `$PI_STICK_HOME/projects/`. To override, create `~/.config/pi-stick/settings.json`:

```json
{
  "projects_dir": "/srv/pi-stick/projects",
  "default_model": "openai-codex/gpt-6.2-sol"
}
```

Each project contains `repo/` (your local Git clone), `project.json`, `Dockerfile`, `compose.yaml`, `compose.override.yaml`, `setup-project`, and `AGENTS.md`.

- Edit `compose.yaml`, `Dockerfile`, and `setup-project` so `runner` and any companion services (`web`, `db`, `redis`, etc.) bring up your full local dev environment.
- Keep host bind mounts and published host ports in `compose.override.yaml` (dev-only). Tasks use only the base `compose.yaml` with isolated per-task mounts and networks.
- Document build, test, and local service URLs in `AGENTS.md`; it is automatically included in agent instructions.

## Author actions

A fresh install has no actions. Create global actions (`$PI_STICK_HOME/actions/<name>/`) or project-specific actions (`projects/<project>/actions/<name>/`, which override global actions of the same name):

```sh
pi-stick create action my-action
pi-stick create action my-action --project my-app
pi-stick actions --project my-app
```

Each action directory contains `action.json` (validated against `action.schema.json`), Markdown instruction files, and optional trusted host hooks (`prepare`, `after`). Action configs inside an untrusted `repo/` are never auto-loaded.

### Multi-agent `action.json` example

```json
{
  "$schema": "../../action.schema.json",
  "name": "deep-check",
  "description": "Parallel specialist analysis followed by orchestrator synthesis",
  "model": "openai-codex/gpt-6.2-sol",
  "hooks": {
    "prepare": "hooks/prepare.sh",
    "after": "hooks/after.sh"
  },
  "orchestrator": {
    "instructions": "orchestrator.md",
    "mode": "read-write",
    "tools": ["read", "write", "edit", "grep", "find", "codemode", "exec", "logs", "ps", "restart", "delegate"],
    "allowedServices": ["runner"]
  },
  "agents": {
    "security": {
      "description": "Audit auth, input validation, and secrets",
      "model": "anthropic/claude-sonnet-4-5",
      "instructions": "agents/security.md",
      "mode": "read-only",
      "tools": ["read", "write", "grep", "find", "codemode", "exec", "logs", "ps"],
      "allowedServices": ["runner"]
    },
    "tests": {
      "description": "Verify behavior against the running stack",
      "instructions": "agents/tests.md",
      "mode": "read-only",
      "tools": ["read", "write", "grep", "find", "codemode", "exec", "logs", "ps"],
      "allowedServices": ["runner"]
    }
  },
  "stages": [
    {
      "name": "analyze",
      "parallel": ["security", "tests"],
      "prompt": "Investigate the codebase and report verified findings."
    }
  ]
}
```

- **Orchestration modes**: Configure static `stages` (parallel fan-out feeding into `orchestrator`) and/or enable `delegate` on `orchestrator` so it can dynamically spawn subagents in parallel across multiple rounds.
- **Permissions & scratch isolation**: All agents in a task share `/workspace` and the running project stack. `read-only` agents cannot modify `/workspace` via file tools, but each agent gets its own writable `/scratch/<agent-name>` directory (visible in both the agent container and `runner`) for ad-hoc test scripts and experiments. Repository cleanliness is checked after `read-only` rounds.
- **Trusted host hooks**: `prepare` runs on the host before starting the project stack (and can write read-only files into `$PI_STICK_CONTEXT`, mounted at `/context:ro`). `after` runs after completion with paths to the report and `changes.patch`.
- **Models & auth**: Each agent can specify any `provider/modelId` supported by local Pi. Tokens are fetched dynamically via `pi auth print-bearer-token` and passed to the ephemeral container strictly over stdin.

## Run and manage tasks

```sh
pi-stick run my-app my-action [--ref BRANCH_OR_SHA] [--input KEY=VALUE]... [--keep-up] ["Prompt"]
pi-stick runs [--all]                    # list active (or all) runs
pi-stick follow RUN_ID                   # stream progress (Ctrl-C detaches)
pi-stick continue RUN_ID "Follow-up"     # send another turn in the same session & workspace
pi-stick resume RUN_ID                   # resume an interrupted or failed run
pi-stick diff RUN_ID                     # show changes made in the task workspace
pi-stick stop RUN_ID                     # stop a --keep-up task's project containers
pi-stick cleanup [--dry-run] [--days 7]  # delete old finished runs, stacks, volumes & sessions
pi-stick doctor                          # check Docker, image self-check, auth, recipes & actions
pi-stick update [--yes]                  # rebuild pi-stick:current with latest dependencies
```

Multiple tasks can run concurrently across the same or different projects. When a run finishes, its project containers are stopped (`docker compose stop`) to free CPU/RAM while preserving workspace files, volumes, `report.md`, `outputs/*.md`, `changes.patch`, and the Pi Durable SQLite session until `pi-stick cleanup` (pass `--keep-up` to keep containers running).
