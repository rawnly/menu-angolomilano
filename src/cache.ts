import { Data, Effect } from "effect";
import { CloudflareEnv } from "./types";

class KVException extends Data.TaggedError("KVException")<{
	cause: unknown;
	operation: "read" | "get";
}> {}

export const cached =
	<A>(
		key: string,
		options?: {
			ttl?: number;
			shouldCache?(data: A): boolean;
		},
	) =>
	<E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			const env = yield* CloudflareEnv;

			const cached = yield* Effect.tryPromise({
				try: () => env.ANGOLOMILANO_MENU_KV.get<A>(key, "json"),
				catch: (cause) => new KVException({ cause, operation: "read" }),
			});

			if (cached) {
				yield* Effect.logDebug("cache hit");
				return cached;
			}

			yield* Effect.logDebug("cache miss");

			const data = yield* effect;

			if (!options?.shouldCache || options.shouldCache(data)) {
				yield* Effect.tryPromise({
					try: () =>
						env.ANGOLOMILANO_MENU_KV.put(key, JSON.stringify(data), {
							expirationTtl: options?.ttl ?? 60 * 60 * 12,
						}),
					catch: (cause) => new KVException({ cause, operation: "read" }),
				});
			}

			return data;
		});
