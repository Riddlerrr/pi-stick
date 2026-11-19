import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { read, writeJson } from "../src/platform.ts";
import { Project } from "../src/projects.ts";
import { status, tryLock } from "../src/runs.ts";

function fixture(t: TestContext) {
	const tmp = fs.mkdtempSync(join(tmpdir(), "pi-stick-test-")),
		app = join(tmp, "install"),
		bin = join(tmp, "bin");
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	fs.mkdirSync(app);
	fs.mkdirSync(bin);
	const binary = process.env.PI_STICK_TEST_BINARY;
	if (binary) fs.cpSync(join(dirname(binary), "share"), app, { recursive: true });
	else
		for (const name of ["src", "pi-stick", "package.json", "review-method.md", "project-template"])
			fs.cpSync(join(import.meta.dirname, "..", name), join(app, name), { recursive: true });
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
	fs.writeFileSync(join(source, "example"), "committed\n");
	git("add", ".");
	git("commit", "-qm", "fixture");
	const stub = (name: string, js: string) =>
		fs.writeFileSync(join(bin, name), `#!/usr/bin/env node\n${js}`, { mode: 0o700 });
	return { tmp, app, bin, source, ok, fail, invoke, git, stub, env };
}

test("symlinked CLI clones independent workspaces; failed creates leave no partial project", (t) => {
	const { app, source, tmp, ok, fail } = fixture(t);
	ok(["create", "project", "first"], `${source}\n`);
	const first = join(app, "projects/first");
	assert.equal(read(join(first, "repo/example")), "committed\n");
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

test("settings, registration and URL validation", (t) => {
	const { app, source, tmp, ok, fail } = fixture(t);
	const conf = join(tmp, ".config/pi-stick/settings.json");
	fs.mkdirSync(join(tmp, ".config/pi-stick"), { recursive: true });
	writeJson(conf, { projects_dir: "~/my projects" });
	ok(["create", "project", "demo", "--repo", source]);
	const project = join(tmp, "my projects/demo/project.json");
	writeJson(project, { github: "Acme/Example" });
	fail(["create", "project", "other", "--repo", "git@github.com:Acme/Example.git"], /Already registered/);
	fail(["pull", "https://evil.github.com/acme/example/pull/15"], /Expected a GitHub PR URL/);
	fail(["pull", "https://github.com/other/repo/pull/1"], /No project registered/);
	fs.unlinkSync(conf);
	fail(["pull", "https://github.com/acme/example/pull/15"], /No project registered/);
	assert.ok(fs.existsSync(project));
	for (const value of ["relative", join(app, "state/projects"), tmp]) {
		writeJson(conf, { projects_dir: value });
		fail(["create", "project", "other", "--repo", source], /projects directory|absolute path/);
	}
});

test("dev override is not part of the PR recipe", (t) => {
	const { app, source, ok } = fixture(t);
	ok(["create", "project", "demo", "--repo", source]);
	const folder = join(app, "projects/demo"),
		project = new Project("acme/example", 1, folder);
	const dev = JSON.parse(
		execFileSync("docker", ["compose", "config", "--format", "json"], { cwd: folder, encoding: "utf8" }),
	);
	assert.equal(dev.name, "pi-dev-demo");
	assert.ok(dev.services.runner.volumes.some((m: { source: string }) => m.source === join(folder, "repo")));
	const conf = project.config();
	assert.deepEqual(
		conf.services.runner.volumes?.map((m) => m.type),
		["volume"],
	);
	assert.equal(conf.volumes?.source.name, `${project.key}_source`);
	const file = join(folder, "compose.yaml");
	fs.writeFileSync(file, read(file).replace("source:/workspace", "./repo:/workspace"));
	assert.throws(() => project.config(), /host mounts/);
});

test("doctor refuses to probe credentials if reviewer isolation fails", (t) => {
	const { stub, invoke, tmp } = fixture(t),
		called = join(tmp, "token-request");
	stub(
		"docker",
		`if (process.argv.includes('inspect')) console.log(JSON.stringify([{State:{Running:false},Mounts:[]}]));`,
	);
	stub("pi", `require('node:fs').writeFileSync(${JSON.stringify(called)},'')`);
	const result = invoke(["doctor"]);
	assert.equal(result.status, 1);
	assert.match(result.stdout, /FAIL Reviewer identity/);
	assert.ok(!fs.existsSync(called));
	assert.doesNotMatch(result.stdout, /subscription/);
});

test("private state, lock contention, follow, recovery guards and confirmed cleanup", (t) => {
	const { app, ok, fail } = fixture(t);
	ok(["cleanup", "--dry-run"]);
	const state = join(app, "state"),
		key = "pi-stick-demo-1",
		project = join(state, "projects", key),
		id = "a".repeat(32),
		run = join(state, "runs", id);
	fs.mkdirSync(project);
	fs.mkdirSync(run);
	fs.writeFileSync(join(project, "last-used"), "");
	fs.utimesSync(join(project, "last-used"), 1, 1);
	fs.writeFileSync(join(run, "project"), key);
	status(run, "Agent: first\nsecond\x1b[2J\r\u202e");
	const fd = fs.openSync(join(state, "lock"), "a");
	try {
		assert.ok(tryLock(fd));
		fail(["cleanup", "--dry-run"], /busy/);
	} finally {
		fs.closeSync(fd);
	}
	fail(["review", "--follow", id], /Worker interrupted/);
	fail(["review", "--resume", id], /prepared runs/);
	writeJson(join(run, "prepared.json"), {});
	fs.writeFileSync(join(run, "test-in-progress"), "");
	fail(["review", "--resume", id], /Uncertain test result/);
	assert.match(ok(["cleanup", "--dry-run", "--days", "0"]), /No eligible/);
	fs.writeFileSync(join(run, "exit"), "0");
	assert.equal(ok(["review", "--follow", id]), "Agent: first\nsecond\\x1b[2J\\r\\u202e\n");
	fs.writeFileSync(join(state, "active"), id);
	fail(["cleanup"], /Unsettled/);
	fs.unlinkSync(join(state, "active"));
	assert.match(ok(["cleanup", "--dry-run"]), /including reports/);
	ok(["cleanup"], "n\n");
	assert.ok(fs.existsSync(project));
	fs.writeFileSync(join(state, "sessions", `${id}.sqlite`), "");
	ok(["cleanup"], "y\n");
	assert.ok(!fs.existsSync(project));
	assert.ok(!fs.existsSync(run));
	assert.deepEqual(fs.readdirSync(join(state, "sessions")), []);
});

test("pull, refresh and detached review exercise real Git and the JSON-lines bridge offline", async (t) => {
	const { app, tmp, ok, fail, invoke, source, git, stub, env, bin } = fixture(t);
	const url = "https://github.com/acme/example/pull/15",
		head = git("rev-parse", "HEAD");
	git("config", "--global", `url.${source}.insteadOf`, "https://github.com/acme/example.git");
	ok(["create", "project", "demo", "--repo", source]);
	writeJson(join(app, "projects/demo/project.json"), { github: "Acme/Example" });
	const catalog = join(tmp, ".pi/agent");
	fs.mkdirSync(catalog, { recursive: true });
	writeJson(join(catalog, "models-store.json"), { "openai-codex": { models: [{ id: "gpt-6.2-sol" }] } });
	stub("pi", `console.log('fixture-only-token')`);
	stub(
		"gh",
		`const a=process.argv.slice(2), path=a.at(-1); console.log(JSON.stringify(a.includes('graphql') ? [{data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}] : path.endsWith('/pulls/15') ? {head:{sha:'${head}'},base:{sha:'${head}',repo:{full_name:'Acme/Example'}},changed_files:0} : []))`,
	);
	stub(
		"docker",
		`const a=process.argv.slice(2), has=s=>a.includes(s);
    if (a[0]==='inspect') console.log(JSON.stringify([{State:{Running:true},HostConfig:{CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],ReadonlyRootfs:true},Config:{Labels:{'com.docker.compose.project':'pi-stick'}},Mounts:[{Type:'bind',Source:${JSON.stringify(join(app, "state/sessions"))},Destination:'/sessions'}]}]));
    else if (has('config')) console.log(JSON.stringify({services:{runner:{volumes:[{type:'volume',source:'source',target:'/workspace'}]}}}));
    else if (has('/usr/local/bin/test-file')) {
      if (a.at(-1)!=='example' || !has('timeout') || !has('/workspace/repo')) process.exit(2);
      console.log('fixture test passed');
    }
    else if (has('tar')) process.stdin.resume();
    else if (has('id')) console.log(process.getuid());
    else if (has('/app/reviewer.ts')) {
      const rl=require('node:readline').createInterface({input:process.stdin}); let step=0;
      const send=x=>console.log(JSON.stringify(x));
      rl.on('line',line=>{const m=JSON.parse(line);
        if (step===0 && m.token==='fixture-only-token') {
          const fs=require('node:fs'), gate=process.env.TEST_GATE;
          const start=()=>send({tool:'read',args:{value:'example'}});
          if (!gate) start();
          else {
            fs.writeFileSync(gate+'.ready','');
            const poll=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(poll);start()}},25);
          }
        }
        else if(step===1 && m.text==='committed\\n') send({tool:'search',args:{value:'committed'}});
        else if(step===2 && m.text.includes('example:1:committed')) send({tool:'test',args:{value:'../escape'}});
        else if(step===3 && m.error) send({tool:'test',args:{value:'example'}});
        else if(step===4 && !m.error && m.text.includes('exit=0\\nfixture test passed')) {send({progress:'Checking fixture'});send({report:'Fixture report'});rl.close();}
        else process.exit(2); step++;
      });
    }`,
	);
	assert.match(ok(["pull", url]), /No model call/);
	const snapshot = join(app, "state/projects/pi-stick-demo-15/snapshot"),
		repo = join(snapshot, "repo");
	fs.writeFileSync(join(repo, "example"), "local edit\n");
	execFileSync("git", ["-C", repo, "add", "example"]);
	fail(["pull", url], /Staged changes block/);
	execFileSync("git", ["-C", repo, "reset", "-q", "HEAD", "--", "example"]);
	fs.writeFileSync(join(repo, "untracked"), "preserve");
	ok(["pull", url]);
	const [history] = fs.readdirSync(join(snapshot, "history"));
	assert.match(read(join(snapshot, "history", history, "tracked-changes.patch")), /local edit/);
	assert.equal(read(join(repo, "untracked")), "preserve");
	assert.equal(read(join(repo, "example")), "committed\n");
	if (!process.getuid?.()) {
		const result = invoke(["review", url]);
		assert.equal(result.status, 1);
		assert.match(result.stdout, /Blocked/);
		return;
	}
	const gate = join(tmp, "gate"),
		launcher = spawn(join(bin, "pi-stick"), ["review", url], {
			env: { ...env, TEST_GATE: gate },
			stdio: "ignore",
		});
	const detached = once(launcher, "exit");
	let id: string;
	try {
		const deadline = Date.now() + 10000;
		while (!fs.existsSync(`${gate}.ready`) && Date.now() < deadline) await sleep(25);
		assert.ok(fs.existsSync(`${gate}.ready`), "worker reached reviewer");
		id = read(join(app, "state/active"));
		launcher.kill("SIGINT");
		await detached;
		fail(["cleanup", "--dry-run"], /busy/);
	} finally {
		fs.writeFileSync(gate, "continue");
		launcher.kill();
	}
	const out = ok(["review", "--follow", id]);
	assert.match(out, /Checking fixture/);
	assert.match(out, /Agent: Fixture report/);
	const dir = join(app, "state/runs", id);
	assert.match(ok(["review", "--follow", id]), /Wrote:/);
	assert.equal(read(join(dir, "review-report.md")), "Fixture report\n");
	assert.ok(!fs.existsSync(join(dir, "test-in-progress")));
	assert.ok(!fs.existsSync(join(app, "state/active")));
	for (const f of fs.readdirSync(dir)) assert.ok(!read(join(dir, f)).includes("fixture-only-token"));
	fs.writeFileSync(join(dir, "exit"), "1");
	fs.writeFileSync(join(repo, "example"), "different working tree");
	assert.match(ok(["review", "--resume", id]), /Agent: Fixture report/);
	fs.writeFileSync(join(snapshot, ".pull-incomplete"), "");
	fail(["pull", url], /Previous pull was interrupted/);
});
