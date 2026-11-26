#!/usr/bin/env bash
# Exercise the release installer without a checkout, network, or Docker daemon.
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
export HOME="$tmp/home" PATH="$tmp/bin:$PATH" LC_ALL=C
unset PI_STICK_HOME
mkdir -p "$HOME" "$tmp/bin"
cp scripts/install.sh "$tmp/install.sh"
./scripts/stage-release.sh "$tmp/pi-stick"
printf '#!/bin/sh\nif [ "$*" = "containers status" ]; then test -f "$HOME/current"; exit $?; fi\necho "v1 $*" >> "$HOME/cli.log"\n' > "$tmp/pi-stick/pistick"
chmod +x "$tmp/pi-stick/pistick"
export ARCHIVE="$tmp/release.tar.gz"
printf '#!/usr/bin/env bash\ncp "$ARCHIVE" "${!#}"\n' > "$tmp/bin/curl"
chmod +x "$tmp/bin/curl"
pack() { tar czf "$ARCHIVE" -C "$tmp" pi-stick; }
install_with() { printf '%b' "$1" | "$tmp/install.sh" > "$tmp/log" 2>&1; }
app="$HOME/custom install"
pack
install_with "$app\nn\n"
cmp "$tmp/pi-stick/share/package-lock.json" "$app/share/package-lock.json"
cmp skills/pi-stick/SKILL.md "$app/share/skills/pi-stick/SKILL.md"
cmp skills/pi-stick/project-create/SKILL.md "$app/share/skills/pi-stick/project-create/SKILL.md"
test ! -e "$app/Dockerfile"
printf '{"default_model":"test/model"}\n' > "$app/settings.json"
test ! -e "$HOME/cli.log"
for dir in state actions projects; do touch "$app/$dir/keep"; done
install_with '\nn\n'
grep -F 'Installed files are unchanged.' "$tmp/log"
printf 'release v2\n' >> "$tmp/pi-stick/share/Dockerfile"
printf '{"version":"v2"}\n' > "$tmp/pi-stick/share/package-lock.json"
sed -i s/v1/v2/ "$tmp/pi-stick/pistick"
touch "$app/share/runtime/obsolete.ts"
pack
install_with '\nn\n'
grep -F 'Installation unchanged.' "$tmp/log"
grep -F 'v1' "$app/pistick"
test -e "$app/share/runtime/obsolete.ts"
if cmp -s "$app/share/package-lock.json" "$tmp/pi-stick/share/package-lock.json"; then exit 1; fi
mkdir "$app/state/runs/active"
flock "$app/state/runs/active/lock" bash -c 'if printf "\n\ny\n" | "$1"; then exit 1; fi' _ "$tmp/install.sh"
install_with '\n\ny\n'
cmp "$app/pistick" "$tmp/pi-stick/pistick"
cmp "$app/share/Dockerfile" "$tmp/pi-stick/share/Dockerfile"
cmp "$app/share/package-lock.json" "$tmp/pi-stick/share/package-lock.json"
test ! -e "$app/share/runtime/obsolete.ts"
grep -Fx '{"default_model":"test/model"}' "$app/settings.json"
for dir in state actions projects; do test -f "$app/$dir/keep"; done
diff -u <(printf 'v2 containers build\nv2 doctor\n') "$HOME/cli.log"
touch "$HOME/current"
install_with '\n'
test "$(wc -l < "$HOME/cli.log")" = 2
rm "$tmp/pi-stick/share/package-lock.json"
pack
if install_with '\n\nn\n'; then exit 1; fi
grep -F 'Missing release file: package-lock.json' "$tmp/log"
grep -F v2 "$app/share/package-lock.json"
