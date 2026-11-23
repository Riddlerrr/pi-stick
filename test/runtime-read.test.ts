import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createReadTool } from "../runtime-read.ts";

test("read tool works independently of the agent runtime and uses the supplied path policy", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-stick-read-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "child"));
	await writeFile(join(dir, "note.txt"), "abcd\nefgh\n");
	await writeFile(join(dir, "blob.bin"), Buffer.from([0, 1]));
	const tool = createReadTool("/workspace/repo", (path, conversationId) => {
		assert.equal(conversationId, ROOT_CONVERSATION_ID);
		if (path === "blocked") throw Error("blocked by path policy");
		return join(dir, path);
	});
	const api = { conversationId: ROOT_CONVERSATION_ID } as Parameters<typeof tool.execute>[1];
	const read = (args: { path: string; offset?: number; limit?: number }) =>
		tool.execute(args, api, BACKGROUND_CONTEXT);
	const output = (value: string) => [{ type: "text", text: value }];
	assert.deepEqual(await read({ path: "note.txt", offset: 1, limit: 3 }), {
		output: output("bcd\n[more at offset 4]"),
	});
	assert.deepEqual(await read({ path: "." }), { output: output("blob.bin\nchild/\nnote.txt") });
	assert.deepEqual(await read({ path: "blob.bin" }), {
		output: output("Binary file cannot be read as text."),
		isError: true,
	});
	assert.deepEqual(await read({ path: "blocked" }), { output: output("blocked by path policy"), isError: true });
});
