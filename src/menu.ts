import { Array as Arr, Duration, Effect, Option, pipe, Schedule } from "effect";
import { cached } from "./cache";
import { extractImageText, formatText } from "./image-extraction";
import { scrapeStories } from "./scraper";

const TIME_ZONE = "Europe/Rome";
const ANCHOR_HOUR = 11;

const getRomeParts = (d: Date = new Date()) => {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	})
		.formatToParts(d)
		.reduce<Record<string, string>>((acc, p) => {
			if (p.type !== "literal") acc[p.type] = p.value;
			return acc;
		}, {});
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour === "24" ? "0" : parts.hour),
		minute: Number(parts.minute),
		second: Number(parts.second),
	};
};

const getAnchorKey = () => {
	const p = getRomeParts();
	if (p.hour < ANCHOR_HOUR) {
		const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
		d.setUTCDate(d.getUTCDate() - 1);
		return d.toISOString().slice(0, 10);
	}
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

const secondsUntilNextAnchor = () => {
	const p = getRomeParts();
	const secondsToday = p.hour * 3600 + p.minute * 60 + p.second;
	const anchorSecs = ANCHOR_HOUR * 3600;
	const diff =
		secondsToday < anchorSecs
			? anchorSecs - secondsToday
			: 24 * 3600 - (secondsToday - anchorSecs);
	return Math.max(1, diff);
};

export const extractData = Effect.gen(function* () {
	const cacheKeyDate = getAnchorKey();
	const cacheTtl = secondsUntilNextAnchor();

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

	const result = yield* Arr.head(processed).pipe(
		Effect.andThen((data) =>
			Effect.gen(function* () {
				return {
					...data,
					markdown: yield* formatText(data.text).pipe(
						Effect.option,
						Effect.andThen(Option.getOrNull),
						cached(`MARKDOWN_${cacheKeyDate}`, {
							ttl: cacheTtl,
						}),
					),
				};
			}),
		),
	);

	return result;
});
