import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { CONTAINER_REPO_DIR } from "../paths.ts";

export const readTool = createReadTool({ images: await createNodePhotonImages() });

export function withReadDiagnostics(read: typeof readTool): typeof readTool {
	return {
		...read,
		description: `${read.description} Use bash or find for directories. Relative paths start at ${CONTAINER_REPO_DIR}; /scratch/... and /context/... are also readable.`,
		replay: "safe",
		async execute(args, api, context) {
			const result = await read.execute(args, api, context);
			if (!("structuredOutput" in result)) return result;
			const value = result.structuredOutput;
			const note = result.diagnostics?.map((d) => d.message).join("\n");
			if (typeof value === "string" && note) return { ...result, structuredOutput: `${value}\n\n[${note}]` };
			if (value && typeof value === "object" && !Array.isArray(value) && value.type === "image")
				return { ...result, structuredOutput: { ...value, note: note ?? "" } };
			return result;
		},
	};
}
