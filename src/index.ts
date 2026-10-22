import { Effect, Logger, LogLevel } from "effect";
import { handleApi } from "./handlers/api";
import {
	handleBroadcast,
	handleEvents,
	handleSlashCommand,
} from "./handlers/slack";
import { refreshMenu } from "./menu";
import { type SlackEnv } from "./slack";
export { MenuRefresher } from "./menu-refresher";
import { recordRun } from "./runs";
import { CloudflareContext, CloudflareEnv } from "./types";

const router = (req: Request) => {
	const url = new URL(req.url);
	if (req.method === "POST" && url.pathname === "/slack/commands") {
		return handleSlashCommand(req);
	}
	if (req.method === "POST" && url.pathname === "/slack/events") {
		return handleEvents(req);
	}
	if (url.pathname.startsWith("/api/")) {
		return handleApi(req);
	}
	return Effect.succeed(new Response("Not found", { status: 404 }));
};

type InferError<T> = T extends Effect.Effect<any, infer U, any> ? U : never;
type RouterErrors = InferError<ReturnType<typeof router>>;

const runWithEnv = <A>(
	effect: Effect.Effect<A, RouterErrors, CloudflareEnv | CloudflareContext>,
	env: Env,
	ctx: ExecutionContext,
) =>
	effect.pipe(
		Effect.catchAll((error) => {
			const e = error as { _tag?: string; reason?: string; status?: number };
			switch (e._tag) {
				case "SlackTransportError":
					return Effect.succeed(new Response(null, { status: 500 }));
				case "SlackSignatureError":
					return Effect.succeed(new Response(null, { status: 401 }));
				case "NoSuchElementException":
					return Effect.succeed(new Response(null, { status: 404 }));
				case "ScrapeBusy":
					return Effect.succeed(
						Response.json(
							{ ok: false, error: "a refresh is already running, try again shortly" },
							{ status: 409 },
						),
					);
				case "AccessError":
					return Effect.succeed(
						Response.json(
							{ ok: false, error: e.reason },
							{ status: e.status ?? 401 },
						),
					);
				default:
					return Effect.logError("operation failed", { cause: error }).pipe(
						Effect.as(
							Response.json(
								{ ok: false, code: e._tag, cause: error },
								{ status: 500 },
							),
						),
					);
			}
		}),
		Effect.provideService(CloudflareEnv, env),
		Effect.provideService(CloudflareContext, ctx),
		Effect.provide(Logger.json),
		Logger.withMinimumLogLevel(LogLevel.Debug),
		Effect.runPromise,
	);

export default {
	async scheduled(_, env, ctx) {
		await runWithEnv(
			refreshMenu.pipe(
				Effect.andThen((data) => handleBroadcast(data.url, data.text)),
				recordRun("cron"),
				// failures are already logged + recorded; don't fail the cron
				Effect.catchAll(() => Effect.void),
			),
			env,
			ctx,
		);
	},

	async fetch(req, env, ctx): Promise<Response> {
		return runWithEnv(router(req), env as SlackEnv, ctx);
	},
} satisfies ExportedHandler<Env>;
