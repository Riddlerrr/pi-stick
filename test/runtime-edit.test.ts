import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createEditTool } from "../runtime-tools/edit.ts";

test("edit matches all blocks against the original file and never partially applies an invalid batch", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-stick-edit-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "note");
	const tool = createEditTool((path, id) => {
		assert.equal(id, ROOT_CONVERSATION_ID);
		if (path !== "/scratch/worker/note") throw Error("read-only");
		return file;
	});
	const api = { conversationId: ROOT_CONVERSATION_ID } as Parameters<typeof tool.execute>[1];
	const edit = (edits: { oldText: string; newText: string }[], path = "/scratch/worker/note") =>
		tool.execute({ path, edits }, api, BACKGROUND_CONTEXT);
	const original = "\uFEFFfirst\r\nsecond\nrepeat\r\nrepeat\n";
	await writeFile(file, original);
	const first = { oldText: "first", newText: "second" };
	for (const [oldText, reason] of [
		["missing", /find/],
		["repeat", /unique/],
		["irs", /overlap/],
		["", /empty/],
	] as const) {
		await assert.rejects(edit([first, { oldText, newText: "changed" }]), reason);
	}
	await assert.rejects(edit([first], "repo/note"), /read-only/);
	assert.equal(await readFile(file, "utf8"), original);
	const result = await edit([first, { oldText: "second", newText: "third" }]);
	assert.ok("details" in result);
	const details = result.details;
	assert.ok(details && typeof details === "object" && !Array.isArray(details));
	assert.equal(typeof details.patch, "string");
	assert.match(String(details.patch), /\+third/);
	assert.equal(details.firstChangedLine, 1);
	assert.equal(await readFile(file, "utf8"), "\uFEFFsecond\r\nthird\nrepeat\r\nrepeat\n");
});
