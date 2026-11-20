import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import test from "node:test";
import { closed, read, runId, tryLock, writeJson } from "../src/platform.ts";
import { status } from "../src/runs.ts";
import { ephemeralArgs, parseModelSpec } from "../src/system.ts";
import { TaskEnv } from "../src/tasks.ts";

function fixture(t: TestContext) {
	const tmp = fs.mkdtempSync(join(tmpdir(), "pi-stick-test-"));
	const app = join(tmp, "install");
	const bin = join(tmp, "bin");
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	fs.mkdirSync(app);
	fs.mkdirSync(bin);
	const binary = process.env.PI_STICK_TEST_BINARY;
	if (binary) fs.cpSync(join(dirname(binary), "share"), app, { recursive: true });
	else {
		for (const name of ["src", "pi-stick", "package.json", "project-template", "agent-runtime.ts", "Dockerfile"])
			fs.cpSync(join(import.meta.dirname, "..", name), join(app, name), { recursive: true });
	}
	const cli = join(bin, "pi-stick");
	fs.symlinkSync(binary ?? join(app, "pi-stick"), cli);
	const env = {
		...process.env,
		HOME: tmp,
		PI_STICK_HOME: binary ? app : undefined,
		PATH: `${bin}:${process.env.PATH}`,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(tmp, ".gitconfig"),
	};
	const invoke = (args: string[], input?: string) =>
		spawnSync(cli, args, { env, cwd: tmp, encoding: "utf8", input, timeout: 15000 });
	const ok = (args: string[], input?: string) => {
		const r = invoke(args, input);
		assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
		return r.stdout;
	};
	const fail = (args: string[], reason: RegExp) => {
		const r = invoke(args);
		assert.equal(r.status, 1);
		assert.match(r.stderr, reason);
	};
	const source = join(tmp, "upstream");
	fs.mkdirSync(source);
	const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { env, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@local");
	fs.writeFileSync(join(source, "example.txt"), "committed\n");
	git("add", ".");
	git("commit", "-qm", "initial");
	const stub = (name: string, js: string) =>
		fs.writeFileSync(join(bin, name), `#!/usr/bin/env node\n${js}`, { mode: 0o700 });
	return { tmp, app, bin, source, ok, fail, invoke, git, stub, env };
}

test("version reports the CLI package version without creating state", (t) => {
	const { app, ok, fail } = fixture(t);
	const { version } = JSON.parse(read(join(import.meta.dirname, "..", "package.json")));
	assert.equal(ok(["version"]), `${version}\n`);
	fail(["version", "extra"], /Usage: pi-stick version/);
	assert.ok(!fs.existsSync(join(app, "state")));
});

test("create project clones independent workspaces without GitHub coupling", (t) => {
	const { app, source, tmp, ok, fail } = fixture(t);
	ok(["create", "project", "first"], `${source}\n`);
	const first = join(app, "projects/first");
	assert.equal(read(join(first, "repo/example.txt")), "committed\n");
	assert.ok(fs.statSync(join(first, "repo/.git")).isDirectory());
	assert.equal(fs.statSync(first).mode & 0o077, 0);
	fs.writeFileSync(join(first, ".dockerignore"), "local edit");
	ok(["create", "project", "second", "--repo", source]);
	assert.notEqual(read(join(app, "projects/second/.dockerignore")), "local edit");
	fail(["create", "project", "first", "--repo", source], /already exists/);
	fail(["create", "project", "../escape", "--repo", source], /project name/);
	fail(["create", "project", "missing", "--repo", join(tmp, "missing")], /git failed/);
	assert.deepEqual(fs.readdirSync(join(app, "projects")).sort(), ["first", "second"]);
});

test("settings projects_dir validation", (t) => {
	const { app, source, tmp, ok, fail } = fixture(t);
	const conf = join(tmp, ".config/pi-stick/settings.json");
	fs.mkdirSync(join(tmp, ".config/pi-stick"), { recursive: true });
	writeJson(conf, { projects_dir: "~/my projects" });
	ok(["create", "project", "demo", "--repo", source]);
	assert.ok(fs.existsSync(join(tmp, "my projects/demo/project.json")));
	for (const value of ["relative", join(app, "state/runs"), join(app, "actions"), tmp]) {
		writeJson(conf, { projects_dir: value });
		fail(["create", "project", "other", "--repo", source], /projects directory|absolute path/);
	}
});

test("TaskEnv validates base compose, materializes bind mounts, and isolates repo checkout", (t) => {
	const { app, tmp, source, git, ok } = fixture(t);
	ok(["create", "project", "demo", "--repo", source]);
	const folder = join(app, "projects/demo");
	const id = runId();
	const task = new TaskEnv(id, { name: "demo", folder, repo: join(folder, "repo") }, join(tmp, "state"));

	const dev = JSON.parse(
		execFileSync("docker", ["compose", "config", "--format", "json"], { cwd: folder, encoding: "utf8" }),
	);
	assert.equal(dev.name, "pi-dev-demo");
	assert.ok(dev.services.runner.volumes.some((m: { source: string }) => m.source === join(folder, "repo")));

	const { network, services } = task.materializeCompose();
	assert.equal(network, `${task.key}_default`);
	assert.deepEqual(services, ["runner"]);
	const mat = JSON.parse(read(task.composeFile).replaceAll("$$", "$"));
	assert.ok(
		mat.services.runner.volumes.some(
			(m: { type: string; source: string; target: string }) =>
				m.type === "bind" && m.source === task.workspace && m.target === "/workspace",
		),
	);
	assert.ok(
		mat.services.runner.volumes.some(
			(m: { type: string; source: string; target: string }) =>
				m.type === "bind" && m.source === task.scratch && m.target === "/scratch",
		),
	);
	assert.equal(mat.volumes, undefined);

	const head = git("rev-parse", "HEAD");
	const { baseHead } = task.prepareWorkspace(head);
	assert.equal(baseHead, head);
	fs.writeFileSync(join(task.repo, "example.txt"), "task edit\n");
	// Original project repo remains untouched
	assert.equal(read(join(folder, "repo/example.txt")), "committed\n");
	const { patch } = task.captureDiff(baseHead);
	assert.match(patch, /\+task edit/);
	assert.match(read(join(task.dir, "changes.patch")), /\+task edit/);

	const composePath = join(folder, "compose.yaml");
	fs.writeFileSync(composePath, read(composePath).replace("source:/workspace", "./repo:/workspace"));
	assert.throws(() => task.validateBase(), /host mounts/);
});

test("ephemeral container args enforce hardening and model spec validation", () => {
	assert.deepEqual(parseModelSpec("openai-codex/gpt-6.2-sol"), {
		provider: "openai-codex",
		modelId: "gpt-6.2-sol",
		raw: "openai-codex/gpt-6.2-sol",
	});
	assert.throws(() => parseModelSpec("no-slash"), /provider\/modelId/);
	if (process.getuid?.()) {
		const argv = ephemeralArgs({
			network: "pi-stick-demo-abc_default",
			repo: "/tmp/repo",
			scratch: "/tmp/scratch",
			context: "/tmp/context",
			sessions: "/tmp/sessions",
		});
		assert.ok(argv.includes("--rm"));
		assert.ok(argv.includes("--read-only"));
		assert.ok(argv.includes("ALL"));
		assert.ok(argv.includes("no-new-privileges:true"));
		assert.ok(argv.includes("pi-stick-demo-abc_default"));
		assert.ok(argv.includes("/tmp/repo:/workspace"));
		assert.ok(argv.includes("/tmp/scratch:/scratch"));
		assert.ok(argv.includes("/tmp/context:/context:ro"));
		assert.ok(argv.includes("/tmp/sessions:/sessions"));
	}
});

test("per-run locks allow concurrent runs, follow, diff, and selective cleanup", (t) => {
	const { app, ok, fail } = fixture(t);
	ok(["cleanup", "--dry-run"]);
	const runs = join(app, "state/runs");
	const sessions = join(app, "state/sessions");
	const idA = "a".repeat(32);
	const idB = "b".repeat(32);
	const dirA = join(runs, idA);
	const dirB = join(runs, idB);
	fs.mkdirSync(dirA, { recursive: true });
	fs.mkdirSync(dirB, { recursive: true });
	writeJson(join(dirA, "meta.json"), {
		id: idA,
		project: "demo",
		action: "check",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		status: "running",
	});
	writeJson(join(dirB, "meta.json"), {
		id: idB,
		project: "demo",
		action: "check",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		status: "done",
	});
	status(dirB, "hello\x1b[2J\r\u202e", "orchestrator");
	fs.writeFileSync(join(dirB, "exit"), "0");
	fs.writeFileSync(join(dirB, "last-used"), "");
	fs.utimesSync(join(dirB, "last-used"), 1, 1);
	fs.writeFileSync(join(sessions, `${idB}.sqlite`), "");

	const fdA = fs.openSync(join(dirA, "lock"), "a");
	try {
		assert.ok(tryLock(fdA));
		// Active run shows in `runs`, finished run also shows in `runs --all`
		const activeOut = ok(["runs"]);
		assert.match(activeOut, new RegExp(idA));
		assert.doesNotMatch(activeOut, new RegExp(idB));
		const allOut = ok(["runs", "--all"]);
		assert.match(allOut, new RegExp(idA));
		assert.match(allOut, new RegExp(idB));

		// Update refuses while run A is active
		fail(["update", "--yes"], /active/);

		// Cleanup cleans finished run B while leaving locked active run A untouched
		assert.match(ok(["cleanup", "--dry-run"]), new RegExp(idB));
		ok(["cleanup"], "y\n");
		assert.ok(fs.existsSync(dirA));
		assert.ok(!fs.existsSync(dirB));
		assert.ok(!fs.existsSync(join(sessions, `${idB}.sqlite`)));
	} finally {
		fs.closeSync(fdA);
	}

	// Interrupted unlocked run without exit fails follow cleanly
	fs.writeFileSync(join(dirA, "progress"), "");
	fail(["follow", idA], /Worker interrupted/);
});

test("agent-runtime offline self-check exercises Pi Durable SQLite, Codemode, and multiplexed JSON-RPC", async (t) => {
	const tmp = fs.mkdtempSync(join(tmpdir(), "pi-stick-rt-"));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const runtime = join(import.meta.dirname, "..", "agent-runtime.ts");
	const child = spawn(process.execPath, [runtime], {
		env: { ...process.env, PI_STICK_SESSIONS_DIR: tmp },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stderrChunks: string[] = [];
	child.stderr.on("data", (d) => stderrChunks.push(d.toString()));
	const exit = closed(child);
	const lines = createInterface({ input: child.stdout });
	const seenMethods: string[] = [];
	let ready = false;
	child.stdin.write(`${JSON.stringify({ id: runId(), check: true, models: {}, credentials: {} })}\n`);
	for await (const line of lines) {
		const msg = JSON.parse(line);
		if (typeof msg.rpc === "number") {
			seenMethods.push(msg.method);
			child.stdin.write(
				`${JSON.stringify({ rpc: msg.rpc, result: { text: `probe-ok:${msg.method}`, error: false } })}\n`,
			);
		} else if (msg.ready === true) {
			ready = true;
			break;
		}
	}
	child.stdin.end();
	const [code] = await exit;
	assert.equal(code, 0, stderrChunks.join(""));
	assert.equal(ready, true);
	assert.deepEqual(seenMethods.sort(), ["logs", "ps"]);
});

test("doctor stops early when Docker daemon is unavailable", (t) => {
	const { stub, invoke } = fixture(t);
	stub("docker", `process.exit(1);`);
	const res = invoke(["doctor"]);
	assert.equal(res.status, 1);
	assert.match(res.stdout, /FAIL Docker daemon/);
	assert.doesNotMatch(res.stdout, /Agent image/);
});
