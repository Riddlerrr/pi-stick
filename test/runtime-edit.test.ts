import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createEditTool } from "../runtime-tools/edit.ts";

test("edit applies the conversation's path policy before opening the file", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-stick-edit-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "note");
	const tool = createEditTool((path, id) => {
		assert.equal(id, ROOT_CONVERSATION_ID);
		if (path !== "/scratch/worker/note") throw Error("read-only");
		return file;
	});
	const api = { conversationId: ROOT_CONVERSATION_ID } as Parameters<typeof tool.execute>[1];
	const edit = (path: string) =>
		tool.execute({ path, edits: [{ oldText: "before", newText: "after" }] }, api, BACKGROUND_CONTEXT);
	await writeFile(file, "before");
	await assert.rejects(edit("repo/note"), /read-only/);
	assert.equal(await readFile(file, "utf8"), "before");
	await edit("/scratch/worker/note");
	assert.equal(await readFile(file, "utf8"), "after");
});
