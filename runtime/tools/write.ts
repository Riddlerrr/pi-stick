import { createWriteTool } from "@earendil-works/pi-durable/tools";

const write = createWriteTool();
export const writeTool = {
	...write,
	description: `${write.description} In read-only mode, writes are restricted to your agent scratch directory.`,
};
