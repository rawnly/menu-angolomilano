import {
	Array as Arr,
	Console,
	Data,
	Duration,
	Effect,
	Option,
	pipe,
	Schedule,
} from "effect";
import { scrapeStories } from "./scraper";
import {
	broadcastMenu,
	buildMenuBlocks,
	getBotUserId,
	postToResponseUrl,
	type SlackEnv,
	trackChannelJoin,
	untrackChannel,
	verifySlackSignature,
} from "./slack";
import { CloudflareEnv } from "./types";

const extractData = Effect.gen(function* () {
	const date = new Date().toDateString();

	const imagesURLs = yield* scrapeStories.pipe(
		Effect.retry(
			Schedule.exponential(Duration.seconds(2)).pipe(
				Schedule.upTo(Duration.seconds(10)),
			),
		),
		cached(`IMAGES_${date}`, {
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
		cached(`DATA_${date}`, {
			shouldCache: (data) => data.length > 0,
		}),
	);

	return yield* Arr.head(processed);
});

const invalidSignature = Effect.succeed(
	new Response("invalid signature", { status: 401 }),
);

const handleSlashCommand = (req: Request) =>
	Effect.gen(function* () {
		const rawBody = yield* Effect.promise(() => req.text());

		yield* verifySlackSignature(
			req.headers.get("X-Slack-Request-Timestamp"),
			req.headers.get("X-Slack-Signature"),
			rawBody,
		);

		const params = new URLSearchParams(rawBody);
		const responseUrl = params.get("response_url");
		if (!responseUrl) {
			return new Response("missing response_url", { status: 400 });
		}

		const deferred = extractData.pipe(
			Effect.andThen((data) =>
				postToResponseUrl(responseUrl, {
					response_type: "in_channel",
					text: "MENUANGOLO",
					blocks: buildMenuBlocks(data.url),
				}),
			),
			Effect.catchAll((cause) =>
				Effect.gen(function* () {
					yield* Console.error("slash command failed", cause);
					yield* postToResponseUrl(responseUrl, {
						response_type: "ephemeral",
						text: "Menu not available yet, try later.",
					});
				}),
			),
		);

		yield* Effect.forkDaemon(deferred);

		return new Response("", { status: 200 });
	}).pipe(
		Effect.catchTag("SlackSignatureError", () => invalidSignature),
		Effect.catchAll((cause) => {
			console.error(cause);
			return Effect.succeed(new Response("internal error", { status: 500 }));
		}),
	);

type SlackEvent = {
	type: string;
	challenge?: string;
	event?: { type: string; user?: string; channel?: string };
};

const handleEvents = (req: Request) =>
	Effect.gen(function* () {
		const rawBody = yield* Effect.promise(() => req.text());

		yield* verifySlackSignature(
			req.headers.get("X-Slack-Request-Timestamp"),
			req.headers.get("X-Slack-Signature"),
			rawBody,
		);

		const payload = JSON.parse(rawBody) as SlackEvent;

		if (payload.type === "url_verification") {
			return Response.json({ challenge: payload.challenge });
		}

		if (payload.type === "event_callback" && payload.event) {
			const event = payload.event;
			yield* Effect.forkDaemon(
				Effect.gen(function* () {
					const botId = yield* getBotUserId;
					if (event.user !== botId || !event.channel) return;
					if (event.type === "member_joined_channel") {
						yield* trackChannelJoin(event.channel);
					} else if (event.type === "member_left_channel") {
						yield* untrackChannel(event.channel);
					}
				}).pipe(Effect.catchAll((cause) => Console.error(cause))),
			);
		}

		return new Response("", { status: 200 });
	}).pipe(
		Effect.catchTag("SlackSignatureError", () => invalidSignature),
		Effect.catchAll((cause) => {
			console.error(cause);
			return Effect.succeed(new Response("internal error", { status: 500 }));
		}),
	);

const router = (req: Request) => {
	const url = new URL(req.url);
	if (req.method === "POST" && url.pathname === "/slack/commands") {
		return handleSlashCommand(req);
	}
	if (req.method === "POST" && url.pathname === "/slack/events") {
		return handleEvents(req);
	}
	return extractData.pipe(
		Effect.andThen((data) => Response.json({ ok: true, data })),
		Effect.catchTag("NoSuchElementException", () =>
			Effect.succeed(
				Response.json({ ok: false, code: "NOT_FOUND" }, { status: 404 }),
			),
		),
		Effect.catchAll((cause) => {
			console.error(cause);
			return Effect.succeed(
				Response.json(
					{ ok: false, code: (cause as { _tag?: string })._tag, cause },
					{ status: 500 },
				),
			);
		}),
	);
};

const runWithEnv = <A, E>(effect: Effect.Effect<A, E, CloudflareEnv>, env: Env) =>
	effect.pipe(Effect.provideService(CloudflareEnv, env), Effect.runPromise);

export default {
	async scheduled(_, env) {
		await runWithEnv(
			extractData.pipe(
				Effect.andThen((data) => broadcastMenu(data.url)),
				Effect.tapError(Console.error),
				Effect.catchAll(() => Effect.void),
			),
			env,
		);
	},

	async fetch(req, env): Promise<Response> {
		return runWithEnv(router(req), env as SlackEnv);
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
