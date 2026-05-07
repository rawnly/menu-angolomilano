import {
	Array as Arr,
	Data,
	Duration,
	Effect,
	Option,
	pipe,
	Schedule,
} from "effect";
import { scrapeStories } from "./scraper";
import { CloudflareEnv } from "./types";

export default {
	async fetch(_, env): Promise<Response> {
		return Effect.gen(function* () {
			const date = new Date().toDateString();
			const imagesURLs = yield* scrapeStories.pipe(
				Effect.retry(
					Schedule.exponential(Duration.seconds(2)).pipe(
						Schedule.upTo(Duration.seconds(10)),
					),
				),
				cached(date, {
					shouldCache: (data) => data.length > 0,
				}),
			);

			const processed = yield* pipe(
				imagesURLs,
				Effect.forEach(extractImageText, {
					concurrency: "unbounded",
				}),
				Effect.andThen(Arr.filter(Option.isSome)),
				Effect.tap(Effect.log),
				Effect.andThen(
					Arr.filterMap(
						Option.filter(
							(el) =>
								el.text.toLowerCase().includes("primo") &&
								el.text.toLowerCase().includes("secondo") &&
								el.text.toLowerCase().includes("contorno") &&
								el.text.toLowerCase().includes("semper verd"),
						),
					),
				),
			);

			const result = yield* Arr.head(processed);

			return Response.json(result);
		}).pipe(
			Effect.provideService(CloudflareEnv, env),
			Effect.catchTags({
				NoSuchElementException: () =>
					Effect.succeed(new Response(null, { status: 404 })),
				AIException: (cause) => {
					console.error(cause);

					return Effect.succeed(
						Response.json(
							{
								cause,
							},
							{ status: 500 },
						),
					);
				},
			}),
			Effect.runPromise,
		);
	},
} satisfies ExportedHandler<Env>;

const cached =
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
				yield* Effect.log("cache hit");
				return cached;
			}
			yield* Effect.log("cache miss");

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

const extractImageText = (url: string) =>
	Effect.gen(function* () {
		const env = yield* CloudflareEnv;

		const bytes = yield* Effect.tryPromise(() => fetch(url)).pipe(
			Effect.filterOrFail(
				(response) => response.ok,
				(response) =>
					new FetchError({
						cause: response.status.toString(),
					}),
			),
			Effect.filterOrFail(
				(response) =>
					response.headers.get("Content-Type")?.startsWith("image/") === true,
				(cause) =>
					new ImageException({ cause: cause.headers.get("Content-Type") }),
			),
			Effect.andThen((res) => Effect.tryPromise(() => res.arrayBuffer())),
			Effect.andThen((buffer) => new Uint8Array(buffer)),
		);

		const ocrData = yield* Effect.tryPromise({
			try: () =>
				env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
					image: [...bytes],
					prompt: `transcribe ALL the text visible in this image exactly as written.
					Include every word, number and price. if theres no text reploy exactly: NO_TEXT.
					Otherwise reply with ONLY the transcribed text - no commentary, no explanations.`,
					max_tokens: 800,
				}),
			catch: (cause) => new AIException({ cause }),
		}).pipe(
			Effect.map((ocr) => String(ocr.response)?.trim() ?? ""),
			Effect.map((s) =>
				s.length > 10 && !s.toUpperCase().includes("NO_TEXT")
					? Option.some({ url, text: s })
					: Option.none(),
			),
		);

		return ocrData;
	});

class KVException extends Data.TaggedError("KVException")<{
	cause: unknown;
	operation: "read" | "get";
}> {}
class AIException extends Data.TaggedError("AIException")<{ cause: unknown }> {}

class FetchError extends Data.TaggedError("FetchError")<{ cause: unknown }> {}

class ImageException extends Data.TaggedError("ImageException")<{
	cause: unknown;
}> {}
