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
import {
	ScrapeBusy,
	ScrapeFailed,
	refreshStatus,
	startRefresh,
} from "./scrape-lock";
import { CloudflareEnv } from "./types";

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
		Effect.tap((all) =>
			Effect.logInfo("ocr results", {
				images: all.length,
				withText: all.filter(Option.isSome).length,
			}),
		),
		Effect.andThen(Arr.filter(Option.isSome)),
		Effect.andThen(
			Arr.filterMap(
				Option.filter(
					(el) =>
						el.text.toLowerCase().includes("prim") &&
						el.text.toLowerCase().includes("second") &&
						el.text.toLowerCase().includes("contorno") &&
						el.text.toLowerCase().includes("semper verd"),
				),
			),
		),
	);

	if (processed.length === 0) {
		yield* Effect.logError("no story matched the menu heuristic", {
			images: imagesURLs.length,
		});
	}

	return yield* Arr.head(processed);
});

// --- cached "current menu" -------------------------------------------------
// The latest scrape result, valid for the current day (Europe/Rome). Lets the
// dashboard / slash command read it without triggering a new scrape. The cron
// keeps it fresh during the lunch window; the dashboard "Refresh" forces it.
const MENU_KEY = "menu:current";
const MENU_TTL = 60 * 60 * 24;

const romeDay = (d: Date) =>
	d.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });

export type CurrentMenu = {
	url: string;
	text: string;
	markdown: string | null;
	fetchedAt: string;
};

export const readCurrentMenu = Effect.gen(function* () {
	const env = yield* CloudflareEnv;
	const menu = yield* Effect.tryPromise(() =>
		env.ANGOLOMILANO_MENU_KV.get<CurrentMenu>(MENU_KEY, "json"),
	);
	// yesterday's menu is not "today's menu"
	if (menu && romeDay(new Date(menu.fetchedAt)) !== romeDay(new Date())) {
		return null;
	}
	return menu;
});

/**
 * The actual work: scrape + OCR + format + store. Only the MenuRefresher
 * Durable Object calls this directly; everyone else goes through
 * `refreshMenu` / `startRefresh` so there is only ever one run at a time.
 */
export const scrapeAndStoreMenu = Effect.gen(function* () {
	const env = yield* CloudflareEnv;
	const data = yield* extractMenuText;
	const previous = yield* readCurrentMenu;
	// same text as before -> reuse the formatted markdown, skip the AI call
	const markdown =
		previous && previous.text === data.text
			? previous.markdown
			: yield* formatText(data.text).pipe(
					Effect.option,
					Effect.andThen(Option.getOrNull),
				);
	const menu: CurrentMenu = {
		...data,
		markdown,
		fetchedAt: new Date().toISOString(),
	};
	yield* Effect.tryPromise(() =>
		env.ANGOLOMILANO_MENU_KV.put(MENU_KEY, JSON.stringify(menu), {
			expirationTtl: MENU_TTL,
		}),
	);
	return menu;
});

/**
 * Starts a refresh and waits for it (cron, broadcast, slash command).
 * Fails with ScrapeBusy if one is already running.
 */
export const refreshMenu = Effect.gen(function* () {
	if ((yield* startRefresh({ recordFailure: false })) === "running") {
		return yield* new ScrapeBusy();
	}
	const deadline = Date.now() + 5 * 60 * 1000;
	while (Date.now() < deadline) {
		yield* Effect.sleep("2 seconds");
		const status = yield* refreshStatus;
		if (status.running) continue;
		if (status.lastError) {
			return yield* new ScrapeFailed({ reason: status.lastError });
		}
		const menu = yield* readCurrentMenu;
		if (menu) return menu;
		break;
	}
	return yield* new ScrapeFailed({ reason: "no menu produced" });
});

/** Cached menu if present, otherwise scrape. */
export const getMenu = readCurrentMenu.pipe(
	Effect.flatMap((m) => (m ? Effect.succeed(m) : refreshMenu)),
);
