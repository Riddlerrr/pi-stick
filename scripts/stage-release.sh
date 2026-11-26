#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1/share/skills"
cp -R skills/pi-stick "$1/share/skills/"
cp -R project-template Dockerfile .dockerignore package.json package-lock.json \
  runtime action.schema.json "$1/share/"
cp README.md CHANGELOG.md "$1/"
