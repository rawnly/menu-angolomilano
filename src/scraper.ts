import puppeteer from "@cloudflare/puppeteer";
import { Data, Duration, Effect, Schedule } from "effect";
import { CloudflareEnv } from "./types";

export const scrapeStories = Effect.gen(function* () {
	const url = "https://insta-stories-viewer.com/angolomilanofficial";
	const env = yield* CloudflareEnv;

	const browser = yield* Effect.tryPromise({
		try: () => puppeteer.launch(env.BROWSER),
		catch: (cause) => new PuppeteerException({ cause }),
	});
	const page = yield* Effect.tryPromise({
		try: () => browser.newPage(),
		catch: (cause) => new PuppeteerException({ cause }),
	});
	yield* Effect.tryPromise({
		try: () => page.goto(url),
		catch: (cause) => new PuppeteerException({ cause }),
	});
	yield* Effect.tryPromise({
		try: () =>
			page.waitForSelector(".profile__tabs-media-item img.loaded", {
				timeout: 20_000,
			}),
		catch: (cause) => new PuppeteerException({ cause }),
	});

	let data: string[] = [];

	yield* Effect.gen(function* () {
		const evaluation: string[] = yield* Effect.tryPromise({
			try: () =>
				page.evaluate(() => {
					return (
						Array.from(
							// @ts-ignore this runs in browser
							document.querySelectorAll(".profile__tabs-media-item img.loaded"),
						)
							// @ts-ignore this runs in browser
							.map((img) => img.getAttribute("src"))
					);
				}),
			catch: (cause) => new DomEvaluationError({ cause }),
		});

		data.push(...evaluation);
	}).pipe(
		Effect.repeat(
			Schedule.spaced(Duration.seconds(1)).pipe(
				Schedule.upTo(Duration.seconds(10)),
				Schedule.untilInput(() => data.length >= 3),
			),
		),
	);

	return data;
});

class PuppeteerException extends Data.TaggedError("PuppeteerException")<{
	cause: unknown;
}> {}

class DomEvaluationError extends Data.TaggedError("DomEvaluationError")<{
	cause: unknown;
}> {}
