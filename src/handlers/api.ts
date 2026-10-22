import { Effect } from "effect";
import { requireAccess } from "../access";
import { listRuns, RUN_PREFIX, recordRun } from "../runs";
import {
	getMenu,
	readCurrentMenu,
	refreshMenu,
} from "../menu";
import { refreshStatus, startRefresh } from "../scrape-lock";
import {
	getLastPublishedMenu,
	listChannels,
	postMenu,
	trackChannelJoin,
	untrackChannel,
} from "../slack";
import { CloudflareEnv } from "../types";
import { handleBroadcast } from "./slack";

const kv = <A>(fn: (kv: KVNamespace) => Promise<A>) =>
	Effect.gen(function* () {
		const env = yield* CloudflareEnv;
		return yield* Effect.tryPromise(() => fn(env.ANGOLOMILANO_MENU_KV));
	});
const kvGet = (key: string) => kv((k) => k.get(key));
const kvDelete = (key: string) => kv((k) => k.delete(key));
const kvList = (prefix: string, cursor?: string) =>
	kv(async (k) => {
		const page = await k.list({ prefix, cursor, limit: 100 });
		return {
			keys: page.keys.map((x) => ({ name: x.name, expiration: x.expiration })),
			cursor: page.list_complete ? null : page.cursor,
		};
	});

const CHANNEL_ID = /^[A-Z0-9]{3,32}$/;

const notFound = () => Response.json({ ok: false, error: "not found" }, { status: 404 });
const badRequest = (error: string) =>
	Response.json({ ok: false, error }, { status: 400 });

export const handleApi = (req: Request) =>
	Effect.gen(function* () {
		const identity = yield* requireAccess(req);
		const url = new URL(req.url);
		const path = url.pathname.replace(/\/+$/, "");
		const method = req.method;

		if (method === "GET" && path === "/api/me") {
			return Response.json({ ok: true, ...identity });
		}

		if (method === "GET" && path === "/api/state") {
			const [channels, lastPublished] = yield* Effect.all([
				listChannels,
				getLastPublishedMenu,
			]);
			return Response.json({ ok: true, channels, lastPublished });
		}

		// B: read-only. Cached menu (null if none today); `status: "running"` is
		// present only while a refresh is in progress.
		if (method === "GET" && path === "/api/menu") {
			const [data, refresh] = yield* Effect.all([
				readCurrentMenu,
				refreshStatus,
			]);
			return Response.json({
				ok: true,
				data,
				...(refresh.running
					? { status: "running" }
					: { lastError: refresh.lastError }),
			});
		}

		// A: starts a refresh in the background; if one is already in progress
		// this is a no-op. Either way the answer is "running" - poll B.
		if (method === "POST" && path === "/api/menu/refresh") {
			yield* startRefresh({ recordFailure: true });
			return Response.json({ ok: true, status: "running" }, { status: 202 });
		}

		if (method === "GET" && path === "/api/runs") {
			return Response.json({ ok: true, runs: yield* listRuns() });
		}

		if (method === "GET" && path === "/api/runs/detail") {
			const key = url.searchParams.get("key") ?? "";
			if (!key.startsWith(RUN_PREFIX)) return badRequest("invalid key");
			const value = yield* kvGet(key);
			return value === null ? notFound() : Response.json({ ok: true, run: JSON.parse(value) });
		}

		// Raw KV browser (OCR cache, channels, last menu, run history...)
		if (method === "GET" && path === "/api/kv") {
			const page = yield* kvList(
				url.searchParams.get("prefix") ?? "",
				url.searchParams.get("cursor") ?? undefined,
			);
			return Response.json({ ok: true, ...page });
		}

		if (method === "GET" && path === "/api/kv/value") {
			const key = url.searchParams.get("key");
			if (!key) return badRequest("missing key");
			const value = yield* kvGet(key);
			return value === null ? notFound() : Response.json({ ok: true, key, value });
		}

		if (method === "DELETE" && path === "/api/kv") {
			const key = url.searchParams.get("key");
			if (!key) return badRequest("missing key");
			yield* kvDelete(key);
			return Response.json({ ok: true });
		}

		// Run the same flow as the cron. `?force=1` skips the "same menu" check.
		if (method === "POST" && path === "/api/broadcast") {
			const force = url.searchParams.get("force") === "1";
			const outcome = yield* refreshMenu.pipe(
				Effect.andThen((data) =>
					handleBroadcast(data.url, data.text, { force }),
				),
				recordRun("manual"),
			);
			return Response.json({
				ok: true,
				status: outcome.status,
				similarity: outcome.similarity,
			});
		}

		if (method === "POST" && path === "/api/channels") {
			const body = (yield* Effect.promise(() =>
				req.json().catch(() => null),
			)) as { id?: string } | null;
			const id = body?.id?.trim().toUpperCase();
			if (!id || !CHANNEL_ID.test(id)) return badRequest("invalid channel id");
			yield* trackChannelJoin(id);
			return Response.json({ ok: true, id });
		}

		const m = path.match(/^\/api\/channels\/([^/]+)(\/post)?$/);
		if (m) {
			const id = m[1]!;
			if (!CHANNEL_ID.test(id)) return badRequest("invalid channel id");
			if (method === "DELETE" && !m[2]) {
				yield* untrackChannel(id);
				return Response.json({ ok: true });
			}
			if (method === "POST" && m[2]) {
				const data = yield* getMenu;
				yield* postMenu(id, data.url, data.markdown);
				return Response.json({ ok: true });
			}
		}

		return notFound();
	}).pipe(Effect.withSpan("api"));
