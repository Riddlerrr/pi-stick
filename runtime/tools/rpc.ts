import type { ConversationId } from "@earendil-works/pi-durable";

import type { ToolCall } from "../protocol.ts";
export type AgentRpc = (request: ToolCall, id: ConversationId) => Promise<{ text: string; error?: boolean }>;
