import assert from "node:assert/strict";
import test from "node:test";
import schema from "../action.schema.json" with { type: "json" };

// validateField handles only this subset. Check the schema itself, even for fields no fixture uses.
const supported: Record<string, string[]> = {
	object: ["properties", "propertyNames", "additionalProperties", "required"],
	array: ["items", "minItems"],
	integer: ["minimum"],
	string: ["pattern", "enum"],
	boolean: [],
};

function checkField(field: unknown, path: string) {
	assert.ok(field && typeof field === "object" && !Array.isArray(field), `${path}: expected schema object`);
	const node = field as Record<string, unknown>;
	const allowed = ["description", "title", "default"];
	if (path === "action.schema.json") allowed.push("$schema", "$id", "$defs", "anyOf");
	if (path === "action.schema.json.properties.stages.items.properties.parallel") allowed.push("uniqueItems");
	if ("$ref" in node) {
		assert.equal(node.$ref, "#/$defs/agentConfig", `${path}.$ref: unsupported reference`);
		allowed.push("$ref");
	} else {
		const type = node.type ?? (path.endsWith(".propertyNames") ? "string" : undefined);
		assert.ok(typeof type === "string" && Object.hasOwn(supported, type), `${path}.type: unsupported type`);
		allowed.push("type", ...supported[type]);
	}
	for (const [key, value] of Object.entries(node)) {
		const at = `${path}.${key}`;
		assert.ok(allowed.includes(key), `${at}: unsupported schema keyword`);
		if (key === "properties" || key === "$defs") {
			for (const [name, child] of Object.entries(value as Record<string, unknown>))
				checkField(child, `${at}.${name}`);
		} else if (
			key === "items" ||
			key === "propertyNames" ||
			(key === "additionalProperties" && typeof value !== "boolean")
		) {
			checkField(value, at);
		}
	}
}

test("the shipped action schema uses only constraints enforced by the CLI", () => {
	// loadActionFromDir enforces these two specific rules when resolving stages.
	assert.deepEqual(
		schema.anyOf,
		[{ required: ["orchestrator"] }, { required: ["stages"], properties: { stages: { minItems: 1 } } }],
		"action.schema.json.anyOf",
	);
	assert.equal(
		schema.properties.stages.items.properties.parallel.uniqueItems,
		true,
		"action.schema.json.properties.stages.items.properties.parallel.uniqueItems",
	);
	checkField(schema, "action.schema.json");
});
