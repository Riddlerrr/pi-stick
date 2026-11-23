import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { runId } from "../src/platform.ts";

function stageFixture(t: TestContext, failure: "interrupt-stage" | "fail-stage" | "fail-root" = "interrupt-stage") {
	const dir = fs.mkdtempSync(join(tmpdir(), "pi-stick-recovery-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const stub = join(dir, "model.mjs");
	fs.writeFileSync(
		stub,
		`import fs from 'node:fs';
		globalThis.fetch = async (_url, init) => {
			const messages = JSON.parse(init.body).messages;
			const task = messages.at(-1).content;
			const stage = messages.some(m => m.role === 'system' && m.content.includes('Sibling instructions')) ? 'sibling' : task.startsWith('first') ? 'A' : task.startsWith('second') ? 'B' : 'root';
			fs.writeFileSync(stage + '-prompt', task);
			const seen = fs.existsSync('requests') ? fs.readFileSync('requests', 'utf8') : '';
			fs.appendFileSync('requests', stage + '\\n');
			if (${failure === "fail-stage"} && stage === 'A' && !seen.includes('A')) return new Response('invalid request', {status: 400});
			if (${failure === "interrupt-stage"} && stage === 'B' && !seen.includes('B')) process.kill(process.pid, 'SIGKILL');
			if (${failure === "fail-root"} && stage === 'root') {
				if (messages.filter(m => m.role === 'user').length !== 1) throw Error('Duplicated root prompt');
				const calls = seen.split('\\n').filter(s => s === 'root').length;
				if (calls < 2) return new Response('invalid request', {status: 400});
				if (calls === 2) process.kill(process.pid, 'SIGKILL');
			}
			const data = { choices: [{index:0, delta:{role:'assistant',content:'answer-' + stage}, finish_reason:'stop'}] };
			return new Response('data: ' + JSON.stringify(data) + '\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
		};`,
	);
	const agent = {
		model: { provider: "groq", modelId: "llama-3.1-8b-instant" },
		instructions: "Respond briefly.",
		mode: "read-write",
		tools: [] as string[],
	};
	const job = {
		id: runId(),
		prompt: "task",
		credentials: { groq: { token: "test-only" } },
		orchestrator: { ...agent, name: "orchestrator" },
		agents: {
			worker: { ...agent, name: "worker" },
			sibling: { ...agent, name: "sibling", mode: "read-only", instructions: "Sibling instructions" },
		},
		stages: ["first", "second"].map((name) => ({
			name,
			prompt: name,
			parallel: name === "first" && failure === "fail-stage" ? ["worker", "sibling"] : ["worker"],
		})),
	};
	const run = () =>
		spawnSync(process.execPath, ["--import", stub, join(import.meta.dirname, "../agent-runtime.ts")], {
			cwd: dir,
			env: { ...process.env, PI_STICK_SESSIONS_DIR: dir, PI_STICK_SCRATCH_DIR: dir },
			input: `${JSON.stringify(job)}\n`,
			encoding: "utf8",
			timeout: 15000,
		});
	return { run, dir, job, stub };
}

test("resume aborts an interrupted delegate; only a fresh delegation runs", async (t) => {
	const { run, dir, job, stub } = stageFixture(t);
	job.stages = [];
	job.orchestrator.tools = ["delegate"];
	fs.writeFileSync(
		stub,
		`import fs from 'node:fs';
		globalThis.fetch = async (_url, init) => {
			const { messages } = JSON.parse(init.body);
			const prompt = messages.find(m => m.role === 'user').content;
			const results = messages.filter(m => m.role === 'tool');
			let delta = {role:'assistant', content:prompt};
			if (prompt !== 'task') {
				fs.appendFileSync('workers', prompt + '\\n');
				if (prompt === 'original') process.kill(process.pid, 'SIGKILL');
			} else if (results.length < 2) {
				if (results.length && !results[0].content.includes('delegate was interrupted')) throw Error('Expected interrupted delegate');
				const tasks = [{agent:'worker', prompt: results.length ? 'fresh' : 'original'}];
				delta = {role:'assistant', tool_calls:[{index:0,id:'call'+results.length,type:'function',function:{name:'delegate',arguments:JSON.stringify({tasks})}}]};
			} else delta.content = results[1].content;
			const data = {choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]};
			return new Response('data: ' + JSON.stringify(data) + '\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
		};`,
	);
	assert.equal(run().signal, "SIGKILL");
	const resumed = run();
	assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
	assert.match(JSON.parse(resumed.stdout.trim().split("\n").at(-1)!).report, /worker \(ok\)\s+fresh/);
	assert.equal(fs.readFileSync(join(dir, "workers"), "utf8"), "original\nfresh\n");
	// A fast orchestrator can exit before a ghost's retry timer fires. Check its durable outcome too.
	const storage = await openNodeSqliteStorage(join(dir, `${job.id}.sqlite`));
	try {
		const { items } = await storage.scanSubmissions({}, 10, undefined, BACKGROUND_CONTEXT);
		assert.deepEqual(
			items
				.filter((s) => s.requestId === undefined)
				.map((s) => (s.status === "unanswered" ? s.reason : s.status))
				.sort(),
			["aborted", "done"],
		);
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
});

test("an unavailable pinned subagent model fails explicitly before any model request", (t) => {
	const { job, run, dir } = stageFixture(t);
	job.agents.worker.model = { provider: "groq", modelId: "missing-model" };
	const result = run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Configured model unavailable for worker: groq\/missing-model/);
	assert.ok(!fs.existsSync(join(dir, "requests")));
});

test("after process death, resume restores the first stage's output and completes the second", async (t) => {
	const { run, dir, job } = stageFixture(t);
	const first = run();
	assert.equal(first.signal, "SIGKILL", first.stderr + first.stdout);
	const resumed = run();
	assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
	const result = JSON.parse(resumed.stdout.trim().split("\n").at(-1)!);
	const storage = await openNodeSqliteStorage(join(dir, `${job.id}.sqlite`));
	try {
		const conversations = await storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
		assert.equal(conversations.items.length, 3, "only the two stage conversations and the root should exist");
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
	assert.match(
		fs.readFileSync(join(dir, "B-prompt"), "utf8"),
		/Task context:\ntask[\s\S]*## Stage: first[\s\S]*answer-A/,
	);
	assert.equal(result.report, "answer-root");
	assert.equal(result.outputs.worker, "answer-A\n\n---\n\nanswer-B");
	assert.equal(fs.readFileSync(join(dir, "requests"), "utf8"), "A\nB\nB\nroot\n");
});

test("resume retries an unanswered root once and reattaches after interruption without replaying stages", (t) => {
	const { run, dir } = stageFixture(t, "fail-root");
	for (let i = 0; i < 2; i++) {
		const failed = run();
		assert.equal(failed.status, 1);
		assert.match(failed.stderr, /Task submission did not complete: unanswered: model_error/);
	}
	assert.equal(run().signal, "SIGKILL");
	for (let i = 0; i < 2; i++) {
		const resumed = run();
		assert.equal(resumed.status, 0, resumed.stderr);
		assert.equal(JSON.parse(resumed.stdout.trim().split("\n").at(-1)!).report, "answer-root");
	}
	assert.equal(fs.readFileSync(join(dir, "requests"), "utf8"), "A\nB\nroot\nroot\nroot\nroot\n");
});

test("resume resubmits an unanswered input that never entered the transcript", async (t) => {
	const { job, run, dir } = stageFixture(t);
	job.stages = [];
	const storage = await openNodeSqliteStorage(join(dir, `${job.id}.sqlite`));
	const h = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
	try {
		const root = await h.root(BACKGROUND_CONTEXT, { agent: { model: job.orchestrator.model } });
		await root.commit(
			(tx) =>
				tx.createSubmission({
					conversationId: root.id,
					requestId: job.id,
					type: "input",
					status: "unanswered",
					reason: "aborted",
				}),
			BACKGROUND_CONTEXT,
		);
	} finally {
		await h.close(BACKGROUND_CONTEXT);
	}
	const resumed = run();
	assert.equal(resumed.status, 0, resumed.stderr);
	assert.equal(fs.readFileSync(join(dir, "root-prompt"), "utf8"), job.prompt);
});

test("a failed required agent blocks downstream work; resume retries only the failed agent", (t) => {
	const { run, dir } = stageFixture(t, "fail-stage");
	const first = run();
	assert.equal(first.status, 1, first.stdout + first.stderr);
	assert.match(first.stdout, /Stage 'first' failed: worker/);
	assert.match(first.stdout, /unanswered: model_error/);
	const requests = () => fs.readFileSync(join(dir, "requests"), "utf8").trim().split("\n");
	assert.deepEqual(requests().sort(), ["A", "sibling"]);
	const resumed = run();
	assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
	assert.deepEqual(requests().slice(2), ["A", "B", "root"]);
	assert.match(fs.readFileSync(join(dir, "B-prompt"), "utf8"), /answer-A[\s\S]*answer-sibling/);
	assert.match(fs.readFileSync(join(dir, "root-prompt"), "utf8"), /answer-A[\s\S]*answer-sibling[\s\S]*answer-B/);
});
