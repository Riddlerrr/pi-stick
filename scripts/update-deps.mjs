import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


async function verifyRuntime(stage, probe) {
	const file = join(stage, "Dockerfile");
	const dockerfile = readFileSync(file, "utf8");
	const from = /^FROM (node:\d+-[\w-]+)@sha256:[a-f0-9]{64}$/m.exec(dockerfile);
	const npmPin = /^ARG NPM_VERSION=\d+\.\d+\.\d+$/m;
	if (!from || !npmPin.test(dockerfile)) throw Error("Expected pinned Node and npm versions in Dockerfile");
	const manifest = execFileSync("docker", ["buildx", "imagetools", "inspect", from[1]], { encoding: "utf8" });
	const digest = /^Digest:\s+(sha256:[a-f0-9]{64})$/m.exec(manifest)?.[1];
	const npm = execFileSync("npm", ["view", "npm@latest", "version"], { encoding: "utf8" }).trim();
	if (!digest || !/^\d+\.\d+\.\d+$/.test(npm)) throw Error("Cannot resolve Node digest or npm version");
	writeFileSync(file, dockerfile.replace(from[0], `FROM ${from[1]}@${digest}`).replace(npmPin, `ARG NPM_VERSION=${npm}`));
	const image = `pi-stick:deps-${randomUUID()}`;
	execFileSync("docker", ["build", "-t", image, stage], { stdio: "inherit" });
	try {
		await probe(image);
	} finally {
		execFileSync("docker", ["image", "rm", image], { stdio: "inherit" });
	}
}

process.chdir(join(import.meta.dirname, ".."));
const mode = process.argv[2];
if (mode !== "runtime" && mode !== "dev") throw Error("Expected runtime or dev");
const runtime = mode === "runtime";
const files = ["package.json", "package-lock.json"];
const stage = mkdtempSync(join(tmpdir(), "pi-stick-deps-"));
try {
	const system = runtime ? await import("../src/system.ts") : undefined;
	if (system) system.imageFingerprint(stage, process.cwd());
	else for (const file of files) copyFileSync(file, join(stage, file));
	const pkg = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
	const deps = runtime ? pkg.dependencies : pkg.devDependencies;
	execFileSync("npm", [
		"install", runtime ? "--save-prod" : "--save-dev", "--package-lock-only", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund",
		...Object.keys(deps).map((name) => `${name}@latest`),
	], { cwd: stage, stdio: "inherit" });
	if (system) {
		await verifyRuntime(stage, system.probe);
		files.push("Dockerfile");
	}
	for (const file of files) copyFileSync(join(stage, file), file);
	console.log(`Review: git diff -- ${files.join(" ")}`);
} finally {
	rmSync(stage, { recursive: true, force: true });
}
