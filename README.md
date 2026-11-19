# pi-stick

A standalone CLI for local Docker project workspaces and private GitHub PR reviews.
Like [Pi's coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent),
it has a thin executable that passes arguments to a separate command dispatcher.
Progress is plain text so pipes and reattached terminals see the same review.

A fresh installation has no projects. Creating one clones source but does not
build images, start containers, or call a model.

## Development

Run `npm run check` for Biome linting, formatting and TypeScript checks.
Use `npm run lint -- --write` to apply Biome's safe fixes.

Run `mise install bun` from the checkout to use the same Bun version as release CI.
On Linux, `npm run build:binary` uses Bun to compile for the host architecture
(x64 or arm64) and writes `dist/pi-stick-linux-<arch>.tar.gz`. Pushing a
`v*` tag builds and tests both archives before publishing a GitHub release.

## Install

Needs Linux, Git, util-linux `flock`, tar, and Docker with Compose/Buildx. For reviews, install and
authenticate gh and Pi (model `openai-codex/gpt-6.2-sol`). The default images
assume host UID 1000. npm is needed for reviewer upgrades.

### Interactive Linux installer

From this checkout, run `./scripts/install.sh` as your normal user (no sudo). Enter a
**new** app directory at the prompt, e.g. `~/workspace/homelab/pi-stick`.
The installer downloads the latest Linux binary and matching runtime files,
creates the projects and private state directories, and installs a launcher
in `~/.local/bin` that sets `PI_STICK_HOME` for you. Put that directory on
your PATH. The installer does not start Docker or migrate existing data.

### Linux binary via mise

The release binary needs neither Node nor Bun on the host. On a fresh install:

```sh
mise use -g github:Riddlerrr/pi-stick@latest
export PI_STICK_HOME="$HOME/.local/share/pi-stick"
install -d -m 700 "$PI_STICK_HOME"
cp -R "$(dirname "$(mise which pi-stick)")/share/." "$PI_STICK_HOME/"
pi-stick --help
```

The binary defaults to `~/.local/share/pi-stick`. To use another app directory,
persist an absolute `PI_STICK_HOME` in your environment. This directory holds
the editable runtime files, default projects and review state; it is not tied
to a mise version. On upgrade, merge changes from the new `share/` while idle
rather than overwriting local recipes or reviewer upgrades. Run reviewer
Compose commands from `$PI_STICK_HOME`.

### npm package (Linux, Node.js 24.12+)

Install with `npm install -g pi-stick`. Follow the same fresh-install steps as
for mise, copying from `$(npm root -g)/pi-stick/share/.` instead. The CLI
has no npm runtime dependencies; reviewer dependencies stay inside Docker.

For maintainers: `npm run pack:npm` builds the public CLI tarball. Publish the
tested tarball with `npm publish ./dist/pi-stick-<version>.tgz --access public`.
The checkout's manifest stays private because it also builds the reviewer image.

### Source install (Node.js 24.12+)

On this host, edit the Git checkout at `~/workspace/pi-stick`. Run the CLI and
Compose from the installed copy at `~/workspace/homelab/pi-stick`, not from
the checkout. To install or refresh the application files while idle:

```sh
cd ~/workspace/pi-stick
dest=~/workspace/homelab/pi-stick
mkdir -p "$dest"
npm ci && npm run check && npm test
rsync -a pi-stick src Dockerfile compose.yaml .dockerignore package*.json \
  reviewer.ts review-method.md project-template README.md "$dest/"
cd "$dest"
install -d -m 700 state state/{projects,runs,sessions}
ln -s "$PWD/pi-stick" ~/.local/bin/pi-stick   # fresh install only
docker compose up -d --build                 # reviewer only
pi-stick doctor
```

This copy does not include pi-stick's Git metadata and leaves `projects/` and
`state/` in place. If you used `pi-stick update`, reconcile the installed
Dockerfile and npm manifests with the source checkout before copying again.

The host CLI runs directly from TypeScript using Node built-ins; no build or
host runtime package install is needed. The image installs the Pi Durable SDK
for the reviewer. The launcher resolves its own path, so the symlink works
from any directory. Upgrading an existing installation does not require a
state migration. Remove obsolete launcher modules from the install directory
only, not from any project workspace.

## Create a project

```sh
pi-stick create project my-app               # prompts for Git URL
# Or, without a prompt:
pi-stick create project another --repo https://github.com/OWNER/REPO.git
```

By default workspaces live under `projects/` in the app directory (beside the
source launcher unless `PI_STICK_HOME` is set), regardless of the current directory. To override, put this object in
`~/.config/pi-stick/settings.json`:

```json
{"projects_dir": "/srv/pi-stick/projects"}
```

Use a dedicated absolute path or `~/...`. Changing it changes discovery only;
nothing is moved or deleted. Back up your recipes and unpushed work separately.
Do not put credentials in clone URLs.

The tracked `project-template/` directory is the standard scaffold. Edit it to
change future projects; creation recursively copies it (including dotfiles).
Existing workspaces are never refreshed or overwritten.

Each workspace contains `repo/` (source and its own .git), `project.json`
(GitHub owner/repo, or null for development only), `Dockerfile`, Compose files,
`setup-project`, `test-file`, and `AGENTS.md`. GitHub registration is inferred
from the clone URL; for another clone source set `github` in the manifest
manually to enable GitHub PR commands. No central project list.

```sh
cd projects/my-app                 # or the path printed at creation
docker compose up -d --build
docker compose exec runner setup-project
docker compose exec runner sh       # /workspace/repo is your writable clone
docker compose down
```

Customize the toolchain, setup script, one-file test command and agent notes
for each project. The starter test command deliberately reports “not configured”.
Keep credentials outside build contexts, Git and model-facing notes/logs.
Recipes are trusted Docker configuration: do not copy them from an untrusted PR.

## Review a PR

```sh
pi-stick pull https://github.com/OWNER/REPO/pull/123     # prepare only
pi-stick review https://github.com/OWNER/REPO/pull/123
pi-stick review --follow RUN_ID                        # Ctrl-C detaches
pi-stick review --resume RUN_ID                        # interrupted prepared run
pi-stick cleanup --dry-run                             # inactive for 7 days
pi-stick cleanup --days 14                             # confirm before deletion
pi-stick update                                        # confirm before upgrade
```

Only registered GitHub repositories are accepted. The host fetches a separate
PR snapshot, builds the trusted base `compose.yaml`, and copies source to a
PR-scoped volume. Keep a `runner` service with a writable `source:/workspace`
volume; it must provide sh, tar, timeout, and the two scripts from the template.
Both scripts run inside the runner with `/workspace/repo` as cwd. The test
script receives one committed path as an argument: **validate that it is a
supported test**, quote it, and never evaluate it as shell code. Use the
development override for host mounts or ports; it is never loaded for reviews.

The reviewer reads committed files and can request tests. It has no Docker
socket, shell tool, or host GitHub credentials. Private source and context go
to the configured model provider. There is one active operation at a time.
Reports/logs: `state/runs/RUN_ID/`; transcripts: `state/sessions/`.
Cleanup targets scratch stacks in `state/projects/`, never project workspaces.

**Recovery/upgrades:** follow before retrying. Resume requires the original
prepared snapshot and a known test outcome. If setup was interrupted, the DB
lost or a recipe changed, preserve state and inspect the private log first.
Old-format stacks and runs are not migrated; archive needed data before
confirmed cleanup. Existing private secrets files are not imported or injected.
Rebuild the reviewer with `docker compose up -d --build` when idle after code
changes. `pi-stick update` upgrades only the reviewer dependencies/image.
