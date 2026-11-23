import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createReadTool } from "../runtime-tools/read.ts";

test("read uses Pi line ranges, bounded output and image results inside the agent's path policy", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-stick-read-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "note.txt"), "abcd\néfgh\nijk");
	const tool = createReadTool("/workspace/repo", (path, conversationId) => {
		assert.equal(conversationId, ROOT_CONVERSATION_ID);
		if (path === "blocked" || path === "can’t") throw Error("blocked by path policy");
		return join(dir, path);
	});
	const api = { conversationId: ROOT_CONVERSATION_ID, agent: async () => ({}) } as unknown as Parameters<
		typeof tool.execute
	>[1];
	const read = async (path: string, offset?: number, limit?: number) => {
		const result = await tool.execute({ path, offset, limit }, api, BACKGROUND_CONTEXT);
		assert.ok("output" in result);
		return result;
	};
	await assert.rejects(read("."), /directory/i);
	assert.deepEqual((await read("note.txt", 2, 1)).output, [{ type: "text", text: "éfgh" }]);
	assert.match(String((await read("note.txt", 2, 1)).structuredOutput), /^éfgh\n\n\[.*offset=3/);
	assert.equal((await read("note.txt", 3)).structuredOutput, "ijk");
	await assert.rejects(read("note.txt", 4), /beyond end of file/);
	await assert.rejects(read("blocked"), /blocked by path policy/);
	await assert.rejects(read("can't"), /blocked by path policy/);
	await writeFile(join(dir, "lines"), `${"one\n".repeat(2000)}last`);
	assert.match(String((await read("lines")).structuredOutput), /Use offset=2001/);
	assert.equal((await read("lines", 2001)).structuredOutput, "last");
	await writeFile(join(dir, "bytes"), `${"é".repeat(25000)}\n${"é".repeat(1000)}`);
	assert.match(String((await read("bytes")).structuredOutput), /50.*offset=2/);
	// A 1x1 24-bit BMP: Pi must detect it without an extension and convert it for the model.
	const bmp = Buffer.alloc(58);
	bmp.write("BM");
	for (const [at, n] of [
		[2, 58],
		[10, 54],
		[14, 40],
		[18, 1],
		[22, 1],
	])
		bmp.writeUInt32LE(n, at);
	bmp.writeUInt16LE(1, 26);
	bmp.writeUInt16LE(24, 28);
	await writeFile(join(dir, "image"), bmp);
	const image = await read("image");
	const block = image.output?.[0];
	assert.ok(block?.type === "image");
	assert.match(block.mimeType, /^image\/(png|jpeg|webp)$/);
	assert.ok(block.data.length > 0);
	assert.deepEqual(image.structuredOutput, { ...block, note: image.diagnostics?.[0].message });
});
