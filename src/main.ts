import * as fs from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { createAction, listActions, validateAllActions } from "./actions.ts";
import { STATE, tryLock } from "./platform.ts";
import {
	activeRunIds,
	cleanup,
	diffRun,
	follow,
	launchContinue,
	launchResume,
	launchRun,
	listRuns,
	runLock,
	stopRun,
	worker,
} from "./runs.ts";
import { doctor, update } from "./system.ts";
import { createProject, getProject, listProjects } from "./workspace.ts";

const usage = {
	create: "create (project NAME [--repo URL] | action NAME [--project PROJECT])",
	actions: "actions [--project PROJECT]",
	run: "run PROJECT ACTION [--ref REF] [--input KEY=VALUE]... [--keep-up] [PROMPT]",
	runs: "runs [--all]",
	follow: "follow RUN_ID",
	resume: "resume RUN_ID [--retry-hook]",
	continue: "continue RUN_ID PROMPT [--keep-up]",
	stop: "stop RUN_ID",
	diff: "diff RUN_ID",
	cleanup: "cleanup [--dry-run] [--days DAYS]",
	doctor: "doctor",
	update: "update [--yes]",
	version: "version",
};

const help =
	"Isolated Docker project workspaces and extensible multi-agent tasks\n\nUsage:\n" +
	Object.values(usage)
		.map((s) => `  pistick [--dev] ${s}`)
		.join("\n");

type Command =
	| { cmd: "create-project"; name: string; repo?: string }
	| { cmd: "create-action"; name: string; project?: string }
	| { cmd: "actions"; project?: string }
	| {
			cmd: "run";
			project: string;
			action: string;
			ref?: string;
			inputs: string[];
			keepUp: boolean;
			prompt: string;
	  }
	| { cmd: "runs"; all: boolean }
	| { cmd: "follow"; id: string }
	| { cmd: "resume"; id: string; retryHook: boolean }
	| { cmd: "continue"; id: string; prompt: string; keepUp?: boolean }
	| { cmd: "stop"; id: string }
	| { cmd: "diff"; id: string }
	| { cmd: "cleanup"; days: number; dry: boolean }
	| { cmd: "doctor" }
	| { cmd: "update"; yes: boolean };

function parse(cmd: string, args: string[]): Command {
	const flags = <const T extends Record<string, { type: "string" | "boolean"; multiple?: boolean }>>(options: T) =>
		parseArgs({ args, options, allowPositionals: true });
	switch (cmd) {
		case "create": {
			const { positionals: p, values: v } = flags({
				repo: { type: "string" },
				project: { type: "string" },
			});
			if (p.length === 2 && p[0] === "project" && v.project === undefined)
				return { cmd: "create-project", name: p[1], repo: v.repo };
			if (p.length === 2 && p[0] === "action" && v.repo === undefined)
				return { cmd: "create-action", name: p[1], project: v.project };
			break;
		}
		case "actions": {
			const { positionals: p, values: v } = flags({ project: { type: "string" } });
			if (!p.length) return { cmd: "actions", project: v.project };
			break;
		}
		case "run": {
			const { positionals: p, values: v } = flags({
				ref: { type: "string" },
				input: { type: "string", multiple: true },
				"keep-up": { type: "boolean" },
			});
			if (p.length >= 2) {
				return {
					cmd: "run",
					project: p[0],
					action: p[1],
					ref: v.ref,
					inputs: v.input ?? [],
					keepUp: v["keep-up"] === true,
					prompt: p.slice(2).join(" "),
				};
			}
			break;
		}
		case "runs": {
			const { positionals: p, values: v } = flags({ all: { type: "boolean" } });
			if (!p.length) return { cmd: "runs", all: v.all === true };
			break;
		}
		case "follow": {
			const { positionals: p } = flags({});
			if (p.length === 1) return { cmd: "follow", id: p[0] };
			break;
		}
		case "resume": {
			const { positionals: p, values: v } = flags({ "retry-hook": { type: "boolean" } });
			if (p.length === 1) return { cmd: "resume", id: p[0], retryHook: v["retry-hook"] === true };
			break;
		}
		case "continue": {
			const { positionals: p, values: v } = flags({ "keep-up": { type: "boolean" } });
			if (p.length >= 2) {
				return {
					cmd: "continue",
					id: p[0],
					prompt: p.slice(1).join(" "),
					keepUp: v["keep-up"] === true ? true : undefined,
				};
			}
			break;
		}
		case "stop": {
			const { positionals: p } = flags({});
			if (p.length === 1) return { cmd: "stop", id: p[0] };
			break;
		}
		case "diff": {
			const { positionals: p } = flags({});
			if (p.length === 1) return { cmd: "diff", id: p[0] };
			break;
		}
		case "cleanup": {
			const { positionals: p, values: v } = flags({
				days: { type: "string" },
				"dry-run": { type: "boolean" },
			});
			const days = String(v.days ?? 7);
			if (!/^\d+$/.test(days) || !Number.isSafeInteger(Number(days)))
				throw Error("Days must be a nonnegative integer");
			if (!p.length) return { cmd: "cleanup", days: Number(days), dry: v["dry-run"] === true };
			break;
		}
		case "doctor":
			if (!args.length) return { cmd };
			break;
		case "update": {
			const { positionals: p, values: v } = flags({ yes: { type: "boolean" } });
			if (!p.length) return { cmd, yes: v.yes === true };
			break;
		}
	}
	throw Error(Object.hasOwn(usage, cmd) ? `Usage: pistick ${usage[cmd as keyof typeof usage]}` : help);
}

export async function main(rawArgs: string[]) {
	process.umask(0o077);
	const [cmd, ...args] = rawArgs[0] === "--dev" ? rawArgs.slice(1) : rawArgs;
	if (cmd === "--help" || cmd === "-h" || !cmd) {
		console.log(help);
		return 0;
	}
	if (Object.hasOwn(usage, cmd) && args.some((s) => s === "--help" || s === "-h")) {
		console.log(`Usage: pistick ${usage[cmd as keyof typeof usage]}`);
		return 0;
	}
	if (cmd === "version" && !args.length) {
		console.log(pkg.version);
		return 0;
	}
	if (cmd === "_worker" && args.length === 1) {
		const id = args[0];
		const inherited = fs.fstatSync(3);
		const lock = fs.statSync(runLock(id));
		if (inherited.ino !== lock.ino || inherited.dev !== lock.dev || !tryLock(3))
			throw Error("Invalid worker invocation");
		return worker(id);
	}
	const action = parse(cmd, args);
	for (const d of ["runs", "sessions"]) fs.mkdirSync(join(STATE, d), { recursive: true, mode: 0o700 });
	switch (action.cmd) {
		case "create-project":
			console.log("Created:", await createProject(action.name, action.repo));
			return 0;
		case "create-action": {
			const project = action.project ? getProject(action.project) : undefined;
			console.log("Created:", createAction(action.name, project));
			return 0;
		}
		case "actions": {
			const project = action.project ? getProject(action.project) : undefined;
			const items = listActions(project);
			if (!items.length) {
				console.log("No actions configured. Create one with: pistick create action NAME");
				return 0;
			}
			for (const item of items) {
				console.log(`${item.name.padEnd(20)}  ${item.scope.padEnd(26)}  ${item.description}`);
			}
			return 0;
		}
		case "run": {
			const id = await launchRun({
				projectName: action.project,
				actionName: action.action,
				ref: action.ref,
				rawInputs: action.inputs,
				promptText: action.prompt,
				keepUp: action.keepUp,
			});
			return follow(id);
		}
		case "runs":
			listRuns(action.all);
			return 0;
		case "follow":
			return follow(action.id);
		case "resume": {
			const id = await launchResume(action.id, action.retryHook);
			return follow(id);
		}
		case "continue": {
			const id = await launchContinue(action.id, action.prompt, action.keepUp);
			return follow(id);
		}
		case "stop":
			stopRun(action.id);
			return 0;
		case "diff":
			diffRun(action.id);
			return 0;
		case "cleanup":
			await cleanup(action.days, action.dry);
			return 0;
		case "doctor":
			return (await doctor([["Action manifests", () => validateAllActions(listProjects())]])) ? 0 : 1;
		case "update":
			await update(action.yes, activeRunIds().length);
			return 0;
	}
}
