#!/usr/bin/env bash
# Smoke-test the installer against the latest published release.
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
export HOME="$tmp"
unset PI_STICK_HOME
app="$HOME/pi-stick"
mkdir -p "$HOME/.local/bin"
ln -s "$app/pi-stick" "$HOME/.local/bin/pi-stick"
export PATH="$HOME/.local/bin:$PATH"
printf '%s\n' '#!/usr/bin/env bash' 'echo "$PWD: $*" >> "$HOME/docker.log"' '[[ $1 == compose ]]' > "$HOME/.local/bin/docker"
chmod +x "$HOME/.local/bin/docker"
printf '\nn\n' | ./scripts/install.sh
test ! -e "$HOME/docker.log"
"$HOME/.local/bin/pi-stick" cleanup --dry-run
test -f "$app/state/lock"
test -f "$app/project-template/.dockerignore"
test -f "$app/.dockerignore"
if printf '%s\n' "$app" | ./scripts/install.sh; then exit 1; fi

# Default yes starts Compose; doctor must report the missing reviewer and fail the install.
export HOME="$tmp/second"
if printf '\n\n' | ./scripts/install.sh > "$tmp/output"; then exit 1; fi
grep -Fx "$HOME/pi-stick: compose up -d --build --wait" "$HOME/docker.log"
grep -F 'FAIL Reviewer identity' "$tmp/output"
