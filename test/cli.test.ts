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
		for (const name of [
			"src",
			"pistick",
			"pistick-dev",
			"package.json",
			"project-template",
			"agent-runtime.ts",
			"Dockerfile",
			"action.schema.json",
		])
			fs.cpSync(join(import.meta.dirname, "..", name), join(app, name), { recursive: true });
	}
	const cli = join(bin, "pistick");
	fs.symlinkSync(binary ?? join(app, "pistick"), cli);
	const env = {
		...process.env,
		HOME: tmp,
		PI_STICK_HOME: app,
		PI_STICK_DEV: undefined,
		PI_STICK_DEV_HOME: undefined,
		PI_STICK_IMAGE: undefined,
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
	fail(["version", "extra"], /Usage: pistick version/);
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
		const probe = ephemeralArgs({ network: "none", tmpfsProbe: true });
		assert.ok(probe.includes(`/sessions:rw,uid=${process.getuid()},mode=0700`));
		assert.ok(!probe.includes("-v"));
	}
});

test("per-run locks allow concurrent runs, follow, diff, and selective cleanup", (t) => {
	const { app, ok, fail } = fixture(t);
	ok(["cleanup", "--dry-run"]);
	const runs = join(app, "state/runs");
	const idA = "a".repeat(32);
	const idB = "b".repeat(32);
	const dirA = join(runs, idA);
	const dirB = join(runs, idB);
	fs.mkdirSync(join(dirA, "session"), { recursive: true });
	fs.mkdirSync(join(dirB, "session"), { recursive: true });
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
	for (const [dir, id] of [
		[dirA, idA],
		[dirB, idB],
	]) {
		for (const ext of ["", "-wal", "-shm"]) fs.writeFileSync(join(dir, "session", `${id}.sqlite${ext}`), id);
	}

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
		for (const ext of ["", "-wal", "-shm"]) assert.equal(read(join(dirA, "session", `${idA}.sqlite${ext}`)), idA);
	} finally {
		fs.closeSync(fdA);
	}

	// Interrupted unlocked run without exit fails follow cleanly
	fs.writeFileSync(join(dirA, "progress"), "");
	fail(["follow", idA], /Worker interrupted/);
});

test("cleanup rechecks listed runs after confirmation", async (t) => {
	const { app, bin, env } = fixture(t);
	const [busy, reused, interrupted, gone, eligible] = Array.from({ length: 5 }, () =>
		join(app, "state/runs", runId()),
	);
	for (const dir of [busy, reused, interrupted, gone, eligible]) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(join(dir, "exit"), "0");
		fs.writeFileSync(join(dir, "last-used"), "");
		fs.utimesSync(join(dir, "last-used"), 1, 1);
	}
	const child = spawn(join(bin, "pistick"), ["cleanup"], { env, timeout: 10000 });
	const exit = closed(child);
	let output = "";
	let fd: number | undefined;
	try {
		for await (const chunk of child.stdout) {
			output += chunk;
			if (fd !== undefined || !output.includes("[y/N]")) continue;
			fd = fs.openSync(join(busy, "lock"), "a");
			assert.ok(tryLock(fd));
			fs.utimesSync(join(reused, "last-used"), 2, 2);
			fs.unlinkSync(join(interrupted, "exit"));
			fs.rmSync(gone, { recursive: true });
			child.stdin.end("y\n");
		}
		assert.equal((await exit)[0], 0, output);
		for (const dir of [busy, reused, interrupted]) assert.ok(fs.existsSync(dir), dir);
		for (const dir of [gone, eligible]) assert.ok(!fs.existsSync(dir), dir);
	} finally {
		child.kill();
		if (fd !== undefined) fs.closeSync(fd);
	}
});

test("cleanup holds the run lock during teardown and retains state if Compose fails", (t) => {
	const { app, ok, invoke, stub } = fixture(t);
	const id = runId();
	const dir = join(app, "state/runs", id);
	fs.mkdirSync(join(dir, "session"), { recursive: true });
	const db = join(dir, "session", `${id}.sqlite`);
	fs.writeFileSync(db, "history");
	fs.writeFileSync(join(dir, "compose.yaml"), "services: {}");
	fs.writeFileSync(join(dir, "exit"), "0");
	fs.writeFileSync(join(dir, "last-used"), "");
	fs.utimesSync(join(dir, "last-used"), 1, 1);
	stub(
		"docker",
		`const { spawnSync } = require('node:child_process');
		if (process.argv.slice(-2).join(' ') !== 'down --volumes') process.exit(2);
		const probe = spawnSync('flock', ['-n', '-E', '75', ${JSON.stringify(join(dir, "lock"))}, 'true']);
		process.exit(probe.status === 75 ? 7 : 3);`,
	);
	const failed = invoke(["cleanup"], "y\n");
	assert.equal(failed.status, 1);
	assert.match(failed.stderr, /docker failed \(7\)/);
	assert.equal(read(db), "history");
	assert.ok(fs.existsSync(join(dir, "compose.yaml")));
	stub("docker", "process.exit(0)");
	ok(["cleanup"], "y\n");
	assert.ok(!fs.existsSync(dir));
});

test("agent-runtime offline self-check exercises Pi Durable SQLite, Codemode, read-only scratch, parallel delegate, and multiplexed JSON-RPC", async (t) => {
	const tmp = fs.mkdtempSync(join(tmpdir(), "pi-stick-rt-"));
	const workspace = join(tmp, "workspace");
	const scratch = join(tmp, "scratch");
	const sessions = join(tmp, "sessions");
	fs.mkdirSync(workspace, { recursive: true });
	fs.mkdirSync(scratch, { recursive: true });
	fs.mkdirSync(sessions, { recursive: true });
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const runtime = join(import.meta.dirname, "..", "agent-runtime.ts");
	const child = spawn(process.execPath, [runtime], {
		env: {
			...process.env,
			PI_STICK_SESSIONS_DIR: sessions,
			PI_STICK_WORKSPACE_DIR: workspace,
			PI_STICK_SCRATCH_DIR: scratch,
		},
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
				`${JSON.stringify({ rpc: msg.rpc, result: { text: msg.method === "check_clean" ? "" : `probe-ok:${msg.method}`, error: false } })}\n`,
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
	assert.ok(seenMethods.includes("ps"));
	assert.ok(seenMethods.includes("logs"));
	assert.ok(seenMethods.includes("check_clean"));
	// Read-only subagents wrote to their isolated scratch dirs and were blocked from /workspace
	assert.ok(!fs.existsSync(join(workspace, "should-fail.txt")));
	assert.equal(read(join(scratch, "checker-a/note.txt")), "ok-a");
	assert.equal(read(join(scratch, "checker-b/note.txt")), "ok-b");
});

test("doctor stops early when Docker daemon is unavailable", (t) => {
	const { stub, invoke } = fixture(t);
	stub("docker", `process.exit(1);`);
	const res = invoke(["doctor"]);
	assert.equal(res.status, 1);
	assert.match(res.stdout, /FAIL Docker daemon/);
	assert.doesNotMatch(res.stdout, /Agent image/);
});

test("actions system starts empty, supports global/project override, and rejects traversal", (t) => {
	const { app, source, ok, fail } = fixture(t);
	ok(["create", "project", "demo", "--repo", source]);
	assert.match(ok(["actions"]), /No actions configured/);

	ok(["create", "action", "audit"]);
	assert.match(ok(["actions"]), /audit\s+global/);
	fail(["create", "action", "audit"], /already exists/);

	ok(["create", "action", "audit", "--project", "demo"]);
	assert.match(ok(["actions", "--project", "demo"]), /audit\s+project \(overrides global\)/);

	// Running without any model configured fails clearly
	fail(["run", "demo", "audit"], /No model configured/);

	// Path traversal in instructions must be rejected when loading/validating
	const projAction = join(app, "projects/demo/actions/audit/action.json");
	const manifest = JSON.parse(read(projAction));
	manifest.model = "openai-codex/gpt-6.2-sol";
	manifest.orchestrator.instructions = "../../compose.yaml";
	writeJson(projAction, manifest);
	fail(["run", "demo", "audit"], /escapes the action directory/);
});

test("failed Compose startup or setup stops the task stack unless --keep-up was requested", (t) => {
	const { app, tmp, source, ok, invoke, stub } = fixture(t);
	ok(["create", "project", "demo", "--repo", source]);
	ok(["create", "action", "check"]);
	writeJson(join(app, "actions/check/action.json"), {
		model: "test/model",
		orchestrator: { instructions: "instructions.md" },
	});
	const calls = join(tmp, "compose-calls");
	for (const [failAt, keepUp] of [
		["up", false],
		["exec", false],
		["exec", true],
	] as const) {
		fs.writeFileSync(calls, "");
		stub(
			"docker",
			`const args = process.argv.slice(2);
			if (args.includes('config')) console.log(JSON.stringify({services:{runner:{volumes:[{type:'volume',source:'source',target:'/workspace'}]}}}));
			else {
				const cmd = args.find(arg => ['up','exec','stop'].includes(arg));
				require('node:fs').appendFileSync(${JSON.stringify(calls)}, cmd + '\\n');
				if (cmd === '${failAt}') process.exit(1);
			}`,
		);
		const result = invoke(["run", "demo", "check", ...(keepUp ? ["--keep-up"] : [])]);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.deepEqual(read(calls).trim().split("\n"), [
			"up",
			...(failAt === "exec" ? ["exec"] : []),
			...(keepUp ? [] : ["stop"]),
		]);
		const id = /Run: ([0-9a-f]{32})/.exec(result.stdout)?.[1];
		assert.ok(id, result.stdout);
		assert.equal(JSON.parse(read(join(app, "state/runs", id, "meta.json"))).status, "failed");
	}
});

test("resume may initialize a session only before the first agent launch attempt", (t) => {
	const { app, tmp, source, ok, fail, invoke, stub } = fixture(t);
	ok(["create", "project", "demo", "--repo", source]);
	ok(["create", "action", "check"]);
	writeJson(join(app, "actions/check/action.json"), {
		model: "test/model",
		orchestrator: { instructions: "instructions.md" },
	});
	const attempts = join(tmp, "agent-attempts");
	stub(
		"docker",
		`const fs = require('node:fs');
		const args = process.argv.slice(2);
		if (args.includes('config')) console.log(JSON.stringify({services:{runner:{volumes:[{type:'volume',source:'source',target:'/workspace'}]}}}));
		if (args[0] === 'run') {
			const session = args.find(a => a.endsWith(':/sessions')).slice(0, -':/sessions'.length);
			const config = JSON.parse(fs.readFileSync(session + '/../run-config.json'));
			if (config.agentLaunchAttempted !== true) process.exit(2);
			fs.appendFileSync(${JSON.stringify(attempts)}, 'attempt\\n');
			if (fs.existsSync(${JSON.stringify(join(tmp, "fail-launch"))})) process.exit(1);
			require('node:readline').createInterface({input:process.stdin}).once('line', line => {
				fs.writeFileSync(session + '/' + JSON.parse(line).id + '.sqlite', 'initial history');
				console.log(JSON.stringify({ report: 'done' }));
			});
		}`,
	);
	stub("pi", "process.exit(1)");
	const interruptedRun = () => {
		const result = invoke(["run", "demo", "check"]);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		const id = /Run: ([0-9a-f]{32})/.exec(result.stdout)?.[1];
		assert.ok(id, result.stdout);
		return id;
	};
	const unstarted = interruptedRun();
	const first = join(app, "state/runs", unstarted);
	assert.equal(JSON.parse(read(join(first, "run-config.json"))).agentLaunchAttempted, false);
	assert.ok(!fs.existsSync(join(first, "session")));
	stub("pi", "console.log('test-token')");
	ok(["resume", unstarted]);
	assert.equal(read(join(first, "session", `${unstarted}.sqlite`)), "initial history");

	fs.writeFileSync(join(tmp, "fail-launch"), "");
	const attempted = interruptedRun();
	const second = join(app, "state/runs", attempted);
	assert.equal(JSON.parse(read(join(second, "run-config.json"))).agentLaunchAttempted, true);
	fail(["resume", attempted], /Session database missing/);
	assert.deepEqual(fs.readdirSync(join(second, "session")), []);
	assert.equal(read(join(second, "exit")), "1");
	assert.equal(read(attempts), "attempt\nattempt\n");
});

test("end-to-end run, hooks, multiplexed RPC, diff, continue, and resume", async (t) => {
	const { app, tmp, source, ok, fail, stub, invoke } = fixture(t);
	ok(["create", "project", "demo", "--repo", source]);
	ok(["create", "action", "fix"]);

	const actionDir = join(app, "actions/fix");
	const hooksDir = join(actionDir, "hooks");
	fs.mkdirSync(hooksDir, { recursive: true });
	const prepareScript = join(hooksDir, "prepare.sh");
	const afterScript = join(hooksDir, "after.sh");
	const afterMarker = join(tmp, "after-called.json");
	const failHook = join(tmp, "fail-after");
	const projectDir = join(app, "projects/demo");
	fs.writeFileSync(join(projectDir, "AGENTS.md"), "PINNED PROJECT NOTES");
	fs.writeFileSync(join(actionDir, "instructions.md"), "PINNED INSTRUCTIONS");
	fs.writeFileSync(
		prepareScript,
		`#!/usr/bin/env bash\nset -euo pipefail\nprintf 'ticket=%s\\n' "$PI_STICK_INPUTS_JSON" > "$PI_STICK_CONTEXT/ticket.txt"\n`,
		{ mode: 0o700 },
	);
	fs.writeFileSync(
		afterScript,
		`#!/usr/bin/env bash\nset -euo pipefail\n[[ "$PI_STICK_ACTION_DIR" == ${JSON.stringify(actionDir)} && "$PI_STICK_HOOK_SOURCE_DIR" == ${JSON.stringify(hooksDir)} && "$0" == "$PI_STICK_RUN_DIR/action-snapshot/after" && "$PWD" == "$PI_STICK_REPO" ]]\n[[ ! -e ${JSON.stringify(failHook)} ]]\nprintf '{"code":%s,"report":"%s","patch":"%s"}\n' "$PI_STICK_EXIT_CODE" "$PI_STICK_REPORT_FILE" "\${PI_STICK_PATCH_FILE:-}" > ${JSON.stringify(afterMarker)}\n`,
		{ mode: 0o700 },
	);

	const settings = join(tmp, ".config/pi-stick/settings.json");
	fs.mkdirSync(dirname(settings), { recursive: true });
	writeJson(settings, { default_model: "openai-codex/gpt-6.2-sol" });
	writeJson(join(actionDir, "action.json"), {
		name: "fix",
		description: "Fix and verify issue",
		inputs: {
			ticket: { required: true },
		},
		hooks: {
			prepare: "hooks/prepare.sh",
			after: "hooks/after.sh",
		},
		orchestrator: {
			instructions: "instructions.md",
			mode: "read-write",
			tools: ["read", "write", "edit", "grep", "find", "codemode", "exec", "logs", "ps"],
			allowedServices: ["runner"],
		},
	});

	const piDir = join(tmp, ".pi/agent");
	fs.mkdirSync(piDir, { recursive: true });
	writeJson(join(piDir, "models-store.json"), { "openai-codex": { models: [{ id: "gpt-6.2-sol" }] } });
	writeJson(join(piDir, "auth.json"), { "openai-codex": { type: "oauth" } });
	stub("pi", `console.log('secret-fixture-token')`);

	const dockerLog = join(tmp, "docker-calls.log");
	stub(
		"docker",
		`const fs = require('node:fs');
const a = process.argv.slice(2);
const has = s => a.includes(s);
fs.appendFileSync(${JSON.stringify(dockerLog)}, a.join(' ') + '\\n');
if (has('config')) {
  // Base validation runs after launcher resolution but before the first worker.
  const override = ${JSON.stringify(join(projectDir, "actions/fix"))};
  fs.mkdirSync(override, {recursive:true});
  fs.writeFileSync(override + '/action.json', JSON.stringify({orchestrator:{model:'changed/model',tools:['restart']}}));
  console.log(JSON.stringify({
    services: { runner: { volumes: [{ type: 'volume', source: 'source', target: '/workspace' }] } },
    volumes: { source: { name: a[a.indexOf('-p') + 1] + '_source' } },
    networks: { default: { name: a[a.indexOf('-p') + 1] + '_default' } }
  }));
} else if (has('stop') && fs.existsSync(${JSON.stringify(join(tmp, "fail-stop"))})) {
  process.exit(9);
} else if (has('exec') && has('sh') && has('-lc')) {
  console.log('exec-ok:' + a.at(-1));
} else if (has('logs')) {
  console.log('service-log-line');
} else if (has('ps')) {
  console.log('[{"Service":"runner","State":"running"}]');
} else if (a[0] === 'run' && has('/app/agent-runtime.ts')) {
  const repoMount = a.find(x => x.endsWith(':/workspace')).slice(0, -':/workspace'.length);
  const ctxMount = a.find(x => x.endsWith(':/context:ro')).slice(0, -':/context:ro'.length);
  const rl = require('node:readline').createInterface({ input: process.stdin });
  const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
  let got = 0;
  let job = null;
  rl.on('line', line => {
    const m = JSON.parse(line);
    if (!job) {
      job = m;
      if (job.credentials['openai-codex'].token !== (job.continueRun ? 'fresh-token' : 'secret-fixture-token')) process.exit(3);
      if (job.orchestrator.model.modelId !== 'gpt-6.2-sol' || !job.orchestrator.instructions.includes('PINNED PROJECT NOTES') || !job.orchestrator.instructions.includes('PINNED INSTRUCTIONS') || job.orchestrator.tools.includes('restart')) process.exit(10);
      if (job.continueRun && !job.orchestrator.instructions.includes('updated-context.md')) process.exit(11);
      if (!fs.readFileSync(ctxMount + '/ticket.txt', 'utf8').includes('ISSUE-42')) process.exit(4);
      const session = a.find(x => x.endsWith(':/sessions')).slice(0, -':/sessions'.length);
      const db = session + '/' + job.id + '.sqlite';
      if (job.continueRun) {
        if (fs.readFileSync(db, 'utf8') !== job.id) process.exit(6);
        if (!fs.existsSync(repoMount + '/followup-started')) { fs.writeFileSync(repoMount + '/followup-started', job.requestId); process.exit(7); }
        if (fs.readFileSync(repoMount + '/followup-started', 'utf8') !== job.requestId) process.exit(8);
        fs.appendFileSync(repoMount + '/example.txt', 'followup\\n');
        send({ progress: 'Applying follow-up', agent: 'orchestrator' });
        send({ report: 'Follow-up complete' });
        rl.close();
        return;
      }
      fs.writeFileSync(db, job.id);
      fs.writeFileSync(repoMount + '/example.txt', 'updated\\n');
      // Fire 2 concurrent RPC calls + 1 disallowed restart call
      send({ rpc: 1, method: 'exec', params: { command: 'echo hi' }, agent: 'orchestrator' });
      send({ rpc: 2, method: 'logs', params: { tail: 10 }, agent: 'orchestrator' });
      send({ rpc: 3, method: 'restart', params: { service: 'runner' }, agent: 'orchestrator' });
      return;
    }
    if (m.rpc === 1 && !m.result.error && m.result.text.includes('exec-ok:echo hi')) got |= 1;
    else if (m.rpc === 2 && !m.result.error && m.result.text.includes('service-log-line')) got |= 2;
    else if (m.rpc === 3 && m.result.error && m.result.text.includes('not permitted')) got |= 4;
    else process.exit(5);
    if (got === 7) {
      send({ progress: 'All checks passed', agent: 'orchestrator' });
      send({ report: 'Initial report' });
      rl.close();
    }
  });
}`,
	);

	// Missing required input fails fast before spawning worker
	fail(["run", "demo", "fix"], /Missing required input 'ticket'/);

	const runOut = ok(["run", "demo", "fix", "--input", "ticket=ISSUE-42", "Fix the bug"]);
	const idMatch = /Run: ([0-9a-f]{32})/.exec(runOut);
	assert.ok(idMatch, runOut);
	const id = idMatch[1];
	assert.match(runOut, /\[orchestrator\] All checks passed/);
	assert.match(runOut, /\[orchestrator\] Initial report/);
	assert.match(runOut, /Patch:/);

	const runPath = join(app, "state/runs", id);
	assert.equal(read(join(runPath, "report.md")), "Initial report\n");
	assert.match(read(join(runPath, "changes.patch")), /\+updated/);
	assert.match(ok(["diff", id]), /\+updated/);
	// After hook ran with report & patch paths
	const afterData = JSON.parse(read(afterMarker));
	assert.equal(afterData.code, 0);
	assert.equal(afterData.report, join(runPath, "report.md"));
	assert.equal(afterData.patch, join(runPath, "changes.patch"));
	// Project stack was stopped after completion
	assert.match(read(dockerLog), /compose .* stop/);
	// Secret bearer token must never be persisted in run directory files
	for (const f of fs.readdirSync(runPath)) {
		const p = join(runPath, f);
		if (fs.statSync(p).isFile()) assert.ok(!read(p).includes("secret-fixture-token"), `Token leaked in ${f}`);
	}

	const db = join(runPath, "session", `${id}.sqlite`);
	assert.equal(read(db), id);
	fs.unlinkSync(db);
	const snapshot = () =>
		["run-config.json", "meta.json", "progress", "exit"].map((f) => read(join(runPath, f))).concat(read(dockerLog));
	const before = snapshot();
	fail(["continue", id, "must not be saved"], /Session database missing/);
	assert.deepEqual(snapshot(), before);
	assert.ok(!fs.existsSync(db));
	fs.writeFileSync(db, id);

	const pinned = join(runPath, "action-snapshot");
	for (const name of fs.readdirSync(pinned)) assert.ok(!read(join(pinned, name)).includes("secret-fixture-token"));
	fs.rmSync(actionDir, { recursive: true });
	writeJson(settings, { default_model: "different/model" });
	fs.writeFileSync(join(projectDir, "AGENTS.md"), "CHANGED NOTES");
	fs.writeFileSync(join(runPath, "context/updated-context.md"), "new context");
	stub("pi", "console.log('fresh-token')");

	// Continue run with follow-up prompt
	assert.equal(invoke(["continue", id, "Also add followup line"]).status, 1);
	const failedState = snapshot();
	fs.renameSync(pinned, `${pinned}.missing`);
	fail(["resume", id], /Invalid action snapshot/);
	assert.deepEqual(snapshot(), failedState);
	fs.renameSync(`${pinned}.missing`, pinned);
	const cfgPath = join(runPath, "run-config.json");
	const cfg = JSON.parse(read(cfgPath));
	const { actionDigest: _digest, ...legacy } = cfg;
	writeJson(cfgPath, legacy);
	const legacyState = snapshot();
	fail(["continue", id, "ignore legacy run"], /Missing action snapshot/);
	assert.deepEqual(snapshot(), legacyState);
	writeJson(cfgPath, cfg);
	const savedHook = join(pinned, "after");
	fs.chmodSync(savedHook, 0o700);
	const script = read(savedHook);
	fs.appendFileSync(savedHook, "# changed bytes\n");
	fail(["resume", id], /after checksum mismatch/);
	fail(["continue", id, "do not start"], /after checksum mismatch/);
	assert.deepEqual(snapshot(), failedState);
	fs.writeFileSync(savedHook, script);
	fs.writeFileSync(failHook, "");
	assert.equal(invoke(["resume", id]).status, 1);
	fail(["resume", id], /after hook unknown/);
	fs.unlinkSync(failHook);
	const stopFailure = join(tmp, "fail-stop");
	fs.writeFileSync(stopFailure, "");
	const stopResult = invoke(["resume", id, "--retry-hook"]);
	assert.equal(stopResult.status, 1);
	assert.match(stopResult.stdout, /Failed to stop project stack/);
	assert.equal(JSON.parse(read(join(runPath, "meta.json"))).status, "failed");
	fs.unlinkSync(stopFailure);
	ok(["resume", id]);
	assert.equal(read(join(runPath, "report.md")), "Follow-up complete\n");
	assert.equal(read(join(runPath, "workspace/repo/example.txt")), "updated\nfollowup\n");
	assert.match(ok(["diff", id]), /\+followup/);

	// A completed follow-up cannot be resumed again.
	fail(["resume", id], /already completed/);
});

test("multi-agent action validates stages, resolves multi-provider auth, enforces per-agent RPC policies, and saves per-agent outputs", (t) => {
	const { app, tmp, source, ok, fail, stub } = fixture(t);
	ok(["create", "project", "demo", "--repo", source]);
	ok(["create", "action", "deep-check"]);
	const actionDir = join(app, "actions/deep-check");
	fs.mkdirSync(join(actionDir, "agents"), { recursive: true });
	fs.writeFileSync(join(actionDir, "agents/sec.md"), "Check security.");
	fs.writeFileSync(join(actionDir, "agents/perf.md"), "Check performance.");

	// Invalid: parallel stage with two read-write agents must be rejected
	writeJson(join(actionDir, "action.json"), {
		name: "deep-check",
		model: "openai-codex/gpt-6.2-sol",
		orchestrator: { instructions: "instructions.md", mode: "read-write" },
		agents: {
			sec: { instructions: "agents/sec.md", mode: "read-write" },
			perf: { instructions: "agents/perf.md", mode: "read-write" },
		},
		stages: [{ name: "parallel-bad", parallel: ["sec", "perf"] }],
	});
	fail(["run", "demo", "deep-check"], /multiple read-write agents in parallel/);

	// Valid multi-provider multi-agent action
	writeJson(join(actionDir, "action.json"), {
		name: "deep-check",
		description: "Multi-agent parallel analysis",
		orchestrator: {
			model: "openai-codex/gpt-6.2-sol",
			instructions: "instructions.md",
			mode: "read-write",
			tools: ["read", "write", "edit", "grep", "find", "codemode", "exec", "logs", "ps", "restart", "delegate"],
			allowedServices: ["runner", "web"],
		},
		agents: {
			sec: {
				description: "Security specialist",
				model: "anthropic/claude-sonnet-4-5",
				instructions: "agents/sec.md",
				mode: "read-only",
				tools: ["read", "grep", "find", "exec", "logs"],
				allowedServices: ["runner"],
			},
			perf: {
				description: "Performance specialist",
				model: "openai-codex/gpt-6.2-sol",
				instructions: "agents/perf.md",
				mode: "read-only",
				tools: ["read", "grep", "find", "ps"],
				allowedServices: ["runner"],
			},
		},
		stages: [{ name: "analyze", parallel: ["sec", "perf"], prompt: "Audit codebase" }],
	});

	const piDir = join(tmp, ".pi/agent");
	fs.mkdirSync(piDir, { recursive: true });
	writeJson(join(piDir, "models-store.json"), { "openai-codex": { models: [{ id: "gpt-6.2-sol" }] } });
	writeJson(join(piDir, "auth.json"), { "openai-codex": { type: "oauth" }, anthropic: { type: "api_key" } });
	stub(
		"pi",
		`const idx = process.argv.indexOf('--model');
const m = idx >= 0 ? process.argv[idx + 1] : '';
if (m.startsWith('anthropic/')) console.log('anthropic-key-fixture');
else console.log('codex-token-fixture');`,
	);

	stub(
		"docker",
		`const a = process.argv.slice(2);
const has = s => a.includes(s);
if (has('config')) {
  console.log(JSON.stringify({
    services: {
      runner: { volumes: [{ type: 'volume', source: 'source', target: '/workspace' }] },
      web: {}
    },
    volumes: { source: { name: a[a.indexOf('-p') + 1] + '_source' } },
    networks: { default: { name: a[a.indexOf('-p') + 1] + '_default' } }
  }));
} else if (has('exec') && has('sh') && has('-lc')) {
  console.log('ran:' + a.at(-1));
} else if (a[0] === 'run' && has('/app/agent-runtime.ts')) {
  const rl = require('node:readline').createInterface({ input: process.stdin });
  const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
  let got = 0;
  let job = null;
  rl.on('line', line => {
    const m = JSON.parse(line);
    if (!job) {
      job = m;
      if (job.credentials['openai-codex'].token !== 'codex-token-fixture') process.exit(3);
      if (job.credentials['openai-codex'].authType !== 'oauth') process.exit(4);
      if (job.credentials['anthropic'].token !== 'anthropic-key-fixture') process.exit(5);
      if (job.credentials['anthropic'].authType !== 'api_key') process.exit(6);
      if (!job.orchestrator.instructions.includes('Security specialist')) process.exit(7);
      if (job.stages.length !== 1 || job.stages[0].parallel.join(',') !== 'sec,perf') process.exit(8);
      // Test per-agent host RPC policy: sec cannot exec on 'web', orchestrator can exec on 'web', perf cannot exec at all
      send({ rpc: 1, method: 'exec', params: { service: 'web', command: 'echo 1' }, agent: 'sec' });
      send({ rpc: 2, method: 'exec', params: { service: 'web', command: 'echo 2' }, agent: 'orchestrator' });
      send({ rpc: 3, method: 'exec', params: { service: 'runner', command: 'echo 3' }, agent: 'perf' });
      return;
    }
    if (m.rpc === 1 && m.result.error && m.result.text.includes('not permitted')) got |= 1;
    else if (m.rpc === 2 && !m.result.error && m.result.text.includes('ran:echo 2')) got |= 2;
    else if (m.rpc === 3 && m.result.error && m.result.text.includes('not permitted')) got |= 4;
    else process.exit(9);
    if (got === 7) {
      send({ progress: 'checked auth', agent: 'agent:sec' });
      send({ progress: 'checked queries', agent: 'agent:perf' });
      send({
        report: 'Combined synthesis report',
        outputs: { sec: 'Security findings', perf: 'Perf findings' }
      });
      rl.close();
    }
  });
}`,
	);

	const out = ok(["run", "demo", "deep-check", "Run full audit"]);
	const id = /Run: ([0-9a-f]{32})/.exec(out)![1];
	assert.match(out, /\[agent:sec\] checked auth/);
	assert.match(out, /\[agent:perf\] checked queries/);
	assert.match(out, /Combined synthesis report/);
	const runPath = join(app, "state/runs", id);
	assert.equal(read(join(runPath, "outputs/sec.md")), "Security findings\n");
	assert.equal(read(join(runPath, "outputs/perf.md")), "Perf findings\n");
});

test("two concurrent runs execute simultaneously with isolated workspaces and locks", async (t) => {
	const { app, tmp, bin, source, ok, stub, env } = fixture(t);
	ok(["create", "project", "demo", "--repo", source]);
	ok(["create", "action", "echo"]);
	writeJson(join(app, "actions/echo/action.json"), {
		name: "echo",
		model: "openai-codex/gpt-6.2-sol",
		orchestrator: { instructions: "instructions.md", mode: "read-write" },
	});
	const piDir = join(tmp, ".pi/agent");
	fs.mkdirSync(piDir, { recursive: true });
	writeJson(join(piDir, "models-store.json"), { "openai-codex": { models: [{ id: "gpt-6.2-sol" }] } });
	writeJson(join(piDir, "auth.json"), { "openai-codex": { type: "oauth" } });
	stub("pi", `console.log('tok')`);

	const gateDir = join(tmp, "gates");
	fs.mkdirSync(gateDir, { recursive: true });
	const releaseFile = join(gateDir, "release");
	stub(
		"docker",
		`const fs = require('node:fs');
const a = process.argv.slice(2);
const has = s => a.includes(s);
if (has('config')) {
  console.log(JSON.stringify({
    services: { runner: { volumes: [{ type: 'volume', source: 'source', target: '/workspace' }] } },
    volumes: { source: { name: a[a.indexOf('-p') + 1] + '_source' } },
    networks: { default: { name: a[a.indexOf('-p') + 1] + '_default' } }
  }));
} else if (a[0] === 'run' && has('/app/agent-runtime.ts')) {
  const repoMount = a.find(x => x.endsWith(':/workspace')).slice(0, -':/workspace'.length);
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.once('line', line => {
    const job = JSON.parse(line);
    const session = a.find(x => x.endsWith(':/sessions')).slice(0, -':/sessions'.length);
    if (session !== ${JSON.stringify(join(app, "state/runs"))} + '/' + job.id + '/session') process.exit(2);
    fs.writeFileSync(session + '/' + job.id + '.sqlite', job.prompt);
    fs.writeFileSync(${JSON.stringify(gateDir)} + '/' + job.id + '.ready', '');
    fs.writeFileSync(repoMount + '/marker.txt', job.prompt + '\\n');
    const iv = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(releaseFile)})) {
        clearInterval(iv);
        process.stdout.write(JSON.stringify({ report: 'done:' + job.prompt }) + '\\n');
        rl.close();
      }
    }, 25);
  });
}`,
	);

	const run1 = spawn(join(bin, "pistick"), ["run", "demo", "echo", "task-one"], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const run2 = spawn(join(bin, "pistick"), ["run", "demo", "echo", "task-two"], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out1 = "";
	let out2 = "";
	run1.stdout.on("data", (d) => {
		out1 += d.toString();
	});
	run2.stdout.on("data", (d) => {
		out2 += d.toString();
	});
	const done1 = closed(run1);
	const done2 = closed(run2);
	try {
		const deadline = Date.now() + 10_000;
		while (fs.readdirSync(gateDir).filter((f) => f.endsWith(".ready")).length < 2 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 25));
		}
		const readyIds = fs
			.readdirSync(gateDir)
			.filter((f) => f.endsWith(".ready"))
			.map((f) => f.replace(/\.ready$/, ""));
		assert.equal(readyIds.length, 2, "both runs should be active concurrently");
		const activeOut = ok(["runs"]);
		for (const id of readyIds) {
			assert.match(activeOut, new RegExp(id));
			assert.deepEqual(fs.readdirSync(join(app, "state/runs", id, "session")), [`${id}.sqlite`]);
		}
	} finally {
		fs.writeFileSync(releaseFile, "go");
	}
	assert.equal((await done1)[0], 0, out1);
	assert.equal((await done2)[0], 0, out2);
	assert.match(out1, /done:task-one/);
	assert.match(out2, /done:task-two/);
});

test("stage-release.sh packages updated runtime files and excludes removed legacy files", (t) => {
	const tmp = fs.mkdtempSync(join(tmpdir(), "pi-stick-stage-"));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const repoRoot = join(import.meta.dirname, "..");
	const r = spawnSync("bash", [join(repoRoot, "scripts/stage-release.sh"), tmp], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	assert.equal(r.status, 0, r.stderr);
	for (const rel of [
		"share/agent-runtime.ts",
		"share/action.schema.json",
		"share/Dockerfile",
		"share/.dockerignore",
		"share/package.json",
		"share/package-lock.json",
		"share/project-template/Dockerfile",
		"share/project-template/compose.yaml",
		"share/project-template/setup-project",
		"share/project-template/AGENTS.md",
		"README.md",
		"CHANGELOG.md",
	]) {
		assert.ok(fs.existsSync(join(tmp, rel)), `missing staged file: ${rel}`);
	}
	for (const removed of [
		"share/reviewer.ts",
		"share/review-method.md",
		"share/compose.yaml",
		"share/project-template/test-file",
	]) {
		assert.ok(!fs.existsSync(join(tmp, removed)), `stale legacy file still staged: ${removed}`);
	}
});

test("dev mode isolates data, settings, and image from installed home via auto-dev, --dev, and pistick-dev", (t) => {
	const { app, tmp, bin, source, stub, env } = fixture(t);
	stub("docker", `process.exit(1);`);
	// Put a production settings.json that must NOT leak into dev mode
	fs.mkdirSync(join(tmp, ".config/pi-stick"), { recursive: true });
	writeJson(join(tmp, ".config/pi-stick/settings.json"), { projects_dir: join(tmp, "prod-projects") });

	const devHome = join(tmp, "pi-stick-dev");

	// 1. --dev flag overrides PI_STICK_HOME (e.g. from launcher) and uses ~/pi-stick-dev + pi-stick:dev
	const flagDoc = spawnSync(join(bin, "pistick"), ["--dev", "doctor"], { env, cwd: tmp, encoding: "utf8" });
	assert.match(flagDoc.stdout, /Mode: dev/);
	assert.match(flagDoc.stdout, new RegExp(`Home: ${devHome}`));
	assert.match(flagDoc.stdout, new RegExp(`Settings: ${join(devHome, "settings.json")}`));
	assert.match(flagDoc.stdout, /Image: pi-stick:dev/);

	// 2. Uncompiled ./pistick without PI_STICK_HOME auto-enters dev mode, keeping checkout clean
	if (!process.env.PI_STICK_TEST_BINARY) {
		const noHomeEnv = { ...env, PI_STICK_HOME: undefined };
		const autoDoc = spawnSync(join(app, "pistick"), ["doctor"], { env: noHomeEnv, cwd: tmp, encoding: "utf8" });
		assert.match(autoDoc.stdout, /Mode: dev/);
		assert.match(autoDoc.stdout, new RegExp(`Home: ${devHome}`));
		assert.match(autoDoc.stdout, new RegExp(`Assets: ${app}`));

		// 3. ./pistick-dev wrapper forces dev mode even when PI_STICK_HOME is set
		const wrapCreate = spawnSync(join(app, "pistick-dev"), ["create", "project", "dev-proj", "--repo", source], {
			env,
			cwd: tmp,
			encoding: "utf8",
		});
		assert.equal(wrapCreate.status, 0, wrapCreate.stderr);
		assert.ok(fs.existsSync(join(devHome, "projects/dev-proj/repo/example.txt")));
		assert.ok(!fs.existsSync(join(tmp, "prod-projects/dev-proj")));
		assert.ok(!fs.existsSync(join(app, "projects/dev-proj")));

		// 4. PI_STICK_DEV_HOME overrides the dev data folder
		const customDev = join(tmp, "custom-dev");
		const customDoc = spawnSync(join(app, "pistick-dev"), ["doctor"], {
			env: { ...env, PI_STICK_DEV_HOME: customDev },
			cwd: tmp,
			encoding: "utf8",
		});
		assert.match(customDoc.stdout, new RegExp(`Home: ${customDev}`));
	}
});

test("install-dev.sh prepares dev folder, suggests Pi default model, supports fresh wipe with teardown, and enforces safety guards", (t) => {
	const tmp = fs.mkdtempSync(join(tmpdir(), "pi-stick-install-dev-"));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const repoRoot = join(import.meta.dirname, "..");
	const script = join(repoRoot, "scripts/install-dev.sh");
	const bin = join(tmp, "bin");
	fs.mkdirSync(bin);
	const dockerLog = join(tmp, "docker.log");
	fs.writeFileSync(
		join(bin, "docker"),
		`#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(dockerLog)}, process.argv.slice(2).join(' ') + '\\n');\nif (process.argv[2] === 'info') process.exit(1);\n`,
		{ mode: 0o700 },
	);

	// Pi settings with defaultProvider + defaultModel should be suggested
	const piDir = join(tmp, ".pi/agent");
	fs.mkdirSync(piDir, { recursive: true });
	writeJson(join(piDir, "settings.json"), { defaultProvider: "openai-codex", defaultModel: "smart" });

	const env = {
		...process.env,
		HOME: tmp,
		PI_STICK_HOME: undefined,
		PI_STICK_DEV_HOME: undefined,
		PATH: `${bin}:${process.env.PATH}`,
	};
	const runScript = (args: string[], input?: string) =>
		spawnSync("bash", [script, ...args], { env, cwd: repoRoot, encoding: "utf8", input });

	// 1. Initial interactive setup: default path, accept Pi suggested model, skip docker build
	const devDir = join(tmp, "pi-stick-dev");
	const first = runScript([], "\n\nn\n");
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stderr, /openai-codex\/smart from Pi settings/);
	assert.ok(fs.existsSync(join(devDir, "projects")));
	assert.ok(fs.existsSync(join(devDir, "actions")));
	assert.ok(fs.existsSync(join(devDir, "state/runs")));
	assert.ok(!fs.existsSync(join(devDir, "state/sessions")));
	assert.ok(fs.existsSync(join(devDir, ".pi-stick-dev")));
	assert.deepEqual(JSON.parse(read(join(devDir, "settings.json"))), { default_model: "openai-codex/smart" });
	assert.ok(!fs.existsSync(join(tmp, ".local/bin")), "should not install launcher into ~/.local/bin");
	assert.ok(!fs.existsSync(dockerLog), "should skip docker build when answered n");

	// 2. Keep mode preserves existing state and allows overriding default_model
	fs.writeFileSync(join(devDir, "projects/keep-marker"), "present");
	const keep = runScript([], "\nn\nanthropic/claude-sonnet-4-5\nn\n");
	assert.equal(keep.status, 0, keep.stderr);
	assert.equal(read(join(devDir, "projects/keep-marker")), "present");
	assert.deepEqual(JSON.parse(read(join(devDir, "settings.json"))), { default_model: "anthropic/claude-sonnet-4-5" });

	// 3. Active run lock blocks --fresh wipe
	const activeId = "a".repeat(32);
	const activeRunDir = join(devDir, "state/runs", activeId);
	fs.mkdirSync(activeRunDir, { recursive: true });
	writeJson(join(activeRunDir, "meta.json"), { id: activeId, project: "demo" });
	fs.writeFileSync(join(activeRunDir, "compose.yaml"), "services: {}\n");
	const fd = fs.openSync(join(activeRunDir, "lock"), "a");
	try {
		assert.ok(tryLock(fd));
		const blocked = runScript(["--fresh", "--yes", "--no-build"]);
		assert.equal(blocked.status, 1);
		assert.match(blocked.stderr, /active task run/);
		assert.equal(read(join(devDir, "projects/keep-marker")), "present");
	} finally {
		fs.closeSync(fd);
	}

	// 4. Unlocked --fresh tears down Compose stack, removes old files, and recreates fresh dev dir with Pi suggestion
	const freshRes = runScript(["--fresh", "--yes", "--no-build"]);
	assert.equal(freshRes.status, 0, freshRes.stderr);
	assert.ok(!fs.existsSync(join(devDir, "projects/keep-marker")), "old marker should be removed on fresh install");
	assert.deepEqual(JSON.parse(read(join(devDir, "settings.json"))), { default_model: "openai-codex/smart" });
	assert.match(read(dockerLog), new RegExp(`compose -p pi-stick-demo-${"a".repeat(12)} -f .* down --volumes`));

	// 5. Refuses dangerous and unrecognized directories
	const homeGuard = runScript(["--dir", tmp, "--fresh", "--yes", "--no-build"]);
	assert.equal(homeGuard.status, 1);
	assert.match(homeGuard.stderr, /unsafe dev directory/);

	const foreignDir = join(tmp, "unrelated");
	fs.mkdirSync(foreignDir);
	fs.writeFileSync(join(foreignDir, "important.txt"), "do not delete");
	const foreignGuard = runScript(["--dir", foreignDir, "--fresh", "--yes", "--no-build"]);
	assert.equal(foreignGuard.status, 1);
	assert.match(foreignGuard.stderr, /Not a recognized pi-stick dev directory/);
	assert.equal(read(join(foreignDir, "important.txt")), "do not delete");
});
