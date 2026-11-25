import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createEditTool } from "../runtime-tools/edit.ts";
import { createWriteTool } from "../runtime-tools/write.ts";

test("write creates parents and shares edit's queue, including when creating the file", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-stick-write-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const resolve = (path: string) => join(dir, path);
	const write = createWriteTool(resolve);
	const edit = createEditTool(resolve);
	const api = { conversationId: ROOT_CONVERSATION_ID } as Parameters<typeof write.execute>[1];
	const path = "nested/note";
	const overwrite = (content: string) => write.execute({ path, content }, api, BACKGROUND_CONTEXT);
	const replace = () => edit.execute({ path, edits: [{ oldText: "до", newText: "после" }] }, api, BACKGROUND_CONTEXT);
	await Promise.all([overwrite("до"), replace()]);
	assert.equal(await readFile(resolve(path), "utf8"), "после");
	await overwrite("до");
	await Promise.all([replace(), overwrite("")]);
	assert.equal(await readFile(resolve(path), "utf8"), "");
	await symlink(resolve("missing"), resolve("link"));
	await assert.rejects(write.execute({ path: "link", content: "denied" }, api, BACKGROUND_CONTEXT), {
		message: 'Cannot write "link": ELOOP',
	});
	await assert.rejects(readFile(resolve("missing")), { code: "ENOENT" });
});
