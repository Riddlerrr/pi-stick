import type { ToolCall } from "../protocol.ts";
export type AgentRpc = (request: ToolCall, agent: string) => Promise<{ text: string; error?: boolean }>;
