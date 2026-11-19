import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { command, output, run, STATE, touch } from "./platform.ts";
import { fresh, gitCommand, prepare } from "./snapshots.ts";
import { registered, SLUG } from "./workspace.ts";

export function target(url: string) {
	const match = new RegExp(`^https://github\\.com/(${SLUG})/pull/([1-9][0-9]{0,9})/?$`).exec(url);
	if (!match) throw Error("Expected a GitHub PR URL");
	const repository = match[1].toLowerCase(),
		folder = registered().get(repository);
	if (!folder) throw Error(`No project registered for ${repository}; use pi-stick create project NAME`);
	return new Project(repository, Number(match[2]), folder);
}
interface Mount {
	type: string;
	source: string;
	target: string;
}
interface Service {
	volumes?: Mount[];
	ports?: unknown[];
	privileged?: boolean;
	container_name?: string;
	network_mode?: string;
}
interface Resource {
	name: string;
	external?: boolean;
	driver_opts?: object;
}
interface ComposeConfig {
	services: Record<string, Service>;
	volumes?: Record<string, Resource>;
	networks?: Record<string, Resource>;
}
export const closed = (child: ChildProcess): Promise<[number | null, string | null]> =>
	once(child, "close") as Promise<[number | null, string | null]>;

export class Project {
	readonly repository: string;
	readonly number: number;
	readonly folder: string;
	readonly key: string;
	readonly root: string;
	readonly snapshot: string;
	readonly repo: string;
	readonly compose: string[];
	constructor(repository: string, number: number, folder: string) {
		this.repository = repository;
		this.number = number;
		this.folder = folder;
		this.key = `pi-stick-${basename(folder)}-${number}`;
		this.root = join(STATE, "projects", this.key);
		this.snapshot = join(this.root, "snapshot");
		this.repo = join(this.snapshot, "repo");
		this.compose = ["docker", "compose", "-p", this.key, "-f", join(this.root, "compose.yaml")];
	}
	config() {
		// The override is for local development only. Resolve the operator's base recipe explicitly.
		const conf: ComposeConfig = JSON.parse(
			output([
				"docker",
				"compose",
				"-p",
				this.key,
				"-f",
				join(this.folder, "compose.yaml"),
				"config",
				"--format",
				"json",
			]),
		);
		for (const group of [conf.volumes, conf.networks])
			for (const [key, resource] of Object.entries(group ?? {})) {
				if (
					resource.external ||
					Object.keys(resource.driver_opts ?? {}).length ||
					resource.name !== `${this.key}_${key}`
				)
					throw Error("Review recipes require PR-scoped volumes and networks");
			}
		for (const svc of Object.values(conf.services)) {
			if (
				svc.ports?.length ||
				svc.privileged ||
				svc.container_name ||
				svc.network_mode ||
				svc.volumes?.some((m) => m.type === "bind")
			)
				throw Error("Keep host mounts, ports and shared resources out of the base review recipe");
		}
		if (
			!conf.services.runner?.volumes?.some(
				(m) => m.type === "volume" && m.source === "source" && m.target === "/workspace",
			)
		)
			throw Error("The runner needs a private source volume at /workspace");
		return conf;
	}
	async pull() {
		if (fs.existsSync(join(this.root, basename(this.folder), "compose.yaml")))
			throw Error("Preserve or clean up the legacy PR stack first");
		const config = this.config();
		fs.mkdirSync(this.root, { recursive: true });
		touch(join(this.root, "last-used"));
		const data = prepare(this.repository, this.number, this.snapshot);
		fs.writeFileSync(
			join(this.root, "compose.yaml"),
			JSON.stringify(config).replaceAll("$", () => "$$"),
		);
		run([...this.compose, "up", "--build", "-d", "--wait", "--wait-timeout", "180"]);
		const ex = [...this.compose, "exec", "-T", "runner"];
		run([...ex, "sh", "-ec", "rm -rf /workspace/repo && mkdir /workspace/repo"]);
		const tar = spawn("tar", ["-C", this.repo, "-cf", "-", "."], { stdio: ["ignore", "pipe", "inherit"] });
		const copy = spawn(ex[0], [...ex.slice(1), "tar", "--no-same-owner", "-C", "/workspace/repo", "-xf", "-"], {
			stdio: ["pipe", "inherit", "inherit"],
		});
		try {
			const [a, b] = await Promise.all([closed(tar), closed(copy), pipeline(tar.stdout, copy.stdin)]);
			if (a[0] !== 0 || b[0] !== 0) throw Error("Failed to copy prepared sources");
		} finally {
			tar.kill();
			copy.kill();
		}
		run([...this.compose, "exec", "-T", "-w", "/workspace/repo", "runner", "/usr/local/bin/setup-project"]);
		fresh(data);
		return data;
	}
	async call(tool: string, args: { value?: unknown; offset?: unknown }) {
		const { value, offset = 0 } = args;
		if (
			typeof value !== "string" ||
			!value.length ||
			value.length > 1024 ||
			value.includes("\0") ||
			typeof offset !== "number" ||
			!Number.isSafeInteger(offset) ||
			offset < 0
		)
			throw Error("Invalid tool argument");
		const git = gitCommand(this.repo),
			obj = `review-head:${value}`;
		const requireBlob = () => {
			if (
				value.startsWith(":") ||
				value.split("/").some((p) => ["", ".", ".."].includes(p)) ||
				output([...git, "cat-file", "-t", obj]) !== "blob"
			)
				throw Error("Expected a committed repository-relative file");
		};
		let data: Buffer;
		if (tool === "read") {
			const meta = new Map(
				Object.entries({
					"@diff": "pr.diff",
					"@manifest": "manifest.json",
					"@threads": "context/review-threads.json",
					"@discussion": "context/discussion.json",
					"@pr": "context/pr.json",
				}),
			).get(value);
			if (meta) data = fs.readFileSync(join(this.snapshot, meta));
			else {
				requireBlob();
				data = command([...git, "cat-file", "blob", obj]);
			}
		} else if (tool === "search") {
			data = command(
				[...git, "grep", "--no-textconv", "-n", "-I", "-F", "-e", value, "review-head", "--"],
				{},
				[0, 1],
			);
		} else if (tool === "test") {
			if (!/^[\p{L}\p{N}_.][\p{L}\p{N}_./ -]*$/u.test(value)) throw Error("Expected one committed test file");
			requireBlob();
			const child = spawn(
				this.compose[0],
				[
					...this.compose.slice(1),
					"exec",
					"-T",
					"-w",
					"/workspace/repo",
					"runner",
					"timeout",
					"--kill-after=20s",
					"15m",
					"/usr/local/bin/test-file",
					value,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			let tail: Buffer = Buffer.alloc(0);
			const append = (chunk: Buffer) => {
				tail = Buffer.concat([tail, chunk]).subarray(-16000);
			};
			child.stdout.on("data", append);
			child.stderr.on("data", append);
			const [code, signal] = await closed(child);
			return { text: `exit=${code ?? signal}\n${tail}`, error: code !== 0 };
		} else throw Error("Unsupported tool");
		const text = data.toString(),
			end = offset + 16000;
		return { text: text.slice(offset, end) + (text.length > end ? `\n[more at offset ${end}]` : "") };
	}
}
