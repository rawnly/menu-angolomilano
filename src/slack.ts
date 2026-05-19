import { Data, Effect } from "effect";
import { CloudflareEnv } from "./types";

export type SlackEnv = Cloudflare.Env & {
	SLACK_SIGNING_SECRET: string;
	SLACK_BOT_TOKEN: string;
};

const CHANNEL_KEY_PREFIX = "slack:channel:";
const BOT_USER_KEY = "slack:bot_user_id";

export const channelKey = (id: string) => `${CHANNEL_KEY_PREFIX}${id}`;

export const buildMenuBlocks = (imageUrl: string) => [
	{
		type: "header",
		text: { type: "plain_text", text: "MENUANGOLO", emoji: true },
	},
	{ type: "image", image_url: imageUrl, alt_text: "MENUANGOLO" },
];

export const buildMarkdownReplyBlocks = (markdown: string) => [
	{
		type: "section",
		text: { type: "mrkdwn", text: markdown },
	},
];

export const postMenu = (
	channel: string,
	imageUrl: string,
	markdown: string | null,
) =>
	Effect.gen(function* () {
		const res = yield* slackApi<{ ts: string }>("chat.postMessage", {
			channel,
			text: "MENUANGOLO",
			blocks: buildMenuBlocks(imageUrl),
		});
		if (markdown) {
			yield* slackApi("chat.postMessage", {
				channel,
				thread_ts: res.ts,
				text: markdown,
				blocks: buildMarkdownReplyBlocks(markdown),
			});
		}
	});

export class SlackSignatureError extends Data.TaggedError(
	"SlackSignatureError",
)<{ reason: string }> {}

export class SlackApiError extends Data.TaggedError("SlackApiError")<{
	method: string;
	error: string;
}> {}

export class SlackTransportError extends Data.TaggedError(
	"SlackTransportError",
)<{ cause: unknown }> {}

const slackEnv = Effect.map(CloudflareEnv, (e) => e as SlackEnv);

export const verifySlackSignature = (
	timestamp: string | null,
	signature: string | null,
	rawBody: string,
) =>
	Effect.gen(function* () {
		const env = yield* slackEnv;

		if (!timestamp || !signature) {
			return yield* new SlackSignatureError({ reason: "missing headers" });
		}
		const ts = Number(timestamp);
		if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 60 * 5) {
			return yield* new SlackSignatureError({ reason: "stale timestamp" });
		}

		const expected = yield* Effect.tryPromise({
			try: async () => {
				const key = await crypto.subtle.importKey(
					"raw",
					new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
					{ name: "HMAC", hash: "SHA-256" },
					false,
					["sign"],
				);
				const mac = await crypto.subtle.sign(
					"HMAC",
					key,
					new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
				);
				return (
					"v0=" +
					[...new Uint8Array(mac)]
						.map((b) => b.toString(16).padStart(2, "0"))
						.join("")
				);
			},
			catch: (cause) => new SlackTransportError({ cause }),
		});

		if (expected.length !== signature.length) {
			return yield* new SlackSignatureError({ reason: "length mismatch" });
		}
		let diff = 0;
		for (let i = 0; i < expected.length; i++) {
			diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
		}
		if (diff !== 0) {
			return yield* new SlackSignatureError({ reason: "mismatch" });
		}
	});

export const slackApi = <T = unknown>(method: string, body: unknown) =>
	Effect.gen(function* () {
		const env = yield* slackEnv;
		yield* Effect.logDebug("slackApi request", {
			method,
			body,
			hasToken: Boolean(env.SLACK_BOT_TOKEN),
			tokenPrefix: env.SLACK_BOT_TOKEN?.slice(0, 5),
		});
		const res = yield* Effect.tryPromise({
			try: () =>
				fetch(`https://slack.com/api/${method}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
						"Content-Type": "application/json; charset=utf-8",
					},
					body: JSON.stringify(body),
				}),
			catch: (cause) => new SlackTransportError({ cause }),
		});
		const json = (yield* Effect.tryPromise({
			try: () => res.json(),
			catch: (cause) => new SlackTransportError({ cause }),
		})) as { ok: boolean; error?: string } & Record<string, unknown>;

		yield* Effect.logDebug("slackApi response", {
			method,
			status: res.status,
			ok: json.ok,
			error: json.error,
			response: json,
		});

		if (!json.ok) {
			return yield* new SlackApiError({
				method,
				error: json.error ?? "unknown",
			});
		}
		return json as T;
	});

export const getBotUserId = Effect.gen(function* () {
	const env = yield* slackEnv;
	const cached = yield* Effect.tryPromise({
		try: () => env.ANGOLOMILANO_MENU_KV.get(BOT_USER_KEY),
		catch: (cause) => new SlackTransportError({ cause }),
	});
	if (cached) return cached;

	const res = yield* slackApi<{ user_id: string }>("auth.test", {});
	yield* Effect.tryPromise({
		try: () => env.ANGOLOMILANO_MENU_KV.put(BOT_USER_KEY, res.user_id),
		catch: (cause) => new SlackTransportError({ cause }),
	});
	return res.user_id;
});

export const trackChannelJoin = (channel: string) =>
	Effect.gen(function* () {
		const env = yield* slackEnv;
		yield* Effect.tryPromise({
			try: () => env.ANGOLOMILANO_MENU_KV.put(channelKey(channel), "1"),
			catch: (cause) => new SlackTransportError({ cause }),
		});
	});

export const untrackChannel = (channel: string) =>
	Effect.gen(function* () {
		const env = yield* slackEnv;
		yield* Effect.tryPromise({
			try: () => env.ANGOLOMILANO_MENU_KV.delete(channelKey(channel)),
			catch: (cause) => new SlackTransportError({ cause }),
		});
	});

export const listChannels = Effect.gen(function* () {
	const env = yield* slackEnv;
	const out: string[] = [];
	let cursor: string | undefined;
	do {
		const page = yield* Effect.tryPromise({
			try: () =>
				env.ANGOLOMILANO_MENU_KV.list({
					prefix: CHANNEL_KEY_PREFIX,
					cursor,
				}),
			catch: (cause) => new SlackTransportError({ cause }),
		});
		for (const k of page.keys) {
			out.push(k.name.slice(CHANNEL_KEY_PREFIX.length));
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return out;
});

export const postToResponseUrl = (responseUrl: string, payload: unknown) =>
	Effect.tryPromise({
		try: () =>
			fetch(responseUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			}),
		catch: (cause) => new SlackTransportError({ cause }),
	});

export const broadcastMenu = (imageUrl: string, markdown: string | null) =>
	Effect.gen(function* () {
		const channels = yield* listChannels;
		yield* Effect.logInfo("broadcastMenu start", {
			imageUrl,
			hasMarkdown: Boolean(markdown),
			channelCount: channels.length,
			channels,
		});
		yield* Effect.forEach(
			channels,
			(channel) =>
				Effect.gen(function* () {
					yield* Effect.logDebug("broadcastMenu posting", { channel });
					yield* postMenu(channel, imageUrl, markdown);
					yield* Effect.logDebug("broadcastMenu posted", { channel });
				}).pipe(
					Effect.catchAll((e) =>
						Effect.logError("broadcastMenu post failed", { channel, cause: e }),
					),
				),
			{ concurrency: 5 },
		);
		yield* Effect.logInfo("broadcastMenu done");
	});
