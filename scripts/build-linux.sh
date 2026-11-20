#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) arch=x64; target=bun-linux-x64-baseline ;;
  Linux-aarch64) arch=arm64; target=bun-linux-arm64 ;;
  *) echo "Expected Linux x86_64 or aarch64" >&2; exit 1 ;;
esac

mkdir -p dist
stage=$(mktemp -d dist/.build-XXXXXX)
trap 'rm -rf "$stage"' EXIT
./scripts/stage-release.sh "$stage/pi-stick"
bun build --compile --target="$target" --define PI_STICK_COMPILED=true \
  --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
  src/cli.ts --outfile "$stage/pi-stick/pistick"
archive="pi-stick-linux-$arch.tar.gz"
tar -czf "$stage/$archive" -C "$stage" pi-stick
mv "$stage/$archive" dist/
echo "Built dist/$archive"
