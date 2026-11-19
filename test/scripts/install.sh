#!/usr/bin/env bash
# Smoke-test the installer against the latest published release.
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
export HOME="$tmp" LC_ALL=C
unset PI_STICK_HOME
app="$HOME/custom install"
mkdir -p "$HOME/.local/bin"
ln -s "$app/pi-stick" "$HOME/.local/bin/pi-stick"
export PATH="$HOME/.local/bin:$PATH"
printf '%s\n' '#!/usr/bin/env bash' 'echo "$PWD: $*" >> "$HOME/docker.log"' '[[ $1 == compose ]]' > "$HOME/.local/bin/docker"
chmod +x "$HOME/.local/bin/docker"
printf '%s\nn\n' "$app" | ./scripts/install.sh
test ! -e "$HOME/docker.log"
"$HOME/.local/bin/pi-stick" cleanup --dry-run
test -f "$app/state/lock"
test -f "$app/project-template/.dockerignore"
test -f "$app/.dockerignore"
# Blank input rediscovers a custom directory. Identical files are not listed or rewritten.
unchanged=$(stat -c '%i:%y' "$app/pi-stick")
rerun() { printf '%b' "$1" | ./scripts/install.sh > "$tmp/log" 2>&1; }
rerun '\nn\n'
grep -F 'Release files are unchanged.' "$tmp/log"
if grep -F 'Replace all listed' "$tmp/log"; then exit 1; fi
printf 'local edit\n' > "$app/compose.yaml"
rm "$app/.dockerignore"
touch "$app/projects/keep" "$app/state/keep" "$app/keep"
rerun '\ns\nn\n'
grep -Fx 'local edit' "$app/compose.yaml"
test ! -e "$app/.dockerignore"
rerun '\np\ny\nn\nn\n'
test -f "$app/.dockerignore"
grep -Fx 'local edit' "$app/compose.yaml"
rerun '\n\nn\n'
if grep -Fx 'local edit' "$app/compose.yaml"; then exit 1; fi
test -f "$app/projects/keep"
test -f "$app/state/keep"
test -f "$app/keep"
test "$(stat -c '%i:%y' "$app/pi-stick")" = "$unchanged"
if grep -E '(Changed|Missing): pi-stick$|Install release copy of pi-stick\?' "$tmp/log"; then exit 1; fi
if rerun "$tmp\n"; then exit 1; fi

# Default yes starts Compose; doctor must report the missing reviewer and fail the install.
export HOME="$tmp/second"
if printf '\n\n' | ./scripts/install.sh > "$tmp/output"; then exit 1; fi
grep -Fx "$HOME/pi-stick: compose up -d --build --wait" "$HOME/docker.log"
grep -F 'FAIL Reviewer identity' "$tmp/output"
