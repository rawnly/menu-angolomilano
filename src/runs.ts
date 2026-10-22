import { Effect } from "effect";
import { CloudflareEnv } from "./types";

/**
 * Run history: one KV entry per broadcast attempt (cron / manual / slash),
 * kept for 30 days. Keys sort newest-first (reversed timestamp), and a small
 * summary lives in KV metadata so the list view needs no per-key reads.
 */
export const RUN_PREFIX = "run:";
const RUN_TTL = 60 * 60 * 24 * 30;
const MAX_TS = 9_999_999_999_999;

export type RunTrigger = "cron" | "manual" | "slash";
export type RunStatus = "published" | "skipped" | "error";

export type RunSummary = {
	at: string;
	trigger: RunTrigger;
	status: RunStatus;
	error?: string;
};

export type RunRecord = RunSummary & {
	url?: string;
	similarity?: number;
	text?: string;
	cause?: unknown;
};

export type BroadcastOutcome = {
	status: "published" | "skipped";
	url: string;
	text: string;
	similarity?: number;
};

export const runKey = (at: number) =>
	`${RUN_PREFIX}${String(MAX_TS - at).padStart(13, "0")}`;

const errorMessage = (e: unknown) => {
	const tag = (e as { _tag?: string } | null)?._tag;
	const detail = (e as { reason?: string; error?: string } | null);
	return [tag, detail?.reason ?? detail?.error].filter(Boolean).join(": ") ||
		String(e);
};

export const saveRun = (record: Omit<RunRecord, "at">) =>
	Effect.gen(function* () {
		const env = yield* CloudflareEnv;
		const now = Date.now();
		const full: RunRecord = { at: new Date(now).toISOString(), ...record };
		const summary: RunSummary = {
			at: full.at,
			trigger: full.trigger,
			status: full.status,
			error: full.error?.slice(0, 300),
		};
		yield* Effect.tryPromise(() =>
			env.ANGOLOMILANO_MENU_KV.put(runKey(now), JSON.stringify(full), {
				expirationTtl: RUN_TTL,
				metadata: summary,
			}),
		);
	}).pipe(
		// history must never break the actual job
		Effect.catchAll((cause) => Effect.logError("saveRun failed", { cause })),
	);

/** Records the outcome (success, skip or failure) of a broadcast-like effect. */
export const recordRun =
	(trigger: RunTrigger) =>
	<E, R>(effect: Effect.Effect<BroadcastOutcome, E, R>) =>
		effect.pipe(
			Effect.tap((o) =>
				saveRun({
					trigger,
					status: o.status,
					url: o.url,
					similarity: o.similarity,
					text: o.text.slice(0, 4000),
				}),
			),
			Effect.tapError((e) =>
				saveRun({
					trigger,
					status: "error",
					error: errorMessage(e),
					cause: JSON.parse(JSON.stringify(e, Object.getOwnPropertyNames(e as object))),
				}),
			),
		);

export const listRuns = (limit = 50) =>
	Effect.gen(function* () {
		const env = yield* CloudflareEnv;
		const page = yield* Effect.tryPromise(() =>
			env.ANGOLOMILANO_MENU_KV.list<RunSummary>({ prefix: RUN_PREFIX, limit }),
		);
		return page.keys.map((k) => ({ key: k.name, ...(k.metadata as RunSummary) }));
	});
