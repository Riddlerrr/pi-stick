# pi-stick

A Linux CLI platform for running independent, isolated AI tasks against local Docker project workspaces with the full project environment up and running.

- **Full local fidelity**: Every task runs against its own isolated repository copy and its own running Docker Compose stack, so agents can verify anything a developer can verify locally (tests, linters, APIs, databases, browsers, logs).
- **Container isolation**: The agent runtime runs in a hardened ephemeral container (`docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true`) attached to the task's Docker network, with scoped mounts for only that task. No Docker socket is ever mounted into any container.
- **Zero built-in actions**: `pi-stick` ships no opinionated workflows out of the box. You author your own actions—from single-agent scripts to multi-agent orchestrations with parallel subagents, per-agent models, and per-agent permissions.
- **Plain-text durable execution**: Tasks run in detached background workers backed by Pi Durable SQLite sessions. Pipes, reattached terminals, `follow`, `resume`, and `continue` all share the same plain-text stream.

## Development

- `npm run check` — Biome lint/format check (warnings are errors) and `tsc --noEmit`.
- `npm run lint -- --write` — Apply safe Biome fixes.
- `npm test` — Run `node --test test/*.test.ts`. The offline runtime test needs `rg` on the development host; normal runs use the copy in the agent image.
- `npm run test:docker-recovery` — Linux integration test; run as a non-root user with Docker/Compose and build access. Builds the runtime image, interrupts an agent during a stage and a follow-up, and resumes both through the CLI. Uses a temporary project and local model endpoint, not your Pi credentials. CI runs this test on Linux x64 for pull requests targeting `main`, pushes to `main`, and `v*` release tags.
- `./scripts/install-dev.sh [--fresh] [--dir PATH] [--model PROVIDER/MODEL] [--no-build] [--yes]` — Prepare the isolated dev directory (`~/pi-stick-dev` or `$PI_STICK_DEV_HOME`), initialize `settings.json` (suggesting the default model from `~/.pi/agent/settings.json` if set), optionally wipe and recreate an existing dev folder from scratch (tearing down its task Docker stacks first), and offer to build `pi-stick:dev` and run `./pistick-dev doctor`. Before using `--fresh`, stop launching runs. The installer refuses a symlinked dev directory, an active run lock, or a task stack without a supported `run.json`; it does not guess Compose project names from legacy state.
- `npm run update:runtime-deps` — Maintainers only: refresh the digest of the current Node image tag, the image’s npm pin, and direct runtime dependencies. Requires npm, registry access, and non-root Docker/Buildx access. Before writing the updated pins it builds a temporary candidate and runs the offline Git and agent RPC checks. Build or probe failure leaves the checkout unchanged. Review `git diff -- Dockerfile package.json package-lock.json`, then run `npm ci`, `npm run check`, `npm test`, and `npm run test:docker-recovery` before committing. It never replaces the dev or installed image tag.
- `npm run update:dev-deps` — Maintainers only: refresh all direct `devDependencies` to exact versions and update the lockfile. No Docker build or runtime upgrade. Run `npm ci`, `npm run check`, and `npm test` to verify the new toolchain.
- `npm run build:image:dev` — Build the dev agent image (`pi-stick:dev`).
- `./pistick-dev ...` (or `./pistick ...` without `PI_STICK_HOME`, `pistick --dev ...`, `PI_STICK_DEV=1`) — Run in isolated **dev mode**:
  - Data (`projects/`, `actions/`, `state/`) lives in `~/pi-stick-dev` (override with `PI_STICK_DEV_HOME`), keeping both the Git checkout and your installed `~/pi-stick` untouched.
  - Settings are read from `settings.json` in the selected dev home.
  - Templates, schema, and `Dockerfile` are read live from the checkout (`ASSETS`).
  - Uses Docker image `pi-stick:dev` (override with `PI_STICK_IMAGE`).
- `npm run build:binary` / `npm run pack:npm` — Build Linux release archive or npm package (uses Bun pinned in `mise.toml`).

## Install

Requires Linux, Git, util-linux `flock`, Docker with Compose/Buildx, and Pi (`pi auth`) for model credentials. The agent image builds from the supplied `Dockerfile` and `package-lock.json` (from the checkout in dev mode). Building does not require host npm, update dependencies, or start a container. Use `pistick doctor` to check the result.

### Interactive Linux installer

Run `./scripts/install.sh` as your normal user (no sudo). It downloads the Linux archive for your architecture and installs `pistick` and its sibling `share/` under `$PI_STICK_HOME` (default: `~/pi-stick`); it does not take runtime files from a local checkout. The launcher is `~/.local/bin/pistick`.

On upgrade, accept all listed release changes or cancel. Local edits inside `share/` are replaced; `settings.json`, `projects/`, `actions/`, and `state/` are preserved. If the image already matches the installed build inputs, no rebuild is offered. Otherwise image rebuild is a separate prompt: accept to run `pistick containers build` and `pistick doctor`, or skip to keep the previous image.

### Source install (Node.js 24.12+)

The host and agent image use a private, versioned protocol. After a protocol change, run `pistick containers build` before starting or resuming an agent; there is no compatibility mode for older images.

The host CLI runs directly from TypeScript using Node built-ins only (no host npm runtime dependencies). Dependencies for `runtime/main.ts` (`@earendil-works/*`) live inside the Docker image:

```sh
ln -s "$PWD/pistick" ~/.local/bin/pistick
pistick containers build
pistick doctor
```

## Create a project

```sh
pistick create project my-app               # prompts for Git URL or local path
pistick create project my-app --repo https://github.com/OWNER/REPO.git
```

By default workspaces live under `$PI_STICK_HOME/projects/`. To override, create `$PI_STICK_HOME/settings.json` (default: `~/pi-stick/settings.json`):

```json
{
  "projects_dir": "/srv/pi-stick/projects",
  "default_model": "openai-codex/gpt-6.2-sol"
}
```

Each project contains `repo/` (your local Git clone), `project.json`, `Dockerfile`, `compose.yaml`, `compose.override.yaml`, `setup-project`, and `AGENTS.md`.

- Edit `compose.yaml`, `Dockerfile`, and `setup-project` so `runner` and any companion services (`web`, `db`, `redis`, etc.) bring up your full local dev environment.
- `create project` records your numeric UID and GID in `services.runner.build.args` so the runner can use the private workspace and scratch directories. Custom services that access these directories should use the same IDs.
- The `bash` tool takes `command`, optional `service` (default: `runner`), and optional `timeout` in seconds (no default). It uses `/workspace/repo` in `runner` and the container’s configured working directory in other services. The target must be permitted by the agent’s `allowedServices`. Each target needs `sh`, `setsid`, `mktemp`, `mkfifo`, `cat`, and `rm`. Cancellation or timeout kills the command’s process group inside the target container. Commands use Bash when installed, otherwise `sh`. Output streams into the tool result (last 2,000 lines or 50 KiB); longer output is saved under the agent’s `/scratch` directory, up to the first 32 MiB per command. Exceeding this limit warns without stopping the command. `tools.bash({command, service, timeout})` in Codemode returns the `pi-durable` result: `output` (the same retained tail as the model), `truncated`, `exitCode`, and optional `fullOutputPath`. Use `tools.read({path: result.fullOutputPath})` to read earlier lines when a complete log is available. Above 32 MiB the warning names the partial log; `fullOutputPath` is omitted. When upgrading, replace `exec` with `bash` in action tool lists and prompts, and rebuild the agent image. Finish existing runs before upgrading; their pinned tool lists are not migrated.
- `read` uses Pi line ranges (`offset` starts at line 1; `limit` counts lines), not the character ranges used by earlier pi-stick versions. Text is capped at 2,000 lines or 50 KiB. JPEG, PNG, GIF, WebP and BMP files are returned as images, including via `tools.read()` in Codemode. Directories are no longer listed: use `bash` (`ls`) or `find` instead. Workspace, `/scratch` and `/context` path restrictions are unchanged. Rebuild the agent image before using the new contract.
- `edit` uses Pi’s `{path, edits: [{oldText, newText}]}` format, directly or via `tools.edit()` in Codemode. Every replacement must match a unique, non-overlapping block of the original file. If any block fails, none are applied. Matching and line endings follow `pi-durable`; editing a file with mixed LF and CRLF can normalize untouched lines. Successful calls include a diff in the tool result details; Codemode receives the success text. Replace old `target`/`replacement` calls in your actions and prompts; `replaceAll` is no longer supported. Read-only agents can edit only their own `/scratch/<agent>` files.
- `write({path, content})` creates parent directories and creates or replaces a UTF-8 file. The same call is available as `tools.write()` in Codemode, with the same workspace and scratch restrictions. Within one agent runtime, `write` and `edit` share Pi’s per-file queue; this does not lock out shell commands or other processes.
- Keep `runner` on the default task network so the agent can reach it. Omitting `networks` uses the default; if you list networks explicitly, include `default`. Other services may use private networks.
- Keep host bind mounts and published host ports in `compose.override.yaml` (dev-only). Tasks use only the base `compose.yaml` with isolated per-task mounts and networks.
- Document build, test, and local service URLs in `AGENTS.md`; it is automatically included in agent instructions.

For a read-only service config, use Compose `configs` in the base `compose.yaml`. For example, if your project has an `nginx.conf` next to `compose.yaml`:

```yaml
configs:
  nginx_conf:
    file: ./nginx.conf
services:
  web:
    image: nginx:alpine
    configs:
      - source: nginx_conf
        target: /etc/nginx/nginx.conf
```

Only regular files resolving inside the project folder and outside `repo/` are supported. External, inline and environment-sourced configs are not supported. Keep credentials out of these files. Compose `secrets` are not supported in the base recipe.

## Author actions

A fresh install has no actions. Create global actions (`$PI_STICK_HOME/actions/<name>/`) or project-specific actions (`projects/<project>/actions/<name>/`, which override global actions of the same name):

```sh
pistick create action my-action
pistick create action my-action --project my-app
pistick actions --project my-app
```

Each action directory contains `action.json` (validated against `action.schema.json`), Markdown instruction files, and optional trusted host hooks (`prepare`, `after`). Unknown manifest fields, duplicate stage names and undeclared `--input` keys are rejected. For enabled `bash`, `logs`, and `restart` tools, omitting `allowedServices` or specifying `["*"]` permits every project service. An explicit list restricts targets; `[]` permits none. Without a target, `bash` selects `runner`, `logs` reads only permitted services, and `restart` requires an explicit service. `ps` still lists the stack. On launch, each `allowedServices` entry must name a service in the selected project or be `*`. Action configs inside an untrusted `repo/` are never auto-loaded.

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
    "tools": ["read", "write", "edit", "codemode", "bash", "logs", "ps", "restart", "delegate"],
    "allowedServices": ["runner"]
  },
  "agents": {
    "security": {
      "description": "Audit auth, input validation, and secrets",
      "model": "anthropic/claude-sonnet-4-5",
      "instructions": "agents/security.md",
      "mode": "read-only",
      "tools": ["read", "write", "grep", "find", "codemode", "bash", "logs", "ps"],
      "allowedServices": ["runner"]
    },
    "tests": {
      "description": "Verify behavior against the running stack",
      "instructions": "agents/tests.md",
      "mode": "read-only",
      "tools": ["read", "write", "grep", "find", "codemode", "bash", "logs", "ps"],
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

- **Orchestration modes**: Static `stages` run in order. Agent names must be unique within each `stage.parallel` list and each `delegate` call, but may recur in later stages or calls. Each stage’s agents run in parallel and receive the task plus the immediately preceding stage’s results by default (`"stageContext": "previous"`). Set `"stageContext": "all"` at the top level of `action.json` to include all earlier stages’ results in order. This repeats more input tokens for each later agent. Every agent in a static stage must finish successfully before the next stage runs. On `resume`, a failed agent gets a fresh attempt; successful siblings are not rerun. Inspect any changes a failed agent made before retrying. The orchestrator receives all stage results only after the last stage succeeds. For best-effort work where the orchestrator decides how to handle errors, enable `delegate` instead.
- **Thinking level**: Set `"thinkingLevel": "high"` (for example) in `orchestrator` or `agents.<name>`. It applies to both staged and delegated work, and is pinned for `resume` and `continue`. Omit it to keep the existing default: pi-stick requests no particular reasoning effort. When set, the level must be one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and supported by the configured model catalog; the run fails before the first model request otherwise.
- **Final stage as report**: Omit `orchestrator` when the last stage has exactly one agent. Its nonempty answer becomes `report.md` without a synthesis call. `resume`, per-agent outputs, diff capture, and the `after` hook work as usual; `continue` requires an orchestrator.
- **Interrupted delegation**: `pistick resume RUN_ID` resumes the same `delegate` call. Completed workers return their saved answers without another model request; unfinished workers resume their existing conversations. Results stay in the requested order. An interrupted model request may be retried; changes made by tools are not rolled back. This requires a run started with the new runtime; rebuild the agent image before starting one.
- **Permissions & scratch isolation**: All agents in a task share the checkout at `/workspace/repo`, the same path used by `bash` in `runner`. Repo-relative paths work in file tools and in the runner’s default working directory. `read-only` agents cannot modify the checkout via file tools, but each agent gets its own writable `/scratch/<agent-name>` directory (visible in both containers) for ad-hoc test scripts and experiments. Codemode saves truncated output and images under the calling agent’s scratch directory. Repository cleanliness is checked after `read-only` rounds.
- **File search**: The native `grep` and `find` tools are off by default for all agents. To enable either one, include it in that agent’s `tools` list alongside the other tools it needs (an explicit list replaces the defaults). Both use ripgrep in the agent container. Directory searches respect `.gitignore` and skip `.git` and `node_modules`. `grep` is literal by default; `regex: true` uses ripgrep's default regex syntax, which does not support JavaScript lookaround or backreferences.
- **Trusted host hooks**: `prepare` runs on the host before starting the project stack (and can write read-only files into `$PI_STICK_CONTEXT`, mounted at `/context:ro`). `after` runs after completion with paths to the report and `changes.patch`.
- **Models & auth**: Each agent can specify any `provider/modelId` supported by local Pi. When local credential type metadata is absent, the host asks Pi with `pi auth check --json`. Credentials are exported via `pi auth print-api-key` or `pi auth print-bearer-token` and passed to the ephemeral container strictly over stdin. During a run, only providers for which Pi exported an OAuth bearer at startup can renew it.

## Run and manage tasks

```sh
pistick run my-app my-action [--ref BRANCH_OR_SHA] [--input KEY=VALUE]... [--keep-up] ["Prompt"]
pistick projects
pistick show RUN_ID
pistick runs [--all]                    # list active (or all) runs
pistick follow RUN_ID                   # stream progress (Ctrl-C detaches)
pistick continue RUN_ID "Follow-up"     # after success, start another turn in the same session & workspace
pistick resume RUN_ID                   # resume the interrupted initial turn or follow-up
pistick diff RUN_ID                     # show changes made in the task workspace
pistick kill RUN_ID                     # forcibly interrupt an active attempt
pistick containers stop RUN_ID          # stop an inactive run's project containers; keep its workspace and history
pistick cleanup [--dry-run] [--days 7]  # delete old finished or interrupted runs, including volumes & sessions
pistick doctor                          # check Docker, image self-check, auth, recipes & actions
pistick containers status               # compare installed build inputs with the image fingerprint
pistick containers build                # (re)build the configured agent image from the shipped lockfile
```

Public commands accepting `RUN_ID` also accept a unique prefix of at least eight lowercase hex digits. Ambiguous prefixes never select a run.

For `run` and `continue`, `-h` and `--help` show usage before the first prompt word and are literal text after it. Use `--` to end option parsing when the prompt itself starts with a flag: `pistick run my-app my-action -- --help`.

A new task clones the local project checkout and points its `origin` at `project.json`’s `source` before running the `prepare` hook. Use a credential helper or SSH key; source URLs with embedded credentials, a query string, or a fragment are rejected. `--ref` uses a locally available commit or branch first; only a missing ref triggers a fetch from `origin`. It does not refresh existing branches or update the shared project checkout. For manually configured projects without `project.json`, `origin` remains the local project checkout.

Each run mounts only `state/runs/<id>/session/` at `/sessions`; the orchestrator and its subagents share that SQLite database. `containers stop` preserves it and `cleanup` removes it with the run. Legacy `state/sessions/` databases are neither migrated nor used. `continue` refuses a missing session without changing the run. Before the first agent launch attempt, `resume` may initialize a session; after that attempt is recorded, a missing database is an error even if Docker never started.

`kill RUN_ID` targets only the active attempt. It forcibly terminates its detached worker process group (including ordinary host hooks), removes the run-owned agent, and stops the project stack even with `--keep-up`. The run remains interrupted: inspect partial changes with `diff` before `resume`. Killing a run does not roll back hook side effects, recall requests already accepted by a model provider, or stop processes a hook deliberately detached.

`diff`, `kill`, and `containers stop` use the saved run, not the current project directory. You can still inspect changes or stop the run’s containers after moving or deleting the project.

`containers stop` is not cancellation: it refuses while the worker holds the run lock. If the worker dies during a model request, the agent exits on stdin EOF. As a fallback, `containers stop` and `resume` remove a leftover `pi-stick-agent-RUN_ID` container only after verifying its `pi-stick.run` label under the lock. Unrelated containers are left alone.

For new runs, `resume` reuses completed static stages and their outputs, and reconnects to the same Pi Durable submissions in an interrupted stage. Resuming a follow-up never starts the initial stages. Runs created before stage checkpointing have no saved stage results.

Before the first worker starts, `run` pins the resolved action (including project overrides, agent instructions and permissions, stages, effective model IDs, and project `AGENTS.md`) and the entire action directory (regular files and directories only; symlinks and special files are rejected) in the host-only `state/runs/<id>/action-snapshot/`. `resume` and `continue` verify this snapshot before changing the turn. Missing, legacy, or corrupt snapshots require a new run; existing history is preserved. Editing an action does not revoke existing runs. Model catalogs, credentials, and the run’s service and `/context` listings remain live. The agent prompt lists regular files recursively by path relative to `/context`, without following symlinks.

Hooks execute the saved script (`$0`) with the task checkout as their working directory. `PI_STICK_ACTION_DIR` points to the saved action tree, and `PI_STICK_HOOK_SOURCE_DIR` to the script’s directory in that tree. Relative paths to helpers and templates keep working even if the original action is removed.

After Compose starts, the runner uses `/bin/sh` to check for `/usr/local/bin/setup-project`. If absent, setup is skipped; if present, it must be executable and exit successfully. The scaffold includes a no-op script; to remove it, also remove its `COPY` from the project Dockerfile. If it fails or is interrupted after it may have changed files or volumes, plain `resume` refuses to rerun it. Inspect the effects and use `pistick resume RUN_ID --retry-hook` only when repeating setup is safe. A completed setup is not repeated on resume or follow-up. After setup, `resume` uses `compose start` and fails rather than rebuilding if the existing stack cannot start. An interrupted checkout, before any hooks or agents run, is cloned again.

Host hooks may have external side effects. If a hook started but its success was not recorded, inspect the run and external state first. Use `pistick resume RUN_ID --retry-hook` only if it is safe to execute that hook again. This is not an exactly-once guarantee for commands interrupted mid-execution.

Once a task can run project code, Git inspection (including `pistick diff`) runs in the pi-stick image with a read-only workspace and no network. Rebuild the image after upgrading to a version that requires Git in the image. Trusted host hooks remain the operator’s responsibility.

The host atomically records the current turn, its next step and its outcome in `state/runs/<id>/run.json`. `resume` keeps the request ID; `continue` publishes a new request only after success. If only Compose stop failed, resume retries only the stop. Runs created before this checkpoint format cannot be resumed or continued; cleanup skips them without deleting their data.

After an agent turn succeeds or returns an error, `run.json` records the latest session-wide `usage` snapshot: token counts and costs by model (`usage.models`) and by tool reporting usage (`usage.tools`). It includes committed stage, delegation, and compaction usage. `resume` and `continue` replace the snapshot rather than adding to it. A hard stop can leave an older snapshot, or no `usage` field at all; missing data is not zero cost. These figures are not a provider invoice.

Each accepted `continue` starts a numbered turn; `resume` keeps the same number. Reports and subagent outputs are preserved in `turns/<n>/`. Top-level `report.md` and `outputs/` resolve through `latest` to the last published agent response, even if the current turn has not produced a report. If that response has no subagent outputs, the `after` hook receives no `PI_STICK_OUTPUTS_DIR`. Older run checkpoints without turn numbers cannot be resumed.

Multiple tasks can run concurrently across the same or different projects. When a run finishes, its project containers are stopped (`docker compose stop`) to free CPU/RAM while preserving workspace files, volumes, `report.md`, `outputs/*.md`, `changes.patch`, and the Pi Durable SQLite session until `pistick cleanup` (pass `--keep-up` to keep containers running).
