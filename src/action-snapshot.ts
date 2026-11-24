import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import type { LoadedAction } from "./actions.ts";

const hookNames = ["prepare", "after"] as const;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type Snapshot = Pick<
	LoadedAction,
	"name" | "scope" | "dir" | "orchestrator" | "agents" | "stageContext" | "stages" | "hooks"
> & {
	version: 1;
	projectNotes: string | null;
	hookHashes: Partial<Record<(typeof hookNames)[number], string>>;
};

// The launcher publishes the digest in run.json only after every file exists.
export function saveActionSnapshot(runDir: string, action: LoadedAction, projectDir: string): string {
	const dir = join(runDir, "action-snapshot");
	fs.mkdirSync(dir, { mode: 0o700 });
	const hookHashes: Snapshot["hookHashes"] = {};
	for (const name of hookNames) {
		const source = action.hooks[name];
		if (!source) continue;
		fs.accessSync(source, fs.constants.X_OK);
		const bytes = fs.readFileSync(source);
		fs.writeFileSync(join(dir, name), bytes, { mode: 0o500, flag: "wx" });
		hookHashes[name] = digest(bytes);
	}
	const notes = join(projectDir, "AGENTS.md");
	const { name, scope, dir: sourceDir, orchestrator, agents, stages, hooks } = action;
	const snapshot: Snapshot = {
		version: 1,
		name,
		scope,
		dir: sourceDir,
		orchestrator,
		agents,
		stageContext: action.stageContext,
		stages,
		hooks,
		hookHashes,
		projectNotes: fs.existsSync(notes) ? fs.readFileSync(notes, "utf8") : null,
	};
	const bytes = Buffer.from(JSON.stringify(snapshot));
	fs.writeFileSync(join(dir, "definition.json"), bytes, { mode: 0o400, flag: "wx" });
	return digest(bytes);
}

export function readActionSnapshot(runDir: string, expected: string | undefined): Snapshot {
	if (!expected) throw Error("Missing action snapshot for this run; start a new run");
	const dir = join(runDir, "action-snapshot");
	try {
		if (!fs.lstatSync(dir).isDirectory()) throw Error("not a directory");
		const verified = (name: string, hash: string | undefined) => {
			const path = join(dir, name);
			if (!fs.lstatSync(path).isFile()) throw Error(`${name} is not a regular file`);
			const bytes = fs.readFileSync(path);
			if (digest(bytes) !== hash) throw Error(`${name} checksum mismatch`);
			return bytes;
		};
		const snapshot: Snapshot = JSON.parse(verified("definition.json", expected).toString("utf8"));
		if (snapshot.version !== 1) throw Error("unsupported version");
		for (const name of hookNames)
			if (snapshot.hooks[name]) {
				verified(name, snapshot.hookHashes[name]);
				fs.accessSync(join(dir, name), fs.constants.X_OK);
			}
		return snapshot;
	} catch (err) {
		throw Error(`Invalid action snapshot: ${err instanceof Error ? err.message : err}`);
	}
}
