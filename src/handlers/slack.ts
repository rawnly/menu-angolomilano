import { Effect } from "effect";
import { extractData } from "../menu";
import {
	broadcastMenu,
	buildMenuBlocks,
	getBotUserId,
	postToResponseUrl,
	trackChannelJoin,
	untrackChannel,
	verifySlackSignature,
} from "../slack";

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
					yield* Effect.logError("slash command deferred failed", { cause });
					yield* postToResponseUrl(responseUrl, {
						response_type: "ephemeral",
						text: "Menu not available yet, try later.",
					});
				}),
			),
		);

		yield* Effect.forkDaemon(deferred);

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
			yield* Effect.forkDaemon(
				Effect.gen(function* () {
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
				),
			);
		}

		return new Response(null, { status: 204 });
	}).pipe(Effect.withSpan("slack.events"));

export const handleBroadcast = (imageUrl: string) =>
	broadcastMenu(imageUrl).pipe(
		Effect.tapError((cause) => Effect.logError("cron failed", { cause })),
		Effect.catchAll(() => Effect.void),
		Effect.withSpan("scheduled.broadcast"),
	);
