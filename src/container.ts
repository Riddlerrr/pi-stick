import { devMode } from "./platform.ts";

export const IMAGE = process.env.PI_STICK_IMAGE || (devMode ? "pi-stick:dev" : "pi-stick:current");

export const agentName = (id: string) => `pi-stick-agent-${id}`;

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
