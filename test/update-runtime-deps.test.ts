import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("maintainer update preserves Node line, requests only runtime deps and publishes only after npm succeeds", (t) => {
	const root = fs.mkdtempSync(join(tmpdir(), "pi-stick-maintainer-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const scripts = join(root, "scripts");
	fs.mkdirSync(scripts);
	const script = join(scripts, "update-runtime-deps.mjs");
	fs.copyFileSync(join(import.meta.dirname, "../scripts/update-runtime-deps.mjs"), script);
	const original = `FROM node:24-bookworm-slim@sha256:${"a".repeat(64)}\nARG NPM_VERSION=10.0.0\n`;
	const pkg = JSON.stringify({ dependencies: { runtime: "1.0.0" }, devDependencies: { dev: "1.0.0" } });
	const read = (name: string) => fs.readFileSync(join(root, name), "utf8");
	fs.writeFileSync(join(root, "Dockerfile"), original);
	fs.writeFileSync(join(root, "package.json"), pkg);
	fs.writeFileSync(join(root, "package-lock.json"), "original lock");
	fs.writeFileSync(
		join(root, "docker"),
		`#!/bin/sh\n[ "$*" = 'buildx imagetools inspect node:24-bookworm-slim' ] || exit 2\necho 'Digest: sha256:${"b".repeat(64)}'`,
		{ mode: 0o700 },
	);
	fs.writeFileSync(
		join(root, "npm"),
		`#!/usr/bin/env node
const assert = require('node:assert/strict'), fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'view') { assert.deepEqual(args, ['view','npm@latest','version']); console.log('11.0.0'); }
else {
  assert.deepEqual(args.sort(), ['install','--package-lock-only','--save-exact','--ignore-scripts','--no-audit','--no-fund','runtime@latest'].sort());
  assert.equal(fs.readFileSync('package-lock.json','utf8'), 'original lock');
  const pkg = JSON.parse(fs.readFileSync('package.json')); pkg.dependencies.runtime = '2.0.0';
  fs.writeFileSync('package.json', JSON.stringify(pkg)); fs.writeFileSync('package-lock.json', 'updated lock');
  if (process.env.FAIL_INSTALL === '1') process.exit(1);
}`,
		{ mode: 0o700 },
	);
	const run = (fail: string) =>
		spawnSync(process.execPath, [script], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${root}:${process.env.PATH}`, FAIL_INSTALL: fail },
		});
	assert.equal(run("1").status, 1);
	assert.equal(read("package.json"), pkg);
	assert.equal(read("package-lock.json"), "original lock");
	assert.equal(read("Dockerfile"), original);
	const result = run("0");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(read("Dockerfile"), original.replace("a".repeat(64), "b".repeat(64)).replace("10.0.0", "11.0.0"));
	assert.equal(read("package-lock.json"), "updated lock");
	assert.deepEqual(JSON.parse(read("package.json")), {
		dependencies: { runtime: "2.0.0" },
		devDependencies: { dev: "1.0.0" },
	});
});
