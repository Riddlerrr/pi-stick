#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1/share"
cp -R project-template compose.yaml Dockerfile .dockerignore package.json package-lock.json \
  reviewer.ts review-method.md "$1/share/"
cp README.md CHANGELOG.md "$1/"
