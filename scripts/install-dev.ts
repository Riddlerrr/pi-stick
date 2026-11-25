import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { ASSETS, canonicalPath, isLocked, json, run, writeJson } from "../src/platform.ts";
import { readState } from "../src/run-state.ts";
import { parseModelSpec } from "../src/system.ts";
import { composeKey } from "../src/tasks.ts";

const usage = `Usage: ./scripts/install-dev.sh [OPTIONS]
Prepare an isolated dev directory for running ./pistick-dev from this checkout.
  --dir PATH     Dev directory (default: $PI_STICK_DEV_HOME or ~/pi-stick-dev)
  --fresh        Wipe a recognized dev directory after tearing down task stacks
  --model SPEC   Set default_model (provider/modelId, or "" to leave unset)
  --no-build     Skip building pi-stick:dev and running doctor
  -y, --yes      Accept defaults non-interactively
  -h, --help     Show this help`;

const stat = (path: string) => fs.lstatSync(path, { throwIfNoEntry: false });
function rejectLink(path: string) {
	if (stat(path)?.isSymbolicLink()) throw Error(`Refusing to use symlink: ${path}`);
}

function teardown(dir: string) {
	const runs = join(dir, "state/runs");
	if (!stat(runs)) return;
	const stacks: string[][] = [];
	for (const id of fs.readdirSync(runs)) {
		const folder = join(runs, id);
		rejectLink(folder);
		if (!stat(folder)?.isDirectory()) continue;
		const lock = join(folder, "lock");
		rejectLink(lock);
		if (isLocked(lock)) throw Error("Dev environment has an active task run; wait before wiping.");
		const compose = join(folder, "compose.yaml");
		if (!stat(compose)) continue;
		if (!/^[0-9a-f]{32}$/.test(id) || !stat(compose)?.isFile()) throw Error(`Unexpected Compose stack: ${folder}`);
		rejectLink(join(folder, "run.json"));
		stacks.push([
			"docker",
			"compose",
			"-p",
			composeKey(readState(folder).project, id),
			"-f",
			compose,
			"down",
			"--volumes",
		]);
	}
	// Resolve every key before tearing down even the first stack.
	for (const argv of stacks) run(argv);
}

function suggested(dev: string, pi: string, prod: string) {
	for (const [file, source] of [
		[dev, "existing dev settings"],
		[pi, "Pi settings"],
		[prod, "pi-stick settings"],
	]) {
		try {
			const data = json(file);
			let model = data.default_model;
			if (source === "Pi settings") {
				model = data.defaultModel;
				if (!model.includes("/") && typeof data.defaultProvider === "string")
					model = `${data.defaultProvider}/${model}`;
			}
			return { model: parseModelSpec(model).raw, source };
		} catch {
			/* Missing or invalid suggestions do not block installation. */
		}
	}
}

let input: ReturnType<typeof createInterface> | undefined;
let lines: AsyncIterator<string> | undefined;
async function ask(label: string) {
	process.stderr.write(`${label} `);
	input ??= createInterface({ input: process.stdin });
	lines ??= input[Symbol.asyncIterator]();
	const line = await lines.next();
	if (line.done) throw Error("No input received.");
	return line.value;
}
async function confirm(label: string, fallback: boolean) {
	for (;;) {
		const answer = (await ask(`${label} ${fallback ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
		if (!answer) return fallback;
		if (["y", "yes"].includes(answer)) return true;
		if (["n", "no"].includes(answer)) return false;
		console.error("Please enter y or n.");
	}
}

async function main() {
	process.umask(0o077);
	const { values } = parseArgs({
		options: {
			dir: { type: "string" },
			model: { type: "string" },
			fresh: { type: "boolean" },
			"no-build": { type: "boolean" },
			yes: { type: "boolean", short: "y" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) return console.log(usage);
	if (values.model) parseModelSpec(values.model);
	const home = homedir();
	const defaultDir = process.env.PI_STICK_DEV_HOME || join(home, "pi-stick-dev");
	let path =
		values.dir ?? (values.yes ? defaultDir : (await ask(`pi-stick dev directory [${defaultDir}]:`)) || defaultDir);
	if (path === "~" || path.startsWith("~/")) path = join(home, path.slice(2));
	if (!isAbsolute(path)) throw Error("Enter an absolute path or ~/path.");
	path = resolve(path);
	rejectLink(path);
	const dir = canonicalPath(path);
	const prodDir = canonicalPath(process.env.PI_STICK_HOME ?? join(home, "pi-stick"));
	const contains = (parent: string, child: string) =>
		parent === "/" || child === parent || child.startsWith(`${parent}/`);
	if (
		contains(dir, canonicalPath(home)) ||
		[ASSETS, prodDir].some((other) => contains(dir, other) || contains(other, dir))
	)
		throw Error(`Refusing to use unsafe dev directory path: ${dir}`);
	const settings = join(dir, "settings.json");
	const marker = join(dir, ".pi-stick-dev");
	const known = ["actions", "projects", "state", "settings.json", ".pi-stick-dev"];
	if (stat(dir)) {
		for (const name of [...known, "state/runs"]) {
			const path = join(dir, name);
			rejectLink(path);
			const entry = stat(path);
			if (entry && !(name === ".pi-stick-dev" || name === "settings.json" ? entry.isFile() : entry.isDirectory()))
				throw Error(`Unexpected dev directory entry: ${path}`);
		}
		if (!stat(marker)?.isFile() && fs.readdirSync(dir).some((entry) => !known.includes(entry)))
			throw Error(`Not a recognized pi-stick dev directory: ${dir}. Choose a new path.`);
		if (values.fresh || (!values.yes && (await confirm(`Wipe ${dir} and reinstall from scratch?`, false)))) {
			teardown(dir);
			fs.rmSync(dir, { recursive: true });
			console.log(`Removed existing dev directory: ${dir}`);
		}
	}
	const suggestion = suggested(settings, join(home, ".pi/agent/settings.json"), join(prodDir, "settings.json"));
	let model = values.model ?? suggestion?.model ?? "";
	if (values.model === undefined && !values.yes) {
		for (;;) {
			const answer = await ask(
				`Default model (provider/modelId, or '-' to leave unset) [${suggestion ? `${model} from ${suggestion.source}` : ""}]:`,
			);
			if (!answer) break;
			if (answer === "-") {
				model = "";
				break;
			}
			try {
				model = parseModelSpec(answer).raw;
				break;
			} catch {
				console.error("Expected model in 'provider/modelId' format.");
			}
		}
	}
	const data = stat(settings) ? json(settings) : {};
	if (!data || typeof data !== "object" || Array.isArray(data)) throw Error(`Expected an object in ${settings}`);
	if (model) data.default_model = parseModelSpec(model).raw;
	else delete data.default_model;
	for (const name of ["projects", "actions", "state/runs"]) fs.mkdirSync(join(dir, name), { recursive: true });
	fs.closeSync(fs.openSync(marker, "a"));
	writeJson(settings, data);
	console.log(`Prepared dev directory: ${dir}\nSettings: ${settings}`);
	if (dir !== canonicalPath(join(home, "pi-stick-dev")))
		console.log(`Set PI_STICK_DEV_HOME to ${dir} when running ./pistick-dev.`);
	if (values["no-build"]) return;
	const cli = join(ASSETS, "pistick-dev");
	const env = { ...process.env, PI_STICK_DEV_HOME: dir };
	const status = spawnSync(cli, ["containers", "status"], { env, stdio: "inherit" });
	if (status.error) throw status.error;
	if (status.status === 0) return;
	if (values.yes || (await confirm("Build the pi-stick:dev Docker image and run doctor?", true))) {
		run([cli, "containers", "build"], { env });
		run([cli, "doctor"], { env });
	} else console.log("To build and check later: ./pistick-dev containers build && ./pistick-dev doctor");
}

try {
	await main();
} catch (err) {
	console.error(`pi-stick dev installer: ${err instanceof Error ? err.message : err}`);
	process.exitCode = 1;
} finally {
	input?.close();
}
