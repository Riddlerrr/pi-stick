import assert from "node:assert/strict";
import test from "node:test";
import { type ActionJob, RUN, readJob, readReply, readRuntime } from "../runtime-tools/protocol.ts";

test("initial revision, probe and action fields are checked without echoing the job", () => {
	const envelope = {
		type: RUN,
		id: "0".repeat(32),
		models: {},
		credentials: { pi: { token: "private-fixture", validUntil: 1 } },
	} as const;
	const job = {
		...envelope,
		requestId: "request",
		prompt: "task",
		continueRun: false,
		agents: {},
		stages: [],
	} satisfies ActionJob;
	assert.deepEqual(readJob(JSON.stringify(job)), job);
	const probe = { ...envelope, check: true };
	assert.deepEqual(readJob(JSON.stringify(probe)), probe);
	for (const [bad, field] of [
		[{ ...job, type: "run.v2" }, "revision"],
		[{ ...job, requestId: undefined }, "requestId"],
		[{ ...probe, prompt: "unexpected" }, "probe fields"],
		[{ ...job, credentials: { pi: { token: 1 } } }, "credentials"],
	] as const) {
		assert.throws(
			() => readJob(JSON.stringify(bad)),
			(e: Error) =>
				e.message.includes(field) &&
				e.message.includes("pistick containers build") &&
				!e.message.includes("private-fixture"),
		);
	}
	assert.throws(
		() => readJob("private-fixture: not json"),
		(e: Error) => !e.message.includes("private-fixture"),
	);
});
test("refresh replies carry only the lease and match a runtime-owned request", () => {
	const token = "private-fixture";
	const pending = new Map([["r", { command: "refresh_token" as const }]]);
	const request = { type: "refresh_token", provider: "test", id: "r" };
	assert.deepEqual(readRuntime(JSON.stringify(request)), request);
	assert.throws(() => readRuntime(JSON.stringify({ ...request, agent: "worker" })), /refresh_token request/);
	const reply = { type: "response", id: "r", command: "refresh_token", success: true, data: { token, validUntil: 1 } };
	assert.deepEqual(readReply(JSON.stringify(reply), pending), reply);
	for (const invalid of [
		{ ...reply, data: { text: JSON.stringify(reply.data) } },
		{ ...reply, data: { ...reply.data, token: "" } },
		{ ...reply, data: { token, validUntil: "never" } },
		{ ...reply, id: "wrong" },
		{ ...reply, command: "ps", data: { text: token } },
	])
		assert.throws(
			() => readReply(JSON.stringify(invalid), pending),
			(e: Error) => /Invalid agent protocol/.test(e.message) && !e.message.includes(token),
		);
});
test("run outputs must be strings and RPC replies match the pending id and command", () => {
	const result = {
		type: "response",
		command: "run",
		success: true,
		id: "r",
		data: { report: "ok", outputs: { worker: 42 } },
	};
	assert.throws(() => readRuntime(JSON.stringify(result)), /response.outputs/);
	const pending = new Map([["1", { command: "logs" as const }]]);
	const reply = { type: "response", command: "logs", id: "1", success: true, data: { text: "ok" } };
	assert.deepEqual(readReply(JSON.stringify(reply), pending), reply);
	for (const bad of [
		{ ...reply, id: "2" },
		{ ...reply, command: "ps" },
		{ type: "exec_chunk", id: "1", chunk: "" },
	])
		assert.throws(() => readReply(JSON.stringify(bad), pending), /id\/command/);
});
