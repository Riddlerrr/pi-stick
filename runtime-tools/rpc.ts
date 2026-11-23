import type { ConversationId } from "@earendil-works/pi-durable";

export type AgentRpc = (
	method: string,
	params: Record<string, unknown>,
	id: ConversationId,
) => Promise<{ text: string; error?: boolean }>;
