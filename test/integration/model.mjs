// Local OpenAI-compatible endpoint. The ledger survives runner/container restarts.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const ledger = "/scratch/requests";
createServer(async (req, res) => {
	if (req.url === "/ready") return res.end("ok");
	if (req.method !== "POST" || req.url !== "/v1/chat/completions") return res.writeHead(404).end();
	let body = "";
	for await (const chunk of req) body += chunk;
	const { messages } = JSON.parse(body);
	const prompt = messages.filter(m => m.role === "user").at(-1)?.content ?? "";
	const step = prompt.startsWith("stage-A") ? "A" : prompt.startsWith("stage-B") ? "B" : prompt === "follow-up" ? "follow-up" : "root";
	const previous = existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n") : [];
	appendFileSync(ledger, `${step}\n`);
	if (["B", "follow-up"].includes(step) && !previous.includes(step)) return; // Host kills the agent with this request pending.
	const answers = {
		A: "result-A",
		B: prompt.includes("result-A") ? "result-B" : "missing handoff",
		root: prompt.includes("result-A") && prompt.includes("result-B") ? "initial report" : "missing stage results",
		"follow-up": messages.some(m => m.role === "assistant" && m.content === "initial report") ? "continued report" : "missing history",
	};
	const chunk = { choices: [{ index: 0, delta: { role: "assistant", content: answers[step] }, finish_reason: "stop" }] };
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}).listen(8123, "0.0.0.0");
