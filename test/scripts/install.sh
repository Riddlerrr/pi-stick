#!/usr/bin/env bash
# Smoke-test the installer against the latest published release.
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
export HOME="$tmp"
app="$HOME/fresh install"
mkdir -p "$HOME/.local/bin"
ln -s "$app/pi-stick" "$HOME/.local/bin/pi-stick"
printf '%s\n' "$app" | ./scripts/install.sh
"$HOME/.local/bin/pi-stick" cleanup --dry-run
test -f "$app/state/lock"
test -f "$app/project-template/.dockerignore"
test -f "$app/.dockerignore"
if printf '%s\n' "$app" | ./scripts/install.sh; then exit 1; fi
