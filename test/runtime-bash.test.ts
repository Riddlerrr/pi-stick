import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createBashTool } from "../runtime-tools/bash.ts";

for (const [label, text, spill, truncated] of [
	["line limit", "é\n".repeat(2000), false, false],
	["extra line", "é\n".repeat(2000) + "a", true, false],
	["byte limit", "é".repeat(25600), false, false],
	["extra byte", "é".repeat(25600) + "a", true, false],
	["codemode limit", "é".repeat(600000), true, true],
] as const) {
	test(`bash streams UTF-8 and preserves full output: ${label}`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "pi-stick-bash-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const tool = createBashTool(
			async (_args, _id, chunk) => {
				const bytes = Buffer.from(text);
				chunk(bytes.subarray(0, 1));
				chunk(bytes.subarray(1));
				return { text: "", exitCode: 7 };
			},
			() => dir,
		);
		let streamed = "";
		const diagnostics: string[] = [];
		const api = {
			conversationId: ROOT_CONVERSATION_ID,
			output(s: string) {
				streamed += s;
			},
			retainedOutput: () => ({ text: "", truncated: false }),
			diagnostic(d: { message: string }) {
				diagnostics.push(d.message);
			},
		} as Parameters<typeof tool.execute>[1];
		const res = await tool.execute({ command: "example" }, api, BACKGROUND_CONTEXT);
		assert.equal(streamed, text);
		assert.ok("isError" in res && res.isError);
		const out = res.structuredOutput as {
			output: string;
			truncated: boolean;
			full_output_path?: string;
			exit_code: number;
		};
		assert.equal(out.exit_code, 7);
		assert.equal(out.truncated, truncated);
		if (truncated) assert.match(out.output, /bytes omitted/);
		else assert.equal(out.output, text);
		const files = await readdir(dir);
		assert.equal(files.length, Number(spill));
		if (spill) {
			const path = join(dir, files[0]);
			assert.equal(await readFile(path, "utf8"), text);
			assert.ok(diagnostics.includes(`Output log (up to 32 MiB): ${path}`));
			if (truncated) assert.equal(out.full_output_path, path);
		}
	});
}

for (const extra of [0, 1, 600_000]) {
	test(`bash caps its spill at 32 MiB with ${extra} excess bytes`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "pi-stick-bash-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const block = Buffer.alloc(1024 * 1024, "a");
		const tool = createBashTool(
			async (_args, _id, chunk) => {
				for (let i = 0; i < 31; i++) chunk(block);
				chunk(block.subarray(1));
				chunk(Buffer.from(extra ? "bc" : "b"));
				if (extra > 1) chunk(Buffer.alloc(extra - 1, "d"));
				return { text: "", exitCode: 0 };
			},
			() => dir,
		);
		const warnings: string[] = [];
		const api = {
			conversationId: ROOT_CONVERSATION_ID,
			output(_text: string) {},
			retainedOutput: () => ({ text: "", truncated: false }),
			diagnostic(d: { severity: string; message: string }) {
				if (d.severity === "warn") warnings.push(d.message);
			},
		} as Parameters<typeof tool.execute>[1];
		const res = await tool.execute({ command: "example" }, api, BACKGROUND_CONTEXT);
		const out = res.structuredOutput as { output: string; full_output_path?: string; exit_code: number };
		const path = join(dir, (await readdir(dir))[0]);
		const saved = await readFile(path);
		assert.equal(saved.length, 32 * block.length);
		assert.equal(saved.at(-1), 98); // 'b', the final byte before the cap
		assert.equal(out.exit_code, 0);
		assert.equal(out.full_output_path, extra ? undefined : path);
		assert.equal(warnings.length, Number(extra > 0));
		const tail =
			extra > 1 ? "d".repeat(block.length / 2) : `${"a".repeat(block.length / 2 - 1 - extra)}b${extra ? "c" : ""}`;
		assert.ok(out.output.endsWith(tail));
	});
}
