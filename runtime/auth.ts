import type { Credential } from "@earendil-works/pi-ai";
import type { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import type { AccessLease, CredentialPayload } from "./protocol.ts";

export function runtimeCredentials(
	payloads: Record<string, CredentialPayload>,
	providers: ReturnType<typeof builtinProviders>,
	renew: (provider: string) => Promise<AccessLease>,
) {
	const entries = new Map(Object.entries(payloads));
	const oauth = new Set(
		providers
			.filter(({ id, auth }) => {
				const payload = entries.get(id);
				return (
					payload &&
					(payload.authType === "oauth" || (payload.authType !== "api_key" && !auth.apiKey && auth.oauth))
				);
			})
			.map(({ id }) => id),
	);
	const pending = new Map<string, Promise<AccessLease>>();
	return {
		list: async () =>
			[...entries.keys()].map((providerId) => ({
				providerId,
				type: oauth.has(providerId) ? ("oauth" as const) : ("api_key" as const),
			})),
		read: async (id: string): Promise<Credential | undefined> => {
			let lease = entries.get(id);
			if (!lease) return undefined;
			if (!oauth.has(id)) return { type: "api_key", key: lease.token };
			if (!(lease.validUntil > Date.now() + 60_000)) {
				let request = pending.get(id);
				if (!request) {
					request = renew(id)
						.then((next) => {
							if (
								typeof next.token !== "string" ||
								!next.token ||
								!Number.isFinite(next.validUntil) ||
								!(next.validUntil > Date.now() + 60_000)
							)
								throw Error("Invalid OAuth lease from host");
							entries.set(id, next);
							return next;
						})
						.finally(() => pending.delete(id));
					pending.set(id, request);
				}
				lease = await request;
			}
			// The host manages expiry; pi-ai must not attempt provider refresh with the exported bearer.
			return { type: "oauth", access: lease.token, refresh: "", expires: Infinity };
		},
		modify: async (): Promise<never> => {
			throw Error("Agent runtime credentials are read-only");
		},
		delete: async (): Promise<never> => {
			throw Error("Agent runtime credentials are read-only");
		},
	};
}
