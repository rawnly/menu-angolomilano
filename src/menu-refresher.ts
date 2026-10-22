import { DurableObject } from "cloudflare:workers";
import { Effect, Logger } from "effect";
import { scrapeAndStoreMenu } from "./menu";
import { saveRun } from "./runs";
import { CloudflareEnv } from "./types";

const MAX_RUN_MS = 10 * 60 * 1000; // treat a run older than this as dead

type RunState = { startedAt: number; recordFailure: boolean };

export class MenuRefresher extends DurableObject<Env> {
	private async current() {
		const run = await this.ctx.storage.get<RunState>("run");
		return run && Date.now() - run.startedAt < MAX_RUN_MS ? run : null;
	}

	async status() {
		return {
			running: (await this.current()) !== null,
			lastError: (await this.ctx.storage.get<string>("lastError")) ?? null,
			finishedAt: (await this.ctx.storage.get<number>("finishedAt")) ?? null,
		};
	}

	async start(options: { recordFailure: boolean }) {
		if (await this.current()) return "running" as const;
		await this.ctx.storage.put("run", {
			startedAt: Date.now(),
			recordFailure: options.recordFailure,
		} satisfies RunState);
		await this.ctx.storage.delete("lastError");
		await this.ctx.storage.setAlarm(Date.now());
		return "started" as const;
	}

	// Alarm handlers get up to 15 min of wall time and are retried on throw,
	// so everything is caught here.
	async alarm() {
		const run = await this.ctx.storage.get<RunState>("run");
		if (!run) return;

		const result = await Effect.runPromise(
			scrapeAndStoreMenu.pipe(
				Effect.provideService(CloudflareEnv, this.env),
				Effect.provide(Logger.json),
				Effect.either,
			),
		);

		if (result._tag === "Left") {
			const e = result.left as { _tag?: string; reason?: string };
			const reason = [e._tag, e.reason].filter(Boolean).join(": ") || String(e);
			await this.ctx.storage.put("lastError", reason);
			if (run.recordFailure) {
				await Effect.runPromise(
					saveRun({ trigger: "manual", status: "error", error: reason }).pipe(
						Effect.provideService(CloudflareEnv, this.env),
					),
				);
			}
		}
		await this.ctx.storage.put("finishedAt", Date.now());
		await this.ctx.storage.delete("run");
	}
}
