import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { closed, runId } from "../src/platform.ts";

function stageFixture(
	t: TestContext,
	failure:
		| "interrupt-stage"
		| "interrupt-third"
		| "empty-final"
		| "empty-root"
		| "fail-stage"
		| "fail-root" = "interrupt-stage",
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
			const reminder = messages.at(-1).content.startsWith('Write the final report');
			const task = reminder ? messages.find(m => m.role === 'user').content : messages.at(-1).content;
			const stage = messages.some(m => m.role === 'system' && m.content.includes('Sibling instructions')) ? 'sibling' : task.startsWith('first') ? 'A' : task.startsWith('second') ? 'B' : task.startsWith('third') ? 'C' : 'root';
			fs.writeFileSync(stage + '-prompt', task);
			const seen = fs.existsSync('requests') ? fs.readFileSync('requests', 'utf8') : '';
			fs.appendFileSync('requests', stage + (reminder ? ':reminder' : '') + '\\n');
			if (${failure === "empty-final"} && reminder && !seen.includes(':reminder')) process.kill(process.pid, 'SIGKILL');
			if (${failure === "fail-stage"} && stage === 'A' && !seen.includes('A')) return new Response('invalid request', {status: 400});
			if (${failure === "interrupt-third"} && stage === 'C' && !seen.includes('C')) process.kill(process.pid, 'SIGKILL');
			if (${failure === "interrupt-stage"} && stage === 'B' && !seen.includes('B')) process.kill(process.pid, 'SIGKILL');
			if (${failure === "fail-root"} && stage === 'root') {
				if (messages.filter(m => m.role === 'user').length !== 1) throw Error('Duplicated root prompt');
				const calls = seen.split('\\n').filter(s => s === 'root').length;
				if (calls < 2) return new Response('invalid request', {status: 400});
				if (calls === 2) process.kill(process.pid, 'SIGKILL');
			}
			const data = { usage: {prompt_tokens:10,completion_tokens:2,total_tokens:12}, choices: [{index:0, delta:{role:'assistant',content:${failure === "empty-root"} || ${failure === "empty-final"} && stage === 'B' && !seen.includes('B') ? '   ' : 'answer-' + stage}, finish_reason:'stop'}] };
			return new Response('data: ' + JSON.stringify(data) + '\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
		};`,
	);
	const agent = {
		model: { provider: "groq", modelId: "openai/gpt-oss-20b" },
		instructions: "Respond briefly.",
		mode: "read-write",
		tools: [] as string[],
	};
	const id = runId();
	const job = {
		type: "run.v1",
		project: "demo",
		projectNotes: "Pinned project notes",
		services: ["runner"],
		contextFiles: ["ticket.txt"],
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
		const child = spawn(process.execPath, ["--import", stub, join(import.meta.dirname, "../runtime/main.ts")], {
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
		if (!corruptAfter) {
			createInterface({ input: child.stdout }).on("line", (line) => {
				const m = JSON.parse(line);
				if (m.type === "ps" || m.type === "check_clean") {
					const status = join(dir, "tracked-status");
					const text =
						m.type === "check_clean" && fs.existsSync(status) ? fs.readFileSync(status, "utf8") : (m.agent ?? "");
					child.stdin.write(
						`${JSON.stringify({ type: "response", id: m.id, command: m.type, success: true, data: { text } })}\n`,
					);
				}
			});
		}
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

test("runtime rejects an unsupported revision before starting a session", async (t) => {
	const { job, run } = stageFixture(t);
	const result = await run({ ...job, type: "run.v2" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /run revision/);
});

test("continue appends only changed prompt sections and keeps agent-specific context", async (t) => {
	const { job, run, dir } = stageFixture(t);
	job.stages = [{ name: "first", prompt: "first", parallel: ["sibling"] }];
	job.orchestrator.tools = ["delegate"];
	const followUp = { ...job, continueRun: true, prompt: "follow-up" };
	for (const payload of [
		job,
		{ ...followUp, requestId: runId() },
		{ ...followUp, requestId: runId(), contextFiles: ["ticket.txt", "new.md"] },
	]) {
		const result = await run(payload);
		assert.equal(result.status, 0, result.stdout + result.stderr);
	}
	const storage = await openNodeSqliteStorage(join(dir, `${job.id}.sqlite`));
	try {
		const { items: conversations } = await storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
		assert.equal(conversations.length, 2);
		for (const { id } of conversations) {
			const { items } = await storage.scanEntries(
				{ conversationId: id, order: "ascending" },
				40,
				undefined,
				BACKGROUND_CONTEXT,
			);
			const patches = items
				.flatMap((e) => e.model ?? [])
				.flatMap((m) => (m.role === "system" && m.sections ? [m.sections] : []));
			const [initial, ...updates] = patches;
			assert.match(initial["context-files"]!, /ticket\.txt/);
			assert.match(initial["project-notes"]!, /Pinned project notes/);
			assert.match(initial.services!, /runner/);
			if (id === ROOT_CONVERSATION_ID) {
				assert.match(initial.workspace!, /\/scratch\/orchestrator/);
				assert.match(initial.subagents!, /sibling/);
				assert.match(initial.instructions!, /Respond briefly/);
				assert.deepEqual(updates.map(Object.keys), [["context-files"]]);
				assert.match(updates[0]["context-files"]!, /new\.md/);
			} else {
				assert.match(initial.workspace!, /read-only.*\/scratch\/sibling/);
				assert.equal(initial.subagents, undefined);
				assert.match(initial.instructions!, /Sibling instructions/);
			}
		}
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
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

test("resume reuses an unparked delegate batch, then restores three settled workers while the fourth resumes", async (t) => {
	const { run, dir, job, stub } = stageFixture(t);
	job.stages = [];
	job.orchestrator.tools = ["delegate"];
	job.orchestrator.model.modelId = "openai/gpt-oss-120b";
	Object.assign(job.orchestrator, { thinkingLevel: "high" });
	const names = ["worker", "sibling", "third", "fourth"];
	const agents: Record<string, typeof job.agents.worker> = job.agents;
	for (const name of names)
		agents[name] = {
			...job.agents.sibling,
			name,
			model: job.orchestrator.model,
			mode: name === "worker" ? "read-write" : "read-only",
			tools: name === "fourth" ? ["write", "ps"] : [],
		};
	fs.writeFileSync(
		stub,
		`import fs from 'node:fs';
		import { Harness } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};
		const open = Harness.open;
		let settled = 0, fourthPending = false;
		const interruptFourth = () => {
			if (settled === 3 && fourthPending) {
				fs.writeFileSync('partial', '');
				process.kill(process.pid, 'SIGKILL');
			}
		};
		Harness.open = async (...args) => {
			const h = await open(...args);
			h.observeCommits({end() {}, advance({changes}) {
				for (const {type, value} of changes) {
					if (type === 'task' && value.kind === 'pi-stick.delegate-batch' && !fs.existsSync('unparked')) {
						fs.writeFileSync('unparked', '');
						process.kill(process.pid, 'SIGKILL');
					}
					if (type === 'submission' && value.status === 'done') { settled++; interruptFourth(); }
				}
			}});
			return h;
		};
		globalThis.fetch = async (_url, init) => {
			const { messages, reasoning_effort } = JSON.parse(init.body);
			const prompt = messages.find(m => m.role === 'user').content;
			if (reasoning_effort !== (prompt === 'task' ? 'high' : undefined)) throw Error('Unexpected inherited thinking level');
			let delta = {role:'assistant', content:prompt};
			if (prompt !== 'task') {
				const results = messages.filter(m => m.role === 'tool');
				if (!results.length) fs.appendFileSync('workers', prompt + '\\n');
				if (prompt === 'fourth' && !fs.existsSync('partial')) {
					fourthPending = true; interruptFourth(); await new Promise(() => {});
				}
				if (prompt === 'fourth' && !results.length) {
					const calls = [['write', {path:'blocked', content:'no'}], ['write', {path:'/scratch/fourth/note', content:'ok'}], ['ps', {}]];
					delta = {role:'assistant', tool_calls:calls.map(([name,args],index) => ({index,id:'call'+index,type:'function',function:{name,arguments:JSON.stringify(args)}}))};
				} else if (prompt === 'fourth' && (!results.some(r => r.content.includes('read-only')) || !results.some(r => r.content === 'fourth'))) {
					throw Error('Recovered worker used the wrong policy or RPC identity');
				}
			} else if (!messages.some(m => m.role === 'tool')) {
				const tasks = ${JSON.stringify(names)}.map(agent => ({agent, prompt:agent}));
				delta = {role:'assistant', tool_calls:[{index:0,id:'call',type:'function',function:{name:'delegate',arguments:JSON.stringify({tasks})}}]};
			} else delta.content = messages.at(-1).content;
			const data = {choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]};
			return new Response('data: ' + JSON.stringify(data) + '\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
		};`,
	);
	for (const marker of ["unparked", "partial"]) {
		const killed = await run();
		assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
		assert.ok(fs.existsSync(join(dir, marker)));
	}
	// Recovery must use the committed worker mode, not a fresh copy of the job spec.
	agents.fourth.mode = "read-write";
	const resumed = await run();
	assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
	assert.equal(fs.existsSync(join(dir, "blocked")), false);
	assert.equal(fs.readFileSync(join(dir, "fourth/note"), "utf8"), "ok");
	const { report, outputs } = JSON.parse(resumed.stdout.trim().split("\n").at(-1)!).data;
	assert.equal(report, names.map((name) => `### Agent: ${name} (ok)\n\n${name}`).join("\n\n"));
	assert.deepEqual(outputs, Object.fromEntries(names.map((name) => [name, name])));
	assert.deepEqual(
		fs.readFileSync(join(dir, "workers"), "utf8").trim().split("\n").sort(),
		[...names, "fourth"].sort(),
	);
	const storage = await openNodeSqliteStorage(join(dir, `${job.id}.sqlite`));
	try {
		const { items: batches } = await storage.scanTasks(
			{ kind: "pi-stick.delegate-batch" },
			10,
			undefined,
			BACKGROUND_CONTEXT,
		);
		assert.equal(batches.length, 1);
		const children = await storage.scanConversations(
			{ ownerTaskId: batches[0].id },
			10,
			undefined,
			BACKGROUND_CONTEXT,
		);
		assert.equal(children.items.length, names.length);
		const submissions = await storage.scanSubmissions({}, 10, undefined, BACKGROUND_CONTEXT);
		assert.equal(submissions.items.length, names.length + 1);
		assert.ok(submissions.items.every((s) => s.status === "done"));
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
});

for (const mode of ["stage", "delegate"]) {
	test(`one resume retries an unanswered worker in an interrupted ${mode} batch`, async (t) => {
		const { job, run, dir, stub } = stageFixture(t);
		const names = ["failed", "done", "pending"];
		for (const name of names)
			Object.assign(job.agents, { [name]: { ...job.agents.sibling, name, instructions: `batch-member:${name}` } });
		job.stages = mode === "stage" ? [{ name: "parallel", parallel: names, prompt: "work" }] : [];
		job.orchestrator.tools = mode === "delegate" ? ["delegate"] : [];
		fs.writeFileSync(
			stub,
			`import fs from 'node:fs';
			import { Harness } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};
			const resumed = fs.existsSync('interrupted');
			const open = Harness.open;
			let failed = false, done = false, pending = false;
			function interrupt() {
				if (!resumed && failed && done && pending) {
					fs.writeFileSync('interrupted', '');
					process.kill(process.pid, 'SIGKILL');
				}
			}
			Harness.open = async (...args) => {
				const h = await open(...args);
				h.observeCommits({end() {}, advance({changes}) {
					for (const {type, value} of changes) if (type === 'submission' && value.requestId === 'work') {
						failed ||= value.status === 'unanswered'; done ||= value.status === 'done'; interrupt();
					}
				}});
				return h;
			};
			globalThis.fetch = async (_url, init) => {
				const {messages} = JSON.parse(init.body);
				const name = messages.filter(m => m.role === 'system').map(m => m.content).join(' ').match(/batch-member:(\\w+)/)?.[1];
				let delta = {role:'assistant', content:name ?? 'report'};
				if (name) {
					fs.appendFileSync('requests', name + '\\n');
					if (messages.filter(m => m.role === 'user').length !== 1) throw Error('Duplicated worker input');
					if (!resumed && name === 'failed') return new Response('model error', {status:400});
					if (!resumed && name === 'pending') { pending = true; interrupt(); await new Promise(() => {}); }
				} else if (${mode === "delegate"} && !messages.some(m => m.role === 'tool')) {
					const tasks = ${JSON.stringify(names)}.map(agent => ({agent, prompt:'work'}));
					delta = {role:'assistant', tool_calls:[{index:0,id:'batch',type:'function',function:{name:'delegate',arguments:JSON.stringify({tasks})}}]};
				}
				const data = {choices:[{index:0, delta, finish_reason:delta.tool_calls?'tool_calls':'stop'}]};
				return new Response('data: ' + JSON.stringify(data) + '\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
			};`,
		);
		const interrupted = await run();
		assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr + interrupted.stdout);
		const resumed = await run();
		assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
		assert.deepEqual(
			JSON.parse(resumed.stdout.trim().split("\n").at(-1)!).data.outputs,
			Object.fromEntries(names.map((name) => [name, name])),
		);
		assert.deepEqual(fs.readFileSync(join(dir, "requests"), "utf8").trim().split("\n").sort(), [
			"done",
			"failed",
			"failed",
			"pending",
			"pending",
		]);
	});
}

test("same-turn delegates run sequentially, survive resume once, and do not carry into continue", async (t) => {
	const { run, dir, job, stub } = stageFixture(t);
	job.stages = [];
	job.orchestrator.tools = ["delegate"];
	fs.writeFileSync(
		stub,
		`import fs from 'node:fs';
		globalThis.fetch = async (_url, init) => {
			const { messages } = JSON.parse(init.body);
			const prompt = messages.filter(m => m.role === 'user').at(-1).content;
			const results = messages.filter(m => m.role === 'tool');
			let delta = {role:'assistant', content:'done'};
			if (prompt.startsWith('worker-')) {
				fs.appendFileSync('workers', prompt + '\\n');
				delta.content = prompt;
			} else if (prompt === 'task' && !results.length) {
				const tool_calls = [0, 1].map(index => ({index, id:'call'+index, type:'function', function:{
					name:'delegate', arguments:JSON.stringify({tasks:[{agent:'worker', prompt:'worker-'+index}]})
				}}));
				delta = {role:'assistant', tool_calls};
			} else if (!fs.existsSync('interrupted')) {
				fs.writeFileSync('interrupted', '1');
				process.kill(process.pid, 'SIGKILL');
			}
			const data = {choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]};
			return new Response('data: ' + JSON.stringify(data) + '\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
		};`,
	);
	const first = await run();
	assert.equal(first.signal, "SIGKILL", first.stderr + first.stdout);
	const lifecycle = first.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((e) => e.agent === "agent:worker" && ["started", "completed"].includes(e.message));
	assert.deepEqual(
		lifecycle.map((e) => e.message),
		["started", "completed", "started", "completed"],
	);
	const resumed = await run();
	assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
	assert.deepEqual(JSON.parse(resumed.stdout.trim().split("\n").at(-1)!).data.outputs, {
		worker: "worker-0\n\n---\n\nworker-1",
	});
	const next = await run({ ...job, requestId: runId(), continueRun: true, prompt: "follow-up" });
	assert.equal(next.status, 0, next.stderr + next.stdout);
	assert.equal(JSON.parse(next.stdout.trim().split("\n").at(-1)!).data.outputs, undefined);
	assert.equal(fs.readFileSync(join(dir, "workers"), "utf8"), "worker-0\nworker-1\n");
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
	const interrupted = await run(payload);
	assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
	const { provider, modelId } = job.agents.worker.model;
	const model = `${provider}/${modelId}`;
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
	assert.equal(fs.readFileSync(join(dir, "requests"), "utf8"), "A\nB\nB:reminder\nB:reminder\n");
	const storage = await openNodeSqliteStorage(join(dir, `${job.id}.sqlite`));
	try {
		const conversations = await storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
		let reminders = 0;
		for (const { id } of conversations.items) {
			const entries = await storage.scanEntries({ conversationId: id }, 100, undefined, BACKGROUND_CONTEXT);
			reminders += entries.items
				.flatMap((e) => e.model ?? [])
				.filter(
					(m) =>
						m.role === "user" && typeof m.content === "string" && m.content.startsWith("Write the final report"),
				).length;
		}
		assert.equal(reminders, 1);
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
});

test("only mandatory reports get a reminder; a second empty answer fails without another request", async (t) => {
	const { dir, run } = stageFixture(t, "empty-root");
	for (let i = 0; i < 2; i++) {
		const failed = await run();
		assert.equal(failed.status, 1);
		assert.match(failed.stdout, /orchestrator returned an empty report after one reminder/);
	}
	assert.equal(fs.readFileSync(join(dir, "requests"), "utf8"), "A\nB\nroot\nroot:reminder\n");
});

test("resume retries an unanswered root once and reattaches after interruption without replaying stages", async (t) => {
	const { run, dir } = stageFixture(t, "fail-root");
	for (let i = 0; i < 2; i++) {
		const failed = await run();
		assert.equal(failed.status, 1);
		assert.equal(
			JSON.parse(failed.stdout.trim().split("\n").at(-1)!).error,
			"orchestrator submission did not complete: model_error",
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

test("follow reports retry and compaction transitions once per conversation without provider text", async (t) => {
	const { job, run, stub } = stageFixture(t);
	job.stages.length = 1;
	fs.appendFileSync(
		stub,
		`
		import { Harness } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};
		const open = Harness.open;
		Harness.open = async (...args) => {
			const h = await open(...args);
			h.observeDoc = async (_doc, _id, observer) => {
				const live = {generation:{attempt:1, retry:{at: Date.now()+5000, error:'private-fixture'}}, compactions:[{taskId:2}]};
				for (let i=0;i<2;i++) observer.advance({kind:'value', value:live});
				return {value: {}, detach() {}};
			};
			return h;
		};`,
	);
	const result = await run();
	assert.equal(result.status, 0, result.stderr);
	const events = result.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	for (const agent of ["agent:worker", "orchestrator"]) {
		const lines = events.filter((e) => e.agent === agent).map((e) => e.message);
		assert.equal(lines.filter((line) => line.startsWith("Model retry in")).length, 1);
		assert.equal(lines.filter((line) => line === "Compacting context").length, 1);
	}
	assert.doesNotMatch(result.stdout + result.stderr, /private-fixture/);
});

test("read-only root keeps its tracked baseline across interruption and starts fresh on continue", async (t) => {
	const { job, run, stub } = stageFixture(t);
	job.stages = [];
	job.orchestrator.mode = "read-only";
	fs.appendFileSync(
		stub,
		`
		const respond = globalThis.fetch;
		globalThis.fetch = (...args) => {
			if (!fs.existsSync('tracked-status')) {
				fs.writeFileSync('tracked-status', ' M tracked.txt');
				process.kill(process.pid, 'SIGKILL');
			}
			return respond(...args);
		};`,
	);
	assert.equal((await run()).signal, "SIGKILL");
	const resumed = await run();
	assert.equal(resumed.status, 0, resumed.stderr);
	assert.equal(resumed.stdout.match(/"type":"check_clean"/g)?.length, 1);
	assert.match(resumed.stdout, /Tracked repository files changed during read-only round 'orchestrator'/);
	const continued = await run({ ...job, continueRun: true, requestId: runId() });
	assert.equal(continued.status, 0, continued.stderr);
	assert.equal(continued.stdout.match(/"type":"check_clean"/g)?.length, 2);
	assert.doesNotMatch(continued.stdout, /WARNING:/);
	job.orchestrator.tools = ["delegate"];
	const delegated = await run({ ...job, continueRun: true, requestId: runId() });
	assert.equal(delegated.status, 0, delegated.stderr);
	assert.doesNotMatch(delegated.stdout, /"type":"check_clean"/);
});

test("unexpected action exceptions log only a safe category and runtime location", async (t) => {
	const { job, run, stub } = stageFixture(t);
	job.stages = [];
	fs.writeFileSync(
		stub,
		`import { Harness } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};
 const open = Harness.open;
 Harness.open = async (...args) => {
   args[1].onReport({ kind: "task_interrupted", reason: "restart_limit", restarts: 5, error: new Error("private-fixture-report") });
   const h = await open(...args); h.root = () => {
   throw Object.assign(new TypeError("failure\\nprivate-fixture-message"), { name: "private-fixture-name", code: "private-fixture-code" });
 }; return h; };`,
	);
	const failed = await run();
	assert.equal(failed.status, 1);
	const msg = JSON.parse(failed.stdout.trim().split("\n").at(-1)!);
	assert.equal(msg.success, false);
	assert.equal(msg.error, "Action failed");
	assert.match(failed.stderr, /Durable task_interrupted: restart_limit \(restarts: 5\)/);
	assert.match(failed.stderr, /^Unexpected TypeError at runtime\/main\.ts:\d+:\d+$/m);
	assert.doesNotMatch(failed.stdout, /Unexpected TypeError|runtime\/main\.ts/);
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
	assert.match(first.stdout, /submission did not complete: model_error/);
	const requests = () => fs.readFileSync(join(dir, "requests"), "utf8").trim().split("\n");
	assert.deepEqual(requests().sort(), ["A", "sibling"]);
	const resumed = await run();
	assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
	assert.deepEqual(requests().slice(2), ["A", "B", "root"]);
	assert.match(fs.readFileSync(join(dir, "B-prompt"), "utf8"), /answer-A[\s\S]*answer-sibling/);
	assert.match(fs.readFileSync(join(dir, "root-prompt"), "utf8"), /answer-A[\s\S]*answer-sibling[\s\S]*answer-B/);
});
