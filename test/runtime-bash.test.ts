import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createBashTool } from "../runtime-tools/bash.ts";

test("bash routes service, timeout and cancellation to the broker and streams split UTF-8", async () => {
	const signal = new AbortController().signal;
	const args = { command: "example", service: "web", timeout: 3 };
	const tool = createBashTool(
		async (request, id, chunk, cancel) => {
			assert.deepEqual(request, args);
			assert.equal(id, ROOT_CONVERSATION_ID);
			assert.equal(cancel, signal);
			const bytes = Buffer.from("до");
			chunk(bytes.subarray(0, 1));
			chunk(bytes.subarray(1));
			return { text: "", exitCode: 7 };
		},
		() => assert.fail("short output should not spill"),
	);
	let text = "";
	const api = {
		conversationId: ROOT_CONVERSATION_ID,
		output(s: string) {
			text += s;
		},
		retainedOutput: () => ({ text, truncated: false }),
	} as Parameters<typeof tool.execute>[1];
	const result = await tool.execute(args, api, withAbortSignal(signal, BACKGROUND_CONTEXT));
	assert.deepEqual(result.structuredOutput, { output: "до", exitCode: 7, truncated: false });
});

for (const [name, chunks, capped] of [
	["line spill", [Buffer.from("row\n".repeat(2000)), Buffer.from("last")], false],
	["32 MiB spill", Array<Buffer>(32).fill(Buffer.alloc(1024 * 1024, "a")), false],
	["overflow", [...Array<Buffer>(32).fill(Buffer.alloc(1024 * 1024, "a")), Buffer.from("last")], true],
] as const) {
	test(`bash scratch log: ${name}`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "pi-stick-bash-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const tool = createBashTool(
			async (_args, _id, emit) => {
				for (const chunk of chunks) emit(chunk);
				return { text: "", exitCode: 0 };
			},
			(id) => {
				assert.equal(id, ROOT_CONVERSATION_ID);
				return dir;
			},
		);
		const warnings: string[] = [];
		let tail = "";
		const api = {
			conversationId: ROOT_CONVERSATION_ID,
			output(s: string) {
				tail = s.slice(-4);
			},
			retainedOutput: () => ({ text: tail, truncated: true }),
			diagnostic(d: { severity: string; message: string }) {
				if (d.severity === "warn") warnings.push(d.message);
			},
		} as Parameters<typeof tool.execute>[1];
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
