import { Data, Effect } from "effect";
import { CloudflareEnv } from "./types";

/**
 * The menu refresh (browser scrape + OCR + format + cache write) is owned by a
 * single Durable Object instance, which gives a real single-flight guarantee
 * and lets the work outlive the HTTP request (alarm: up to 15 min, vs. the
 * 30s cap of ctx.waitUntil).
 */
export class ScrapeBusy extends Data.TaggedError("ScrapeBusy")<{}> {}

export class ScrapeFailed extends Data.TaggedError("ScrapeFailed")<{
	reason: string;
}> {}

const refresher = Effect.map(CloudflareEnv, (env) =>
	env.MENU_REFRESHER.get(env.MENU_REFRESHER.idFromName("singleton")),
);

export const refreshStatus = Effect.gen(function* () {
	const stub = yield* refresher;
	return yield* Effect.tryPromise(() => stub.status());
});

export const isScrapeRunning = Effect.map(refreshStatus, (s) => s.running);

/** Starts a refresh in the background. "running" = one was already in progress. */
export const startRefresh = (options: { recordFailure: boolean }) =>
	Effect.gen(function* () {
		const stub = yield* refresher;
		return yield* Effect.tryPromise(() => stub.start(options));
	});
