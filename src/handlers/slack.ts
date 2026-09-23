import { Effect, Logger, Option } from "effect";
import { formatText } from "../image-extraction";
import { extractData } from "../menu";
import { isSameMenu, textSimilarity } from "../text-similarity";
import {
	broadcastMenu,
	getBotUserId,
	getLastPublishedMenu,
	postMenu,
	postToResponseUrl,
	setLastPublishedMenu,
	trackChannelJoin,
	untrackChannel,
	verifySlackSignature,
} from "../slack";
import { CloudflareContext, CloudflareEnv } from "../types";

const runInBackground = <A, E>(
	effect: Effect.Effect<A, E, CloudflareEnv>,
) =>
	Effect.gen(function* () {
		const env = yield* CloudflareEnv;
		const ctx = yield* CloudflareContext;
		const promise = Effect.runPromise(
			effect.pipe(
				Effect.catchAll((cause) =>
					Effect.logError("background task failed", { cause }),
				),
				Effect.provideService(CloudflareEnv, env),
				Effect.provide(Logger.json),
			) as Effect.Effect<unknown, never, never>,
		);
		ctx.waitUntil(promise);
	});

export const handleSlashCommand = (req: Request) =>
	Effect.gen(function* () {
		const rawBody = yield* Effect.promise(() => req.text());

		yield* verifySlackSignature(
			req.headers.get("X-Slack-Request-Timestamp"),
			req.headers.get("X-Slack-Signature"),
			rawBody,
		);

		const params = new URLSearchParams(rawBody);
		yield* Effect.logInfo("slash command payload", {
			payload: Object.fromEntries(params.entries()),
		});
		const responseUrl = params.get("response_url");
		const channelId = params.get("channel_id");
		if (!responseUrl || !channelId) {
			return new Response("missing response_url or channel_id", { status: 400 });
		}

		const deferred = Effect.gen(function* () {
			yield* trackChannelJoin(channelId).pipe(
				Effect.catchAll((cause) =>
					Effect.logError("trackChannelJoin failed", { cause, channelId }),
				),
			);
			const data = yield* extractData;
			yield* postMenu(channelId, data.url, data.markdown);
		}).pipe(
			Effect.catchAll((cause) =>
				Effect.gen(function* () {
					yield* Effect.logError("slash command deferred failed", { cause });
					yield* postToResponseUrl(responseUrl, {
						response_type: "ephemeral",
						text: "Menu not available yet, try later.",
					});
				}),
			),
		);

		yield* runInBackground(deferred);

		return new Response(null, { status: 204 });
	}).pipe(
		Effect.tapError((cause) =>
			Effect.logError("slash command failed", { cause }),
		),
		Effect.withSpan("slack.commands"),
	);

type SlackEvent = {
	type: string;
	challenge?: string;
	event?: { type: string; user?: string; channel?: string };
};

export const handleEvents = (req: Request) =>
	Effect.gen(function* () {
		const rawBody = yield* Effect.promise(() => req.text());

		yield* verifySlackSignature(
			req.headers.get("X-Slack-Request-Timestamp"),
			req.headers.get("X-Slack-Signature"),
			rawBody,
		);

		const payload = JSON.parse(rawBody) as SlackEvent;
		yield* Effect.logInfo("slack event received", { payload });

		if (payload.type === "url_verification") {
			return Response.json({ challenge: payload.challenge });
		}

		if (payload.type === "event_callback" && payload.event) {
			const event = payload.event;
			yield* Effect.gen(function* () {
				const botId = yield* getBotUserId;
				yield* Effect.logDebug("event dispatch", {
					event,
					botId,
					isSelf: event.user === botId,
				});
				if (event.user !== botId || !event.channel) return;
				if (event.type === "member_joined_channel") {
					yield* Effect.logInfo("tracking channel join", {
						channel: event.channel,
					});
					yield* trackChannelJoin(event.channel);
				} else if (event.type === "member_left_channel") {
					yield* Effect.logInfo("untracking channel", {
						channel: event.channel,
					});
					yield* untrackChannel(event.channel);
				}
			}).pipe(
				Effect.tapError((cause) =>
					Effect.logError("event handling failed", { cause, event }),
				),
				Effect.catchAll(() => Effect.void),
			);
		}

		return new Response(null, { status: 204 });
	}).pipe(Effect.withSpan("slack.events"));

export const handleBroadcast = (imageUrl: string, menuText: string) =>
	Effect.gen(function* () {
		const lastPublished = yield* getLastPublishedMenu;
		if (lastPublished !== null) {
			const similarity = textSimilarity(lastPublished, menuText);
			yield* Effect.logInfo("menu similarity vs last publish", {
				similarity,
				exactMatch: lastPublished === menuText,
			});
			// Same photo can come back with slightly different OCR text (proxy
			// re-encodes bytes on every fetch, vision model isn't fully
			// deterministic) - treat near-identical text as "nothing changed"
			// instead of only exact string equality, to avoid re-broadcasting
			// the same menu photo.
			if (isSameMenu(lastPublished, menuText)) {
				yield* Effect.logInfo("menu unchanged since last publish, skipping", {
					similarity,
				});
				return;
			}
		}

		const markdown = yield* formatText(menuText).pipe(
			Effect.option,
			Effect.andThen(Option.getOrNull),
		);
		yield* broadcastMenu(imageUrl, markdown);
		yield* setLastPublishedMenu(menuText);
	}).pipe(
		Effect.tapError((cause) => Effect.logError("cron failed", { cause })),
		Effect.catchAll(() => Effect.void),
		Effect.withSpan("scheduled.broadcast"),
	);
