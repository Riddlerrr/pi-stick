import { command, devMode, run } from "./platform.ts";

export const IMAGE = process.env.PI_STICK_IMAGE || (devMode ? "pi-stick:dev" : "pi-stick:current");

export const agentName = (id: string) => `pi-stick-agent-${id}`;

export function removeOrphanAgent(id: string) {
	const opts = { timeout: 5000, killSignal: "SIGKILL" } as const;
	const lookup = () =>
		command(
			[
				"docker",
				"ps",
				"-a",
				"--no-trunc",
				"--filter",
				`name=^/${agentName(id)}$`,
				"--format",
				'{{.ID}} {{.Label "pi-stick.run"}}',
			],
			opts,
		)
			.toString()
			.trim();
	const found = lookup();
	if (!found) return;
	const [container, owner] = found.split(" ");
	if (!/^[0-9a-f]{64}$/.test(container) || owner !== id)
		throw Error(`Cannot verify ownership of ${agentName(id)}; refusing to remove it`);
	try {
		run(["docker", "rm", "-f", container], opts);
	} catch (err) {
		// --rm may have already removed the agent after its stdin closed.
		if (lookup()) throw err;
		return;
	}
	if (lookup()) throw Error(`Agent container for run ${id} still exists`);
}

export function isolatedRun(network: string) {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	if (!uid || gid === undefined) throw Error("Refusing to launch agent container as root");
	return [
		"docker",
		"run",
		"--rm",
		"-i",
		"--init",
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges:true",
		"--tmpfs",
		"/tmp:rw,nosuid,nodev,size=512m",
		"--memory",
		"2g",
		"--pids-limit",
		"128",
		"--user",
		`${uid}:${gid}`,
		"--network",
		network,
	];
}
