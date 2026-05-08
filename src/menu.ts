import { Array as Arr, Duration, Effect, Option, pipe, Schedule } from "effect";
import { cached } from "./cache";
import { extractImageText } from "./image-extraction";
import { scrapeStories } from "./scraper";

const TIME_ZONE = "Europe/Rome";

const getZonedNow = (timeZone: string) => {
	const now = new Date();
	return new Date(now.toLocaleString("en-US", { timeZone }));
};

const formatZonedDate = (date: Date, timeZone: string) =>
	new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		timeZone,
	}).format(date);

const secondsUntilNextNoon = (timeZone = TIME_ZONE) => {
	const zonedNow = getZonedNow(timeZone);
	const nextNoon = new Date(zonedNow);
	nextNoon.setHours(12, 0, 0, 0);
	if (zonedNow >= nextNoon) {
		nextNoon.setDate(nextNoon.getDate() + 1);
	}
	const diffMs = nextNoon.getTime() - zonedNow.getTime();
	return Math.max(1, Math.ceil(diffMs / 1000));
};

const getNoonAnchorKey = (timeZone = TIME_ZONE) => {
	const zonedNow = getZonedNow(timeZone);
	const noonAnchor = new Date(zonedNow);
	noonAnchor.setHours(12, 0, 0, 0);
	if (zonedNow < noonAnchor) {
		noonAnchor.setDate(noonAnchor.getDate() - 1);
	}
	return formatZonedDate(noonAnchor, timeZone);
};

export const extractData = Effect.gen(function* () {
	const cacheKeyDate = getNoonAnchorKey();
	const cacheTtl = secondsUntilNextNoon();

	const imagesURLs = yield* scrapeStories.pipe(
		Effect.retry(
			Schedule.exponential(Duration.seconds(2)).pipe(
				Schedule.upTo(Duration.seconds(10)),
			),
		),
		cached(`IMAGES_${cacheKeyDate}`, {
			ttl: cacheTtl,
			shouldCache: (data) => data.length > 0,
		}),
	);

	const processed = yield* pipe(
		imagesURLs,
		Effect.forEach(
			(url) => extractImageText(url, "@cf/meta/llama-3.2-11b-vision-instruct"),
			{
				concurrency: "unbounded",
			},
		),
		Effect.andThen(Arr.filter(Option.isSome)),
		Effect.tap(Effect.log),
		Effect.andThen(
			Arr.filterMap(
				Option.filter(
					(el) =>
						el.text.toLowerCase().includes("primo") &&
						el.text.toLowerCase().includes("secondo") &&
						el.text.toLowerCase().includes("contorno") &&
						el.text.toLowerCase().includes("semper verd"),
				),
			),
		),
		cached(`DATA_${cacheKeyDate}`, {
			ttl: cacheTtl,
			shouldCache: (data) => data.length > 0,
		}),
	);

	return yield* Arr.head(processed);
});
