#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { echo "pi-stick installer: $*" >&2; exit 1; }
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) arch=x64 ;;
  Linux-aarch64) arch=arm64 ;;
  *) die "Supported platforms: Linux x86_64 and aarch64." ;;
esac

default=${PI_STICK_HOME:-"$HOME/pi-stick"}
printf 'New pi-stick app directory (projects and state live here) [%s]: ' "$default" >&2
IFS= read -r app || die "No input received."
app=${app:-"$default"}
[[ $app == '~/'* ]] && app="$HOME/${app:2}"
[[ $app == /* ]] || die "Enter an absolute path or ~/path."
app=$(realpath -m -- "$app")
[[ ! -e $app ]] || die "Directory already exists: $app. Choose a new path."

bin="$HOME/.local/bin"
launcher="$bin/pi-stick"
if [[ -e $launcher || -L $launcher ]]; then
  [[ -L $launcher && $(readlink -- "$launcher") == "$app/pi-stick" ]] ||
    die "Move the existing $launcher aside first."
fi

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
asset="pi-stick-linux-$arch.tar.gz"
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
  "https://github.com/Riddlerrr/pi-stick/releases/latest/download/$asset" -o "$tmp/$asset"
tar -xzf "$tmp/$asset" -C "$tmp" --no-same-owner
release="$tmp/pi-stick"
[[ -x "$release/pi-stick" && -d "$release/share/project-template" ]] || die "Incomplete release archive."

mkdir -p -- "$(dirname "$app")" "$bin"
mkdir -- "$app"
cp -R -- "$release/share/." "$app/"
install -m 755 -- "$release/pi-stick" "$app/pi-stick"
mkdir -p -- "$app/projects" "$app/state/"{projects,runs,sessions}
# The released binary needs PI_STICK_HOME even when invoked outside the app directory.
printf '#!/usr/bin/env bash\nexport PI_STICK_HOME=%q\nexec "$PI_STICK_HOME/pi-stick" "$@"\n' "$app" > "$tmp/launcher"
chmod 755 "$tmp/launcher"
mv -T -- "$tmp/launcher" "$launcher"
printf 'Installed %s. Add %s to PATH if needed.\n' "$launcher" "$bin"
while true; do
  printf 'Build and start the Docker reviewer, then run pi-stick doctor? [Y/n] ' >&2
  IFS= read -r answer || die "No input received. Reviewer not started."
  case ${answer,,} in
    ''|y|yes)
      (cd "$app" && docker compose up -d --build --wait)
      "$launcher" doctor
      break ;;
    n|no)
      printf 'To start and check later: cd %q && docker compose up -d --build --wait && %q doctor\n' "$app" "$launcher"
      break ;;
    *) echo "Please enter Y or N." >&2 ;;
  esac
done
