import { Effect, Logger, LogLevel, Ref } from "effect";
import {
	handleBroadcast,
	handleEvents,
	handleSlashCommand,
} from "./handlers/slack";
import { extractData } from "./menu";
import { type SlackEnv } from "./slack";
import {
	CacheOptions,
	CacheStatusRef,
	type CacheStatusValue,
	CloudflareContext,
	CloudflareEnv,
} from "./types";

const shouldSkipCache = (req: Request) => {
	const cc = req.headers.get("cache-control");
	if (!cc) return false;
	return cc
		.split(",")
		.map((token) => token.trim().toLowerCase())
		.includes("no-cache");
};

const router = (req: Request) => {
	const url = new URL(req.url);
	if (req.method === "POST" && url.pathname === "/slack/commands") {
		return handleSlashCommand(req);
	}
	if (req.method === "POST" && url.pathname === "/slack/events") {
		return handleEvents(req);
	}
	const skip = shouldSkipCache(req);
	return Effect.gen(function* () {
		const statusRef = yield* Ref.make<CacheStatusValue>("HIT");
		const data = yield* extractData.pipe(
			Effect.provideService(CacheStatusRef, statusRef),
			Effect.provideService(CacheOptions, { skip }),
		);
		const status = yield* Ref.get(statusRef);
		return Response.json(
			{ ok: true, data },
			{ headers: { "X-Cache": skip ? "MISS" : status } },
		);
	}).pipe(Effect.withSpan("data-extraction"));
};

type InferError<T> = T extends Effect.Effect<any, infer U, any> ? U : never;
type RouterErrors = InferError<ReturnType<typeof router>>;

const runWithEnv = <A>(
	effect: Effect.Effect<A, RouterErrors, CloudflareEnv | CloudflareContext>,
	env: Env,
	ctx: ExecutionContext,
) =>
	effect.pipe(
		Effect.catchTags({
			SlackTransportError: () =>
				Effect.succeed(new Response(null, { status: 500 })),
			SlackSignatureError: () =>
				Effect.succeed(new Response(null, { status: 401 })),
			NoSuchElementException: () =>
				Effect.succeed(new Response(null, { status: 404 })),
		}),
		Effect.catchAll((cause) =>
			Effect.logError("operation failed", { cause }).pipe(
				Effect.as(
					Response.json(
						{ ok: false, code: (cause as { _tag?: string })._tag, cause },
						{ status: 500 },
					),
				),
			),
		),
		Effect.provideService(CloudflareEnv, env),
		Effect.provideService(CloudflareContext, ctx),
		Effect.provide(Logger.json),
		Logger.withMinimumLogLevel(LogLevel.Debug),
		Effect.runPromise,
	);

export default {
	async scheduled(_, env, ctx) {
		await runWithEnv(
			extractData.pipe(Effect.andThen((data) => handleBroadcast(data.url))),
			env,
			ctx,
		);
	},

	async fetch(req, env, ctx): Promise<Response> {
		return runWithEnv(router(req), env as SlackEnv, ctx);
	},
} satisfies ExportedHandler<Env>;
