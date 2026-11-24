import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { UsageState } from "@earendil-works/pi-durable";
import type { AccessLease, CredentialPayload } from "../runtime-auth.ts";

export const RUN = "run.v1";
// Only operator-safe summaries belong in a run failure, never raw provider or tool errors.
export class RunFailure extends Error {}
export interface AgentRuntimeSpec {
	name: string;
	description?: string;
	model: { provider: string; modelId: string };
	instructions: string;
	mode: "read-only" | "read-write";
	tools: string[];
	thinkingLevel?: ModelThinkingLevel;
	maxTurns?: number;
}
interface ActionFields {
	prompt: string;
	requestId: string;
	continueRun: boolean;
	agents: Record<string, AgentRuntimeSpec>;
	orchestrator?: AgentRuntimeSpec;
	stages: { name: string; parallel: string[]; prompt?: string }[];
	stageContext?: "previous" | "all";
}
interface Envelope {
	type: typeof RUN;
	id: string;
	models: Record<string, Model<Api>[]>;
	credentials: Record<string, CredentialPayload>;
}
export type ActionJob = Envelope & ActionFields & { check?: false };
export type Job = ActionJob | (Envelope & { check: true } & { [K in keyof ActionFields]?: never });
export type ToolCall =
	| { type: "exec"; command: string; timeout?: number; service?: string }
	| { type: "logs"; service?: string; tail?: number }
	| { type: "restart"; service: string }
	| { type: "ps" | "check_clean" };
export type RefreshCall = { type: "refresh_token"; provider: string; agent?: never };
export type RpcCall = RefreshCall | (ToolCall & { agent?: string });
const methods = {
	ps: true,
	logs: true,
	check_clean: true,
	restart: true,
	refresh_token: true,
	exec: true,
} satisfies Record<Method, true>;
export type Method = RpcCall["type"];
export type RpcData = { text: string; error?: boolean; exitCode?: number };
export type RpcResponse = { type: "response"; id: string } & (
	| { command: "refresh_token"; success: true; data: AccessLease }
	| { command: ToolCall["type"]; success: true; data: RpcData }
	| { command: Method; success: false; error: string }
);
type Reply = { type: "exec_chunk"; id: string; chunk: string } | RpcResponse;
export type HostMessage = Job | Reply;
export type Request = RpcCall & { id: string };
type Outcome = { ready: true } | { report: string; outputs?: Record<string, string>; usage?: UsageState };
export type RuntimeMessage =
	| Request
	| { type: "progress"; message: string; agent?: string }
	| { type: "cancel_exec"; id: string }
	| ({ type: "response"; command: "run"; id: string } & (
			| { success: true; data: Outcome }
			| { success: false; error: string; data?: { usage?: UsageState } }
	  ));

function invalid(field: string): never {
	throw Error(`Invalid agent protocol: ${field}; rebuild with pistick containers build`);
}
function record(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
function message(line: string) {
	let v: unknown;
	try {
		v = JSON.parse(line);
	} catch {
		invalid("JSON");
	}
	if (!record(v)) invalid("message");
	return v;
}
function strings(v: unknown) {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function map(v: unknown, ok: (v: unknown) => boolean) {
	return record(v) && Object.values(v).every(ok);
}
function optional(v: unknown, type: "string" | "boolean" | "number") {
	return v === undefined || typeof v === type;
}
function spec(v: unknown) {
	return (
		record(v) &&
		typeof v.name === "string" &&
		optional(v.description, "string") &&
		typeof v.instructions === "string" &&
		record(v.model) &&
		typeof v.model.provider === "string" &&
		typeof v.model.modelId === "string" &&
		(v.mode === "read-only" || v.mode === "read-write") &&
		strings(v.tools) &&
		(v.maxTurns === undefined || Number.isSafeInteger(v.maxTurns)) &&
		(v.thinkingLevel === undefined ||
			["off", "minimal", "low", "medium", "high", "xhigh", "max"].some((x) => x === v.thinkingLevel))
	);
}
export function readJob(line: string): Job {
	const m: unknown = message(line);
	assertJob(m);
	return m;
}
function assertJob(m: unknown): asserts m is Job {
	if (!record(m) || m.type !== RUN) invalid("initial run revision");
	if (typeof m.id !== "string" || !/^[0-9a-f]{32}$/.test(m.id)) invalid("run.id");
	if (
		!map(
			m.models,
			(v) =>
				Array.isArray(v) &&
				v.every(
					(x) =>
						record(x) &&
						["id", "provider", "api", "baseUrl", "name"].every((k) => typeof x[k] === "string") &&
						typeof x.reasoning === "boolean" &&
						strings(x.input) &&
						Number.isFinite(x.contextWindow) &&
						Number.isFinite(x.maxTokens) &&
						record(x.cost) &&
						["input", "output", "cacheRead", "cacheWrite"].every((k) =>
							Number.isFinite((x.cost as Record<string, unknown>)[k]),
						),
				),
		)
	)
		invalid("run.models");
	if (
		!map(
			m.credentials,
			(v) =>
				record(v) &&
				typeof v.token === "string" &&
				Number.isFinite(v.validUntil) &&
				(v.authType === undefined || v.authType === "oauth" || v.authType === "api_key"),
		)
	)
		invalid("run.credentials");
	if (m.check !== undefined && typeof m.check !== "boolean") invalid("run.check");
	if (m.check === true) {
		if (Object.keys(m).some((k) => !["type", "id", "models", "credentials", "check"].includes(k)))
			invalid("probe fields");
	} else {
		for (const k of ["prompt", "requestId"]) if (typeof m[k] !== "string" || !m[k]) invalid(`run.${k}`);
		if (typeof m.continueRun !== "boolean") invalid("run.continueRun");
		if (!map(m.agents, spec)) invalid("run.agents");
		if (m.orchestrator !== undefined && !spec(m.orchestrator)) invalid("run.orchestrator");
		if (m.stageContext !== undefined && m.stageContext !== "all" && m.stageContext !== "previous")
			invalid("run.stageContext");
		if (
			!Array.isArray(m.stages) ||
			!m.stages.every(
				(s) => record(s) && typeof s.name === "string" && strings(s.parallel) && optional(s.prompt, "string"),
			)
		)
			invalid("run.stages");
	}
}
function isUsageSnapshot(value: unknown): value is UsageState {
	const amount = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
	if (!record(value) || Object.keys(value).length !== 2 || !record(value.models) || !record(value.tools)) return false;
	const common = ["input", "output", "cacheRead", "cacheWrite"];
	const tokens = [...common, "totalTokens"];
	const costs = [...common, "total"];
	return [value.models, value.tools].every((bucket) =>
		Object.values(bucket).every((entry) => {
			if (!record(entry) || !record(entry.cost)) return false;
			const cost = entry.cost;
			return (
				tokens.every((k) => amount(entry[k])) &&
				Object.entries(entry).every(
					([k, v]) =>
						k === "cost" || tokens.includes(k) || ((k === "cacheWrite1h" || k === "reasoning") && amount(v)),
				) &&
				costs.every((k) => amount(cost[k])) &&
				Object.entries(cost).every(([k, v]) =>
					k === "totalFromProvider" ? typeof v === "boolean" : costs.includes(k),
				)
			);
		}),
	);
}

export function isRequest(m: RuntimeMessage): m is Request {
	return method(m.type);
}
function method(v: unknown): v is Method {
	return typeof v === "string" && Object.hasOwn(methods, v);
}
export function readReply(line: string, pending: ReadonlyMap<string, { command: Method }>): Reply {
	const m = message(line);
	if (typeof m.id !== "string") invalid("RPC id");
	if (m.type === "exec_chunk") {
		if (typeof m.chunk !== "string") invalid("exec_chunk.chunk");
	} else if (m.type !== "response" || !method(m.command)) invalid("RPC response.command");
	else if (m.success === true) {
		if (m.command === "refresh_token") {
			if (
				!record(m.data) ||
				typeof m.data.token !== "string" ||
				!m.data.token ||
				!Number.isFinite(m.data.validUntil) ||
				Object.keys(m.data).length !== 2
			)
				invalid("refresh_token lease");
		} else if (
			!record(m.data) ||
			typeof m.data.text !== "string" ||
			!optional(m.data.error, "boolean") ||
			!optional(m.data.exitCode, "number")
		)
			invalid("RPC response.data");
	} else if (m.success !== false || typeof m.error !== "string") invalid("RPC response.error");
	const expected = pending.get(m.id)?.command;
	if (!expected || expected !== (m.type === "exec_chunk" ? "exec" : m.command)) invalid("RPC response id/command");
	return m as Reply;
}
export function readRuntime(line: string): RuntimeMessage {
	const m = message(line);
	if (!optional(m.agent, "string") || m.agent === "") invalid("agent");
	if (m.type === "progress") {
		if (typeof m.message !== "string") invalid("progress.message");
	} else if (typeof m.id !== "string") invalid("message.id");
	else if (m.type === "response") {
		if (m.command !== "run") invalid("response.command");
		if (m.data !== undefined && !record(m.data)) invalid("run response.data");
		if (m.data?.usage !== undefined && !isUsageSnapshot(m.data.usage)) invalid("run response.usage");
		if (m.success === true) {
			if (m.data?.ready === true) {
				if (Object.keys(m.data).length !== 1) invalid("probe response");
			} else if (typeof m.data?.report !== "string" || "ready" in m.data) invalid("run response.report");
			if (m.data.outputs !== undefined && !map(m.data.outputs, (x) => typeof x === "string"))
				invalid("run response.outputs");
		} else if (m.success !== false || typeof m.error !== "string") invalid("run response.error");
	} else if (method(m.type)) {
		if (m.type === "exec" && (typeof m.command !== "string" || !optional(m.timeout, "number")))
			invalid("exec.command/timeout");
		if (!optional(m.service, "string") || (m.type === "restart" && typeof m.service !== "string"))
			invalid("RPC service");
		if (m.type === "refresh_token" && ("agent" in m || typeof m.provider !== "string"))
			invalid("refresh_token request");
		if (m.type === "logs" && !optional(m.tail, "number")) invalid("logs.tail");
	} else if (m.type !== "cancel_exec") invalid("runtime message type");
	return m as RuntimeMessage;
}
