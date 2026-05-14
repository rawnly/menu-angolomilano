import { Data, Effect, Ref } from "effect";
import { CacheOptions, CacheStatusRef, CloudflareEnv } from "./types";

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
			const statusRef = yield* Effect.serviceOption(CacheStatusRef);
			const cacheOpts = yield* Effect.serviceOption(CacheOptions);
			const skip = cacheOpts._tag === "Some" && cacheOpts.value.skip;

			if (!skip) {
				const cached = yield* Effect.tryPromise({
					try: () => env.ANGOLOMILANO_MENU_KV.get<A>(key, "json"),
					catch: (cause) => new KVException({ cause, operation: "read" }),
				});

				if (cached) {
					yield* Effect.logDebug("cache hit");
					if (statusRef._tag === "Some") {
						yield* Ref.update(statusRef.value, (s) =>
							s === "MISS" ? s : "HIT",
						);
					}
					return cached;
				}
			} else {
				yield* Effect.logDebug("cache bypass");
			}

			yield* Effect.logDebug("cache miss");
			if (statusRef._tag === "Some") {
				yield* Ref.set(statusRef.value, "MISS");
			}

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
