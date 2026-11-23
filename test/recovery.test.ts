import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { runId } from "../src/platform.ts";

function stageFixture(t: TestContext, failFirst = false) {
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
			if (${failFirst} && stage === 'A' && !seen.includes('A')) return new Response('invalid request', {status: 400});
			if (!${failFirst} && stage === 'B' && !seen.includes('B')) process.kill(process.pid, 'SIGKILL');
			const data = { choices: [{index:0, delta:{role:'assistant',content:'answer-' + stage}, finish_reason:'stop'}] };
			return new Response('data: ' + JSON.stringify(data) + '\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
		};`,
	);
	const agent = {
		model: { provider: "groq", modelId: "llama-3.1-8b-instant" },
		instructions: "Respond briefly.",
		mode: "read-write",
		tools: [],
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
			parallel: name === "first" && failFirst ? ["worker", "sibling"] : ["worker"],
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
	return { run, dir, job };
}

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

test("a failed required agent blocks downstream work; resume retries only the failed agent", (t) => {
	const { run, dir } = stageFixture(t, true);
	const first = run();
	assert.equal(first.status, 1, first.stdout + first.stderr);
	assert.match(first.stdout, /Stage 'first' failed: worker/);
	const requests = () => fs.readFileSync(join(dir, "requests"), "utf8").trim().split("\n");
	assert.deepEqual(requests().sort(), ["A", "sibling"]);
	const resumed = run();
	assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
	assert.deepEqual(requests().slice(2), ["A", "B", "root"]);
	assert.match(fs.readFileSync(join(dir, "B-prompt"), "utf8"), /answer-A[\s\S]*answer-sibling/);
	assert.match(fs.readFileSync(join(dir, "root-prompt"), "utf8"), /answer-A[\s\S]*answer-sibling[\s\S]*answer-B/);
});
