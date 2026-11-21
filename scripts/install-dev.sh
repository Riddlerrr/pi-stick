#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { echo "pi-stick dev installer: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./scripts/install-dev.sh [OPTIONS]

Prepare an isolated pi-stick dev directory for running ./pistick-dev from this checkout.

Options:
  --dir PATH     Dev directory path (default: $PI_STICK_DEV_HOME or ~/pi-stick-dev)
  --fresh        Wipe an existing recognized dev directory and recreate from scratch
  --model SPEC   Set default_model in settings.json (provider/modelId, or "" to leave unset)
  --no-build     Skip building pi-stick:dev and running ./pistick-dev doctor
  -y, --yes      Accept defaults non-interactively
  -h, --help     Show this help
EOF
}

dir_arg=''
dir_set=false
fresh=false
model_arg=''
model_set=false
no_build=false
yes=false

while (($#)); do
  case $1 in
    --dir)
      (($# >= 2)) || die "--dir requires a path."
      dir_arg=$2
      dir_set=true
      shift 2 ;;
    --dir=*)
      dir_arg=${1#--dir=}
      dir_set=true
      shift ;;
    --fresh)
      fresh=true
      shift ;;
    --model)
      (($# >= 2)) || die "--model requires a value."
      model_arg=$2
      model_set=true
      shift 2 ;;
    --model=*)
      model_arg=${1#--model=}
      model_set=true
      shift ;;
    --no-build)
      no_build=true
      shift ;;
    -y|--yes)
      yes=true
      shift ;;
    -h|--help)
      usage
      exit 0 ;;
    *)
      die "Unknown option: $1 (use --help for usage)." ;;
  esac
done

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
home_real=$(realpath -m -- "$HOME")
default_dir=${PI_STICK_DEV_HOME:-"$HOME/pi-stick-dev"}

if $dir_set; then
  dev_dir=$dir_arg
elif $yes; then
  dev_dir=$default_dir
else
  printf 'pi-stick dev directory (projects, actions, state and settings live here) [%s]: ' "$default_dir" >&2
  IFS= read -r dev_dir || die "No input received."
  dev_dir=${dev_dir:-"$default_dir"}
fi

[[ $dev_dir == '~' ]] && dev_dir=$HOME
[[ $dev_dir == '~/'* ]] && dev_dir="$HOME/${dev_dir:2}"
[[ $dev_dir == /* ]] || die "Enter an absolute path or ~/path."
dev_dir=$(realpath -m -- "$dev_dir")

# Guard against dangerous or checkout-overlapping paths.
if [[ $dev_dir == / || $dev_dir == "$home_real" || $dev_dir == "$repo" || $dev_dir == "$repo/"* || $repo == "$dev_dir/"* ]]; then
  die "Refusing to use unsafe dev directory path: $dev_dir"
fi
[[ ! -L $dev_dir ]] || die "Refusing to use symlinked dev directory: $dev_dir"

is_recognized_dev_dir() {
  local target=$1
  [[ -d $target && ! -L $target ]] || return 1
  [[ -f $target/.pi-stick-dev ]] && return 0
  local entry base count=0 known=0
  shopt -s nullglob dotglob
  for entry in "$target"/*; do
    count=$((count + 1))
    base=$(basename -- "$entry")
    case $base in
      projects|actions|state|settings.json|.pi-stick-dev) known=$((known + 1)) ;;
      *) shopt -u nullglob dotglob; return 1 ;;
    esac
  done
  shopt -u nullglob dotglob
  ((count == 0 || known > 0))
}

teardown_dev_dir() {
  local target=$1
  if [[ -e $target/state ]]; then
    [[ -d $target/state && ! -L $target/state ]] || die "Unexpected state path in $target"
  fi
  shopt -s nullglob
  local lockfile
  for lockfile in "$target"/state/runs/*/lock; do
    if ! flock -n "$lockfile" true; then
      shopt -u nullglob
      die "Dev environment has an active task run; wait for it to finish before wiping."
    fi
  done
  local rundir id compose key
  for rundir in "$target"/state/runs/*; do
    [[ -d $rundir ]] || continue
    id=$(basename -- "$rundir")
    [[ $id =~ ^[0-9a-f]{32}$ ]] || continue
    compose="$rundir/compose.yaml"
    [[ -f $compose ]] || continue
    key=$(node --input-type=module - "$rundir/meta.json" "$id" <<'JS'
import { existsSync, readFileSync } from "node:fs";
const [metaFile, id] = process.argv.slice(2);
let project = "";
if (existsSync(metaFile)) {
  try {
    const parsed = JSON.parse(readFileSync(metaFile, "utf8"));
    if (typeof parsed?.project === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(parsed.project)) {
      project = parsed.project;
    }
  } catch {}
}
const shortId = id.slice(0, 12);
console.log(project ? `pi-stick-${project}-${shortId}` : `pi-stick-run-${shortId}`);
JS
)
    printf 'Tearing down Docker Compose stack %s...\n' "$key" >&2
    docker compose -p "$key" -f "$compose" down --volumes
  done
  shopt -u nullglob
}

wiped=false
if [[ -e $dev_dir ]]; then
  is_recognized_dev_dir "$dev_dir" ||
    die "Not a recognized pi-stick dev directory: $dev_dir. Choose a new path."

  do_wipe=false
  if $fresh; then
    do_wipe=true
  elif ! $yes; then
    while true; do
      printf 'Dev directory %s already exists. Wipe and reinstall from scratch? [y/N] ' "$dev_dir" >&2
      IFS= read -r answer || die "No input received."
      case ${answer,,} in
        y|yes) do_wipe=true; break ;;
        ''|n|no) do_wipe=false; break ;;
        *) echo "Please enter y or n." >&2 ;;
      esac
    done
  fi

  if $do_wipe; then
    teardown_dev_dir "$dev_dir"
    rm -rf -- "$dev_dir"
    wiped=true
    printf 'Removed existing dev directory: %s\n' "$dev_dir"
  fi
fi

mkdir -p -- "$dev_dir/projects" "$dev_dir/actions" "$dev_dir/state/runs" "$dev_dir/state/sessions"
: > "$dev_dir/.pi-stick-dev"

# Discover suggested default_model:
# 1. Existing dev settings.json (when keeping)
# 2. Pi settings (~/.pi/agent/settings.json: defaultProvider + defaultModel)
# 3. Installed pi-stick settings (~/.config/pi-stick/settings.json: default_model)
suggestion_info=$(node --input-type=module - "$dev_dir/settings.json" "$HOME/.pi/agent/settings.json" "$HOME/.config/pi-stick/settings.json" <<'JS'
import { existsSync, readFileSync } from "node:fs";
const [devFile, piFile, prodFile] = process.argv.slice(2);
const readObj = (file) => {
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
};
const valid = (spec) => {
  if (typeof spec !== "string") return false;
  const idx = spec.indexOf("/");
  if (idx <= 0 || idx === spec.length - 1) return false;
  const provider = spec.slice(0, idx).trim();
  const modelId = spec.slice(idx + 1).trim();
  return Boolean(provider && modelId && !provider.includes(" ") && !modelId.includes("\0"));
};
const dev = readObj(devFile);
if (valid(dev?.default_model)) {
  console.log(`${dev.default_model}\texisting dev settings`);
  process.exit(0);
}
const pi = readObj(piFile);
if (pi) {
  let candidate = "";
  if (typeof pi.defaultModel === "string" && pi.defaultModel.includes("/")) {
    candidate = pi.defaultModel.trim();
  } else if (typeof pi.defaultProvider === "string" && typeof pi.defaultModel === "string") {
    candidate = `${pi.defaultProvider.trim()}/${pi.defaultModel.trim()}`;
  }
  if (valid(candidate)) {
    console.log(`${candidate}\tPi settings`);
    process.exit(0);
  }
}
const prod = readObj(prodFile);
if (valid(prod?.default_model)) {
  console.log(`${prod.default_model}\tpi-stick settings`);
  process.exit(0);
}
JS
)

suggested_model=''
suggested_source=''
if [[ -n $suggestion_info ]]; then
  IFS=$'\t' read -r suggested_model suggested_source <<< "$suggestion_info"
fi

is_valid_model() {
  node --input-type=module - "$1" <<'JS'
const spec = process.argv[2] ?? "";
const idx = spec.indexOf("/");
if (idx <= 0 || idx === spec.length - 1) process.exit(1);
const provider = spec.slice(0, idx).trim();
const modelId = spec.slice(idx + 1).trim();
if (!provider || !modelId || provider.includes(" ") || modelId.includes("\0")) process.exit(1);
JS
}

chosen_model=''
if $model_set; then
  chosen_model=$model_arg
  if [[ -n $chosen_model ]] && ! is_valid_model "$chosen_model"; then
    die "Expected model in 'provider/modelId' format, got: $chosen_model"
  fi
elif $yes; then
  chosen_model=$suggested_model
else
  while true; do
    if [[ -n $suggested_model ]]; then
      printf 'Default model (provider/modelId, or "-" to leave unset) [%s from %s]: ' "$suggested_model" "$suggested_source" >&2
    else
      printf 'Default model (provider/modelId, leave blank to skip): ' >&2
    fi
    IFS= read -r answer || die "No input received."
    if [[ -z $answer ]]; then
      chosen_model=$suggested_model
      break
    elif [[ $answer == '-' ]]; then
      chosen_model=''
      break
    elif is_valid_model "$answer"; then
      chosen_model=$answer
      break
    else
      echo "Expected model in 'provider/modelId' format (e.g. openai-codex/gpt-6.2-sol)." >&2
    fi
  done
fi

node --input-type=module - "$dev_dir/settings.json" "$chosen_model" <<'JS'
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const [file, model] = process.argv.slice(2);
let data = {};
if (existsSync(file)) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
}
if (model) data.default_model = model;
else delete data.default_model;
writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
JS

if $wiped; then
  printf 'Initialized fresh dev directory: %s\n' "$dev_dir"
else
  printf 'Prepared dev directory: %s\n' "$dev_dir"
fi
printf 'Settings: %s\n' "$dev_dir/settings.json"

default_dev_real=$(realpath -m -- "$HOME/pi-stick-dev")
if [[ $dev_dir != "$default_dev_real" ]]; then
  printf 'Note: custom dev directory selected; run with PI_STICK_DEV_HOME=%q ./pistick-dev ...\n' "$dev_dir"
fi

if ! $no_build; then
  do_build=false
  if $yes; then
    do_build=true
  else
    while true; do
      printf 'Build the pi-stick:dev Docker image and run ./pistick-dev doctor? [Y/n] ' >&2
      IFS= read -r answer || die "No input received. Image not built."
      case ${answer,,} in
        ''|y|yes) do_build=true; break ;;
        n|no) do_build=false; break ;;
        *) echo "Please enter Y or N." >&2 ;;
      esac
    done
  fi

  if $do_build; then
    (cd "$repo" && docker build -t pi-stick:dev .)
    PI_STICK_DEV_HOME="$dev_dir" "$repo/pistick-dev" doctor
  else
    if [[ $dev_dir != "$default_dev_real" ]]; then
      printf 'To build and check later: npm run build:image:dev && PI_STICK_DEV_HOME=%q ./pistick-dev doctor\n' "$dev_dir"
    else
      printf 'To build and check later: npm run build:image:dev && ./pistick-dev doctor\n'
    fi
  fi
fi
