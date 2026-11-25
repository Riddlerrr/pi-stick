import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

// Private to one tool call; keep Pi's filename variants virtual until each access passes the agent's policy.
export class AgentExecutionEnv extends NodeExecutionEnv {
	private readonly resolve: (path: string) => string;

	constructor(cwd: string, resolve: (path: string) => string) {
		super({ cwd });
		this.resolve = resolve;
	}

	override async absolutePath(path: string) {
		return { ok: true as const, value: path };
	}

	override exists(path: string, context: Context) {
		return super.exists(this.resolve(path), context);
	}

	override openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context) {
		return super.openBinaryReader(this.resolve(path), { noFollow: true }, context);
	}
}
