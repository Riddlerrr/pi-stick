import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RUNNER_SHELL } from "../src/runner-shell.ts";

test("closing runner stdin cancels background processes even after their shell exits", async () => {
	const child = spawn("sh", ["-c", RUNNER_SHELL, "sleep 6 & echo $!"], { stdio: ["pipe", "pipe", "pipe"] });
	const exit = once(child, "close");
	const [chunk] = await once(child.stdout, "data");
	const pid = Number(chunk.toString().trim());
	assert.ok(Number.isSafeInteger(pid) && pid > 1);
	child.stdin.end();
	const start = Date.now();
	await exit;
	assert.ok(Date.now() - start < 5000);
	try {
		assert.match(readFileSync(`/proc/${pid}/stat`, "utf8"), /\) [ZX] /);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
});
