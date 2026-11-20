#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
stage=$(mktemp -d dist/.npm-XXXXXX)
trap 'rm -rf "$stage"' EXIT
./scripts/stage-release.sh "$stage"
bun build --target=node --format=esm --define PI_STICK_COMPILED=false \
  --banner='#!/usr/bin/env node' src/cli.ts --outfile "$stage/pi-stick.js"
chmod +x "$stage/pi-stick.js"
node --input-type=module - "$stage" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const { name, version, engines, type } = JSON.parse(readFileSync("package.json"));
writeFileSync(process.argv[2] + "/package.json", JSON.stringify({
  name, version, engines, type, os: ["linux"], bin: { "pi-stick": "pi-stick.js" },
  description: "Isolated Docker project workspaces and extensible multi-agent tasks",
  repository: "github:Riddlerrr/pi-stick"
}, null, 2) + "\n");
JS
npm pack "./$stage" --pack-destination dist
