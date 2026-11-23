#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1/share"
cp -R project-template Dockerfile .dockerignore package.json package-lock.json \
  agent-runtime.ts runtime-auth.ts runtime-read.ts action.schema.json "$1/share/"
cp README.md CHANGELOG.md "$1/"
