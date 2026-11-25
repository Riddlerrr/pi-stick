import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { AgentExecutionEnv } from "../runtime/tools/agent-execution-env.ts";
import { createBashTool } from "../runtime/tools/bash.ts";

test("AgentExecutionEnv refuses both shell strings and argv without a broker", async () => {
	const env = new AgentExecutionEnv("worker", () => assert.fail("direct exec should not resolve paths"));
	for (const command of ["true", ["true"]]) {
		const result = await env.exec(command, undefined, BACKGROUND_CONTEXT);
		assert.ok(!result.ok);
		assert.equal(result.error.code, "shell_unavailable");
	}
});

test("bash routes service, timeout and cancellation to the broker and streams split UTF-8", async () => {
	const signal = new AbortController().signal;
	const args = { command: "example", service: "web", timeout: 3 };
	const tool = createBashTool(async (request, agent, chunk, cancel) => {
		assert.deepEqual(request, args);
		assert.equal(agent, "worker");
		assert.equal(cancel, signal);
		const bytes = Buffer.from("до");
		chunk(bytes.subarray(0, 1));
		chunk(bytes.subarray(1));
		return { text: "", exitCode: 7 };
	});
	let text = "";
	const api = {
		env: new AgentExecutionEnv("worker", () => assert.fail("short output should not spill")),
		output(s: string) {
			text += s;
		},
		retainedOutput: () => ({ text, truncated: false }),
	} as unknown as Parameters<typeof tool.execute>[1];
	const result = await tool.execute(args, api, withAbortSignal(signal, BACKGROUND_CONTEXT));
	assert.deepEqual(result.structuredOutput, { output: "до", exitCode: 7, truncated: false });
});

for (const brokerFailed of [false, true]) {
	test(`bash spills raw bytes when a final UTF-8 replacement crosses the limit (brokerFailed=${brokerFailed})`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "pi-stick-bash-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const bytes = Buffer.alloc(50 * 1024, "a");
		bytes[bytes.length - 1] = 0xc2;
		const tool = createBashTool(async (_args, _id, emit) => {
			emit(bytes);
			if (brokerFailed) throw Error("broker disconnected");
			return { text: "", exitCode: 0 };
		});
		let text = "";
		const diagnostics: string[] = [];
		const api = {
			env: new AgentExecutionEnv("worker", () => dir),
			output(s: string) {
				text += s;
			},
			retainedOutput: () => ({ text: text.slice(-1), truncated: Buffer.byteLength(text) > 50 * 1024 }),
			diagnostic(d: { message: string }) {
				diagnostics.push(d.message);
			},
		} as unknown as Parameters<typeof tool.execute>[1];
		const call = tool.execute({ command: "example" }, api, BACKGROUND_CONTEXT);
		const result = brokerFailed ? await assert.rejects(call, /broker disconnected/) : await call;
		const [name] = await readdir(dir);
		assert.ok(name, "expected a scratch log");
		const path = join(dir, name);
		assert.ok(diagnostics.some((message) => message.includes(path)));
		if (result)
			assert.deepEqual(result.structuredOutput, { output: "�", truncated: true, exitCode: 0, fullOutputPath: path });
		assert.ok(text.endsWith("�"));
		assert.deepEqual(await readFile(path), bytes);
	});
}

for (const [name, chunks, capped] of [
	["line spill", [Buffer.from("row\n".repeat(2000)), Buffer.from("last")], false],
	["32 MiB spill", Array<Buffer>(32).fill(Buffer.alloc(1024 * 1024, "a")), false],
	["overflow", [...Array<Buffer>(32).fill(Buffer.alloc(1024 * 1024, "a")), Buffer.from("last")], true],
] as const) {
	test(`bash scratch log: ${name}`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "pi-stick-bash-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const tool = createBashTool(async (_args, _id, emit) => {
			for (const chunk of chunks) emit(chunk);
			return { text: "", exitCode: 0 };
		});
		const warnings: string[] = [];
		let tail = "";
		const api = {
			env: new AgentExecutionEnv("worker", (path, write) => {
				assert.equal(path, "/scratch/worker");
				assert.equal(write, true);
				return dir;
			}),
			output(s: string) {
				tail = s.slice(-4);
			},
			retainedOutput: () => ({ text: tail, truncated: true }),
			diagnostic(d: { severity: string; message: string }) {
				if (d.severity === "warn") warnings.push(d.message);
			},
		} as unknown as Parameters<typeof tool.execute>[1];
		const result = await tool.execute({ command: "example" }, api, BACKGROUND_CONTEXT);
		const files = await readdir(dir);
		assert.equal(files.length, 1);
		const path = join(dir, files[0]);
		assert.deepEqual(result.structuredOutput, {
			output: tail,
			exitCode: 0,
			truncated: true,
			...(capped ? {} : { fullOutputPath: path }),
		});
		if (name === "line spill") assert.deepEqual(await readFile(path), Buffer.concat(chunks));
		else assert.equal((await stat(path)).size, 32 * 1024 * 1024);
		if (capped) assert.equal(tail, "last");
		assert.deepEqual(warnings, capped ? [`Log limited to the first 32 MiB: ${path}`] : []);
	});
}
