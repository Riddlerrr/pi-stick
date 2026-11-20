#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { echo "pi-stick installer: $*" >&2; exit 1; }
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) arch=x64 ;;
  Linux-aarch64) arch=arm64 ;;
  *) die "Supported platforms: Linux x86_64 and aarch64." ;;
esac

bin="$HOME/.local/bin"
launcher="$bin/pistick"
write_launcher() {
  printf '#!/usr/bin/env bash\nexport PI_STICK_HOME=%q\nexec "$PI_STICK_HOME/pistick" "$@"\n' "$1"
}
previous=''
if [[ -f $launcher && ! -L $launcher ]]; then
  # Decode backslash-escaped paths from our launcher as data; never source it.
  IFS= read -r line < <(sed -n '2p' "$launcher") || line=''
  IFS= read candidate <<< "${line#export PI_STICK_HOME=}"
  if [[ $candidate == /* ]] && cmp -s "$launcher" <(write_launcher "$candidate"); then
    previous=$candidate
  fi
fi
default=${PI_STICK_HOME:-${previous:-"$HOME/pi-stick"}}
printf 'pi-stick app directory (projects, actions and state live here) [%s]: ' "$default" >&2
IFS= read -r app || die "No input received."
app=${app:-"$default"}
[[ $app == '~/'* ]] && app="$HOME/${app:2}"
[[ $app == /* ]] || die "Enter an absolute path or ~/path."
app=$(realpath -m -- "$app")
reuse=false
if [[ -e $app ]]; then
  [[ -d $app && -f $launcher && ! -L $launcher ]] && cmp -s "$launcher" <(write_launcher "$app") ||
    die "Not a recognized installation: $app. Choose a new path."
  reuse=true
fi
if ! $reuse && [[ $app != "$previous" && ( -e $launcher || -L $launcher ) ]]; then
  [[ -L $launcher && $(readlink -- "$launcher") == "$app/pistick" ]] ||
    die "Move the existing $launcher aside first."
fi

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
asset="pi-stick-linux-$arch.tar.gz"
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
  "https://github.com/Riddlerrr/pi-stick/releases/latest/download/$asset" -o "$tmp/$asset"
tar -xzf "$tmp/$asset" -C "$tmp" --no-same-owner pi-stick/pistick
binary="$tmp/pi-stick/pistick"
[[ -f $binary && -x $binary ]] || die "Missing release binary."
(cd "$repo" && ./scripts/stage-release.sh "$tmp/checkout")
files="$tmp/checkout/share"
printf 'CLI: latest Linux release. Runtime files: %s\n' "$repo"

if $reuse; then
  [[ -d $app/state && ! -L $app/state ]] || die "Unexpected state directory."
  shopt -s nullglob
  for lockfile in "$app"/state/runs/*/lock; do
    if ! flock -n "$lockfile" true; then
      die "pi-stick has an active task run; wait for it to finish before upgrading."
    fi
  done
  shopt -u nullglob
  mv -- "$binary" "$files/pistick"
  changed=()
  shopt -s globstar dotglob
  for src in "$files"/**/*; do
    [[ -f $src ]] || continue
    rel=${src#"$files/"}
    case $rel in state|state/*|projects|projects/*|actions|actions/*) die "Unexpected release path: $rel" ;; esac
    dest="$app/$rel"
    [[ $(realpath -m -- "$dest") == "$dest" && ( ! -e $dest || -f $dest ) ]] || die "Unsafe update path: $dest"
    if [[ ! -f $dest ]]; then echo "Missing: $rel"
    elif cmp -s -- "$src" "$dest"; then continue
    else echo "Changed: $rel"; fi
    changed+=("$rel")
  done
  if ((${#changed[@]})); then
    printf 'Replace all listed files (A), skip all (s), or choose per file (p)? [A] ' >&2
    IFS= read -r choice || die 'No choice received.'
    case ${choice,,} in
      ''|a|all) ;;
      s|skip) changed=() ;;
      p|per-file)
        selected=()
        for rel in "${changed[@]}"; do
          printf 'Install new copy of %s? [y/N] ' "$rel" >&2
          IFS= read -r answer || die 'No choice received.'
          case ${answer,,} in y|yes) selected+=("$rel") ;; ''|n|no) ;; *) die 'Expected yes or no.' ;; esac
        done
        changed=("${selected[@]}") ;;
      *) die 'Expected all, skip, or per-file.' ;;
    esac
    for rel in "${changed[@]}"; do
      mkdir -p -- "$(dirname "$app/$rel")"
      mv -fT -- "$files/$rel" "$app/$rel"
    done
  else
    echo 'Installed files are unchanged.'
  fi
else
  mkdir -p -- "$(dirname "$app")" "$bin"
  mkdir -- "$app"
  cp -R -- "$files/." "$app/"
  install -m 755 -- "$binary" "$app/pistick"
  mkdir -p -- "$app/projects" "$app/actions" "$app/state/"{runs,sessions}
  write_launcher "$app" > "$tmp/launcher"
  chmod 755 "$tmp/launcher"
  mv -T -- "$tmp/launcher" "$launcher"
  printf 'Installed %s. Add %s to PATH if needed.\n' "$launcher" "$bin"
fi
while true; do
  printf 'Build the pi-stick agent Docker image and run pistick doctor? [Y/n] ' >&2
  IFS= read -r answer || die "No input received. Image not built."
  case ${answer,,} in
    ''|y|yes)
      (cd "$app" && docker build -t pi-stick:current .)
      "$launcher" doctor
      break ;;
    n|no)
      printf 'To build and check later: cd %q && docker build -t pi-stick:current . && %q doctor\n' "$app" "$launcher"
      break ;;
    *) echo "Please enter Y or N." >&2 ;;
  esac
done
