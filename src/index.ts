import { Data, Effect, Logger } from "effect";
import { handleBroadcast, handleEvents, handleSlashCommand } from "./handlers/slack";
import { extractData } from "./menu";
import { type SlackEnv } from "./slack";
import { CloudflareEnv } from "./types";

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
		Effect.catchAll((cause) =>
			Effect.logError("debug fetch failed", { cause }).pipe(
				Effect.as(
					Response.json(
						{ ok: false, code: (cause as { _tag?: string })._tag, cause },
						{ status: 500 },
					),
				),
			),
		),
	);
};

const runWithEnv = <A, E>(
	effect: Effect.Effect<A, E, CloudflareEnv>,
	env: Env,
) =>
	effect.pipe(
		Effect.provideService(CloudflareEnv, env),
		Effect.provide(Logger.json),
		Effect.runPromise,
	);

export default {
	async scheduled(_, env) {
		await runWithEnv(
			extractData.pipe(Effect.andThen((data) => handleBroadcast(data.url))),
			env,
		);
	},

	async fetch(req, env): Promise<Response> {
		return runWithEnv(router(req), env as SlackEnv);
	},
} satisfies ExportedHandler<Env>;
