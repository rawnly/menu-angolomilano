import {
	Array as Arr,
	Array,
	Duration,
	Effect,
	Option,
	pipe,
	Schedule,
} from "effect";
import { extractImageText, formatText } from "./image-extraction";
import { scrapeStories } from "./scraper";

// Scraping and the menu heuristic always run fresh on every call - only the
// per-image OCR call (inside extractImageText) is cached, keyed by image URL.
export const extractMenuText = Effect.gen(function* () {
	const imagesURLs = yield* scrapeStories.pipe(
		Effect.retry(
			Schedule.exponential(Duration.seconds(2)).pipe(
				Schedule.upTo(Duration.seconds(10)),
			),
		),
	);

	const processed = yield* pipe(
		imagesURLs,
		Array.reverse, // reverse the array so it takes always the latest one
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
	);

	return yield* Arr.head(processed);
});

export const extractData = Effect.gen(function* () {
	const data = yield* extractMenuText;
	const markdown = yield* formatText(data.text).pipe(
		Effect.option,
		Effect.andThen(Option.getOrNull),
	);
	return { ...data, markdown };
});
