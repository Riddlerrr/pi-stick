import assert from "node:assert/strict";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { runtimeCredentials } from "../runtime-auth.ts";

test("parallel model requests renew an OAuth bearer once and reuse it until the next lease", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
	const providers = builtinProviders();
	let calls = 0;
	const models = createModels({
		credentials: runtimeCredentials(
			{
				anthropic: { authType: "oauth", token: "first", validUntil: Date.now() + 300_000 },
			},
			providers,
			async (id) => {
				assert.equal(id, "anthropic");
				return { token: `next-${++calls}`, validUntil: Date.now() + 300_000 };
			},
		),
	});
	for (const p of providers) models.setProvider(p);
	const bearer = async () => (await models.getAuth("anthropic"))?.auth;
	const first = await bearer();
	assert.match(JSON.stringify(first), /first/);
	assert.equal(calls, 0);
	t.mock.timers.tick(250_000);
	for (const auth of await Promise.all([bearer(), bearer()])) assert.match(JSON.stringify(auth), /next-1/);
	assert.match(JSON.stringify(await bearer()), /next-1/);
	assert.equal(calls, 1);
	t.mock.timers.tick(300_000);
	assert.match(JSON.stringify(await bearer()), /next-2/);
});

test("failed refresh never falls back to an expired bearer or poisons the next request", async () => {
	let calls = 0;
	const store = runtimeCredentials(
		{
			anthropic: { token: "stale", authType: "oauth", validUntil: 0 },
			openai: { token: "static", authType: "api_key", validUntil: 0 },
		},
		builtinProviders(),
		async () => {
			if (++calls === 1) throw Error("unavailable");
			return { token: "fresh", validUntil: Date.now() + 300_000 };
		},
	);
	assert.deepEqual(await store.read("openai"), { type: "api_key", key: "static" });
	await assert.rejects(store.read("anthropic"), /unavailable/);
	assert.equal((await store.read("anthropic"))?.type, "oauth");
	assert.equal(calls, 2);
});
