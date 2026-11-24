import type { ConversationId } from "@earendil-works/pi-durable";

import type { RpcCall } from "./protocol.ts";
export type AgentRpc = (request: RpcCall, id: ConversationId) => Promise<{ text: string; error?: boolean }>;
