import { existsSync } from "node:fs";
import { join } from "node:path";
import type { UsageState } from "@earendil-works/pi-durable";
import { json, writeJson } from "./platform.ts";

const phases = [
	"checkout",
	"prepare",
	"preparing-hook",
	"setup",
	"setting-up",
	"agent",
	"agent-started",
	"after",
	"after-hook",
	"stop",
] as const;
export type Phase = (typeof phases)[number];

export interface RunState {
	version: 2;
	turn: number;
	id: string;
	project: string;
	action: string;
	actionDigest: string;
	ref?: string;
	baseHead?: string;
	inputs: Record<string, string>;
	createdAt: string;
	updatedAt: string;
	usage?: UsageState;
	mode: "run" | "continue";
	requestId: string;
	prompt: string;
	keepUp: boolean;
	phase: Phase;
	exitCode?: 0 | 1;
}

export function readState(dir: string): RunState {
	const file = join(dir, "run.json");
	if (!existsSync(file)) throw Error(`Missing run.json: unknown or unsupported run at ${dir}; start a new run`);
	const state = json(file);
	if (
		state?.version !== 2 ||
		!Number.isSafeInteger(state.turn) ||
		state.turn < 1 ||
		typeof state.project !== "string" ||
		!/^[a-z0-9][a-z0-9-]{0,62}$/.test(state.project) ||
		!phases.includes(state.phase) ||
		![undefined, 0, 1].includes(state.exitCode) ||
		(state.exitCode === 0 && state.phase !== "stop") ||
		!["run", "continue"].includes(state.mode)
	)
		throw Error(`Unsupported run checkpoint: ${file}; start a new run`);
	return state;
}

// Inventory may include legacy runs; listing is allowed, implicit deletion is not.
export function tryReadState(dir: string) {
	try {
		return readState(dir);
	} catch {
		return undefined;
	}
}

export function saveState(dir: string, state: RunState) {
	state.updatedAt = new Date().toISOString();
	writeJson(join(dir, "run.json"), state);
}

export function pendingEffect(phase: Phase) {
	return phase === "preparing-hook"
		? "prepare hook"
		: phase === "setting-up"
			? "setup-project"
			: phase === "after-hook"
				? "after hook"
				: undefined;
}

export function needsSession(state: RunState) {
	return state.mode === "continue" || ["agent-started", "after", "after-hook", "stop"].includes(state.phase);
}
