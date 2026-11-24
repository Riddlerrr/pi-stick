import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { closed, runId } from "../src/platform.ts";

function stageFixture(
	t: TestContext,
	failure: "interrupt-stage" | "interrupt-third" | "empty-final" | "fail-stage" | "fail-root" = "interrupt-stage",
) {
	const dir = fs.mkdtempSync(join(tmpdir(), "pi-stick-recovery-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const stub = join(dir, "model.mjs");
	fs.writeFileSync(
		stub,
		`import fs from 'node:fs';
		globalThis.fetch = async (_url, init) => {
			const { messages, reasoning_effort } = JSON.parse(init.body);
			if (reasoning_effort) fs.appendFileSync('effort', reasoning_effort + '\\n');
			const task = messages.at(-1).content;
			const stage = messages.some(m => m.role === 'system' && m.content.includes('Sibling instructions')) ? 'sibling' : task.startsWith('first') ? 'A' : task.startsWith('second') ? 'B' : task.startsWith('third') ? 'C' : 'root';
			fs.writeFileSync(stage + '-prompt', task);
			const seen = fs.existsSync('requests') ? fs.readFileSync('requests', 'utf8') : '';
			fs.appendFileSync('requests', stage + '\\n');
			if (${failure === "fail-stage"} && stage === 'A' && !seen.includes('A')) return new Response('invalid request', {status: 400});
			if (${failure === "interrupt-third"} && stage === 'C' && !seen.includes('C')) process.kill(process.pid, 'SIGKILL');
			if (${failure === "interrupt-stage"} && stage === 'B' && !seen.includes('B')) process.kill(process.pid, 'SIGKILL');
			if (${failure === "fail-root"} && stage === 'root') {
				if (messages.filter(m => m.role === 'user').length !== 1) throw Error('Duplicated root prompt');
				const calls = seen.split('\\n').filter(s => s === 'root').length;
				if (calls < 2) return new Response('invalid request', {status: 400});
				if (calls === 2) process.kill(process.pid, 'SIGKILL');
			}
			const data = { usage: {prompt_tokens:10,completion_tokens:2,total_tokens:12}, choices: [{index:0, delta:{role:'assistant',content:${failure === "empty-final"} && stage === 'B' && !seen.includes('B') ? '   ' : 'answer-' + stage}, finish_reason:'stop'}] };
			return new Response('data: ' + JSON.stringify(data) + '\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
		};`,
	);
	const agent = {
		model: { provider: "groq", modelId: "llama-3.1-8b-instant" },
		instructions: "Respond briefly.",
		mode: "read-write",
		tools: [] as string[],
	};
	const id = runId();
	const job = {
		type: "run.v2",
		id,
		models: {},
		requestId: id,
		continueRun: false,
		prompt: "task",
		credentials: { groq: { token: "test-only", validUntil: 1 } },
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
	const run = async (payload: unknown = job, workspace = dir, corruptAfter?: RegExp) => {
		const child = spawn(process.execPath, ["--import", stub, join(import.meta.dirname, "../agent-runtime.ts")], {
			cwd: dir,
			env: {
				...process.env,
				PI_STICK_SESSIONS_DIR: dir,
				PI_STICK_SCRATCH_DIR: dir,
				PI_STICK_WORKSPACE_DIR: workspace,
			},
			timeout: 15000,
		});
		const exit = closed(child);
		let stdout = "",
			stderr = "";
		const corrupt = (output: string) => {
			if (corruptAfter?.test(output)) {
				corruptAfter = undefined;
				child.stdin.write("private-fixture-not-json\n");
			}
		};
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			corrupt(stdout);
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			corrupt(stderr);
		});
		child.stdin.write(`${JSON.stringify(payload)}\n`);
		const [status, signal] = await exit;
		return { status, signal, stdout, stderr };
	};
	return { run, dir, job, stub };
}

test("runtime rejects an old launcher before starting a session", async (t) => {
	const { job, run } = stageFixture(t);
	const result = await run({ ...job, type: "run.v1" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /run revision/);
});

for (const pending of [true, false]) {
	test(`invalid host reply shuts down cleanly with ${pending ? "an outstanding RPC" : "no pending RPC"}`, async (t) => {
		const { dir, job, stub, run } = stageFixture(t);
		// Mark completed cleanup, not merely a nonzero exit from an uncaught exception.
		fs.writeFileSync(
			stub,
			`import { Harness } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};
			const open = Harness.open;
			Harness.open = async (...args) => {
				const h = await open(...args);
				const close = h.close.bind(h);
				h.close = async (...args) => { await close(...args); console.error('harness closed'); };
				return h;
			};
			globalThis.fetch = async (_url, init) => {
				console.error('model waiting');
				await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once:true}));
			};`,
		);
		const result = await run(
			pending ? { type: job.type, id: job.id, check: true, models: {}, credentials: {} } : job,
			dir,
			pending ? /"type":"ps"/ : /model waiting/,
		);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /Invalid agent protocol/);
		assert.match(result.stderr, /harness closed/);
		assert.doesNotMatch(result.stderr + result.stdout, /private-fixture|"success":true/);
	});
}

test("runtime requires a real checkout directory", async (t) => {
	const { dir, job, run } = stageFixture(t);
	const workspace = join(dir, "workspace");
	const repo = join(workspace, "repo");
	fs.mkdirSync(workspace);
	for (const linked of [false, true]) {
		if (linked) fs.symlinkSync(dir, repo);
		const result = await run(job, repo);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /Expected a real checkout directory/);
		assert.equal(result.stdout, "");
	}
	assert.ok(!fs.existsSync(join(dir, `${job.id}.sqlite`)));
});

test("delegate rejects a repeated agent before dispatch, even with different prompts", async (t) => {
	const { job, run, stub } = stageFixture(t);
	job.stages = [];
	job.orchestrator.tools = ["delegate"];
	fs.writeFileSync(
		stub,
		`globalThis.fetch = async (_url, init) => {
		const { messages } = JSON.parse(init.body);
		if (messages.find(m => m.role === 'user').content !== 'task') throw Error('Unexpected worker request');
		const result = messages.find(m => m.role === 'tool');
		const tasks = ['first', 'second'].map(prompt => ({agent:'sibling', prompt}));
		const delta = result ? {role:'assistant',content:result.content} : {role:'assistant',tool_calls:[{index:0,id:'call',type:'function',function:{name:'delegate',arguments:JSON.stringify({tasks})}}]};
		const data = {choices:[{index:0,delta,finish_reason:result?'stop':'tool_calls'}]};
		return new Response('data: ' + JSON.stringify(data) + '\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
	};`,
	);
	const result = await run();
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(
		JSON.parse(result.stdout.trim().split("\n").at(-1)!).data.report,
		/Batch 'delegate' repeats agent 'sibling'/,
	);
});

test("resume aborts an interrupted delegate; only a fresh delegation runs", async (t) => {
	const { run, dir, job, stub } = stageFixture(t);
	job.stages = [];
	job.orchestrator.tools = ["delegate"];
	job.orchestrator.model.modelId = "openai/gpt-oss-120b";
	job.agents.worker.model = job.orchestrator.model;
	Object.assign(job.orchestrator, { thinkingLevel: "high" });
	fs.writeFileSync(
		stub,
		`import fs from 'node:fs';
		globalThis.fetch = async (_url, init) => {
			const { messages, reasoning_effort } = JSON.parse(init.body);
			const prompt = messages.find(m => m.role === 'user').content;
			if (reasoning_effort !== (prompt === 'task' ? 'high' : undefined)) throw Error('Unexpected inherited thinking level');
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
	assert.equal((await run()).signal, "SIGKILL");
	const resumed = await run();
	assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
	assert.match(JSON.parse(resumed.stdout.trim().split("\n").at(-1)!).data.report, /worker \(ok\)\s+fresh/);
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

test("unsupported thinking levels fail before a request; valid levels reach each agent", async (t) => {
	const { job, run, dir } = stageFixture(t);
	const model = { provider: "groq", modelId: "openai/gpt-oss-120b" };
	const payload = {
		...job,
		stages: job.stages.slice(0, 1),
		orchestrator: { ...job.orchestrator, model, thinkingLevel: "high" },
		agents: { ...job.agents, worker: { ...job.agents.worker, model, thinkingLevel: "off" } },
	};
	const failed = await run(payload);
	assert.equal(failed.status, 1);
	assert.match(failed.stdout, /worker: groq\/openai\/gpt-oss-120b does not support thinkingLevel/);
	assert.ok(!fs.existsSync(join(dir, "requests")));
	payload.agents.worker.thinkingLevel = "low";
	const result = await run(payload);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.readFileSync(join(dir, "effort"), "utf8"), "low\nhigh\n");
});

test("an unavailable pinned subagent model fails explicitly before any model request", async (t) => {
	const { job, run, dir } = stageFixture(t);
	job.agents.worker.model = { provider: "groq", modelId: "missing-model" };
	const result = await run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Configured model unavailable for worker: groq\/missing-model/);
	assert.ok(!fs.existsSync(join(dir, "requests")));
});

test("after process death, resume restores the first stage's output and completes the second", async (t) => {
	const { run, dir, job } = stageFixture(t);
	const first = await run();
	assert.equal(first.signal, "SIGKILL", first.stderr + first.stdout);
	const resumed = await run();
	assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
	const result = JSON.parse(resumed.stdout.trim().split("\n").at(-1)!).data;
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

for (const stageContext of [undefined, "all"] as const) {
	test(`resume hands the third stage ${stageContext ?? "previous"} results without rerunning earlier stages`, async (t) => {
		const { job, run, dir } = stageFixture(t, "interrupt-third");
		if (stageContext) Object.assign(job, { stageContext });
		job.stages.push({ name: "third", prompt: "third", parallel: ["worker"] });
		assert.equal((await run()).signal, "SIGKILL");
		const resumed = await run();
		assert.equal(resumed.status, 0, resumed.stderr);
		const prompt = fs.readFileSync(join(dir, "C-prompt"), "utf8");
		assert.match(prompt, /Task context:\ntask[\s\S]*answer-B/);
		if (stageContext === "all") assert.match(prompt, /answer-A[\s\S]*answer-B/);
		else assert.doesNotMatch(prompt, /answer-A/);
		assert.match(fs.readFileSync(join(dir, "root-prompt"), "utf8"), /answer-A[\s\S]*answer-B[\s\S]*answer-C/);
		assert.equal(fs.readFileSync(join(dir, "requests"), "utf8"), "A\nB\nC\nC\nroot\n");
	});
}

test("a final-stage report retries an empty answer, then restores without synthesis", async (t) => {
	const { job, dir, run } = stageFixture(t, "empty-final");
	const payload = { ...job, orchestrator: undefined };
	const failed = await run(payload);
	assert.equal(failed.status, 1);
	assert.match(failed.stdout, /returned an empty report/);
	const model = "groq/llama-3.1-8b-instant";
	const partial = JSON.parse(failed.stdout.trim().split("\n").at(-1)!).data;
	assert.equal(partial.report, undefined);
	assert.equal(partial.usage.models[model].totalTokens, 24);
	for (let i = 0; i < 2; i++) {
		const result = await run(payload);
		assert.equal(result.status, 0, result.stderr);
		const { report, outputs, usage } = JSON.parse(result.stdout.trim().split("\n").at(-1)!).data;
		assert.equal(usage.models[model].totalTokens, 36);
		assert.ok(usage.models[model].cost.total > 0);
		assert.deepEqual(usage.tools, {});
		assert.equal(report, "answer-B");
		assert.equal(outputs.worker, "answer-A\n\n---\n\nanswer-B");
	}
	assert.equal(fs.readFileSync(join(dir, "requests"), "utf8"), "A\nB\nB\n");
});

test("resume retries an unanswered root once and reattaches after interruption without replaying stages", async (t) => {
	const { run, dir } = stageFixture(t, "fail-root");
	for (let i = 0; i < 2; i++) {
		const failed = await run();
		assert.equal(failed.status, 1);
		assert.equal(
			JSON.parse(failed.stdout.trim().split("\n").at(-1)!).error,
			"Orchestrator submission did not complete: unanswered",
		);
	}
	assert.equal((await run()).signal, "SIGKILL");
	for (let i = 0; i < 2; i++) {
		const resumed = await run();
		assert.equal(resumed.status, 0, resumed.stderr);
		assert.equal(JSON.parse(resumed.stdout.trim().split("\n").at(-1)!).data.report, "answer-root");
	}
	assert.equal(fs.readFileSync(join(dir, "requests"), "utf8"), "A\nB\nroot\nroot\nroot\nroot\n");
});

test("unexpected action exceptions do not expose their detail in the failure response", async (t) => {
	const { job, run, stub } = stageFixture(t);
	job.stages = [];
	fs.writeFileSync(
		stub,
		`import { Harness } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};
 const open = Harness.open;
 Harness.open = async (...args) => { const h = await open(...args); h.root = () => {throw Error("private-fixture")}; return h; };`,
	);
	const failed = await run();
	assert.equal(failed.status, 1);
	const msg = JSON.parse(failed.stdout.trim().split("\n").at(-1)!);
	assert.equal(msg.success, false);
	assert.equal(msg.error, "Action failed");
	assert.doesNotMatch(failed.stderr + failed.stdout, /private-fixture/);
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
	const resumed = await run();
	assert.equal(resumed.status, 0, resumed.stderr);
	assert.equal(fs.readFileSync(join(dir, "root-prompt"), "utf8"), job.prompt);
});

test("a failed required agent blocks downstream work; resume retries only the failed agent", async (t) => {
	const { run, dir } = stageFixture(t, "fail-stage");
	const first = await run();
	assert.equal(first.status, 1, first.stdout + first.stderr);
	assert.equal(JSON.parse(first.stdout.trim().split("\n").at(-1)!).error, "Stage 'first' failed: worker");
	assert.match(first.stdout, /unanswered: model_error/);
	const requests = () => fs.readFileSync(join(dir, "requests"), "utf8").trim().split("\n");
	assert.deepEqual(requests().sort(), ["A", "sibling"]);
	const resumed = await run();
	assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
	assert.deepEqual(requests().slice(2), ["A", "B", "root"]);
	assert.match(fs.readFileSync(join(dir, "B-prompt"), "utf8"), /answer-A[\s\S]*answer-sibling/);
	assert.match(fs.readFileSync(join(dir, "root-prompt"), "utf8"), /answer-A[\s\S]*answer-sibling[\s\S]*answer-B/);
});
