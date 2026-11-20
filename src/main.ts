import * as fs from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { STATE } from "./platform.ts";
import { activeRunIds, cleanup, diffRun, follow, listRuns, stopRun } from "./runs.ts";
import { doctor, update } from "./system.ts";
import { createProject } from "./workspace.ts";

const usage = {
	create: "create project NAME [--repo URL]",
	runs: "runs [--all]",
	follow: "follow RUN_ID",
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
		.map((s) => `  pi-stick ${s}`)
		.join("\n");

type Action =
	| { cmd: "create-project"; name: string; repo?: string }
	| { cmd: "runs"; all: boolean }
	| { cmd: "follow"; id: string }
	| { cmd: "stop"; id: string }
	| { cmd: "diff"; id: string }
	| { cmd: "cleanup"; days: number; dry: boolean }
	| { cmd: "doctor" }
	| { cmd: "update"; yes: boolean };

function parse(cmd: string, args: string[]): Action {
	const flags = <const T extends Record<string, { type: "string" | "boolean" }>>(options: T) =>
		parseArgs({ args, options, allowPositionals: true });
	switch (cmd) {
		case "create": {
			const { positionals: p, values: v } = flags({ repo: { type: "string" } });
			if (p.length === 2 && p[0] === "project") return { cmd: "create-project", name: p[1], repo: v.repo };
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
			if (!args.length) return { cmd: "doctor" };
			break;
		case "update": {
			const { positionals: p, values: v } = flags({ yes: { type: "boolean" } });
			if (!p.length) return { cmd: "update", yes: v.yes === true };
			break;
		}
	}
	throw Error(Object.hasOwn(usage, cmd) ? `Usage: pi-stick ${usage[cmd as keyof typeof usage]}` : help);
}

export async function main([cmd, ...args]: string[]) {
	process.umask(0o077);
	if (cmd === "--help" || cmd === "-h" || !cmd) {
		console.log(help);
		return 0;
	}
	if (Object.hasOwn(usage, cmd) && args.some((s) => s === "--help" || s === "-h")) {
		console.log(`Usage: pi-stick ${usage[cmd as keyof typeof usage]}`);
		return 0;
	}
	if (cmd === "version" && !args.length) {
		console.log(pkg.version);
		return 0;
	}
	const action = parse(cmd, args);
	for (const d of ["runs", "sessions"]) fs.mkdirSync(join(STATE, d), { recursive: true, mode: 0o700 });
	switch (action.cmd) {
		case "create-project":
			console.log("Created:", await createProject(action.name, action.repo));
			return 0;
		case "runs":
			listRuns(action.all);
			return 0;
		case "follow":
			return follow(action.id);
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
			return (await doctor()) ? 0 : 1;
		case "update":
			await update(action.yes, activeRunIds().length);
			return 0;
	}
}
