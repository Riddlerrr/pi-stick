import { main } from "./main.ts";

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (err) {
	console.error("pistick:", err instanceof Error ? err.message : err);
	process.exitCode = 1;
}
