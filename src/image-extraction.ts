import { Array as Arr, Data, Effect, Option } from "effect";
import { cached } from "./cache";
import { CloudflareEnv } from "./types";

class AIException extends Data.TaggedError("AIException")<{ cause: unknown }> {}

class FetchError extends Data.TaggedError("FetchError")<{ cause: unknown }> {}

class ImageException extends Data.TaggedError("ImageException")<{
	cause: unknown;
}> {}

const OCR_CACHE_TTL = 60 * 60 * 24; // stories are gone from IG within 24h anyway

const fetchImageBinary = (url: string) =>
	Effect.tryPromise(() => fetch(url)).pipe(
		Effect.filterOrFail(
			(response) => response.ok,
			(response) =>
				new FetchError({
					cause: response.status.toString(),
				}),
		),
		Effect.filterOrFail(
			(response) =>
				response.headers.get("Content-Type")?.startsWith("image/") === true,
			(cause) =>
				new ImageException({ cause: cause.headers.get("Content-Type") }),
		),
		Effect.andThen((res) => Effect.tryPromise(() => res.arrayBuffer())),
	);

// the story-viewer proxy re-signs the image URL on every page load, so the
// URL itself is not a stable cache key - hash the actual bytes instead. This
// also means an unchanged story yields byte-identical cached OCR text run
// after run, instead of a slightly different AI transcription each time.
const hashBytes = (buffer: ArrayBuffer) =>
	Effect.promise(async () => {
		const digest = await crypto.subtle.digest("SHA-256", buffer);
		return [...new Uint8Array(digest)]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	});

const runOcr = <M extends keyof AiModels>(
	imageBinary: number[],
	model: M,
	url: string,
) =>
	Effect.gen(function* () {
		const env = yield* CloudflareEnv;

		const ocrData = yield* Effect.tryPromise({
			try: () =>
				env.AI.run(model, {
					image: imageBinary,
					max_tokens: 800,
					prompt: `transcribe ALL the text visible in this image exactly as written.
					Include every word, number and price. if theres no text reply exactly: NO_TEXT.
					Otherwise reply with ONLY the transcribed text - no commentary, no explanations.`,
				}),
			catch: (cause) => new AIException({ cause }),
		}).pipe(
			Effect.tap((text) =>
				Effect.logDebug("ai ocr output", {
					data: text,
					model,
					url,
				}),
			),
			Effect.map((ocr: any) => String(ocr?.response ?? "")?.trim() ?? ""),
			Effect.map((s) =>
				s.length > 10 && !s.toUpperCase().includes("NO_TEXT") ? s : null,
			),
		);

		return ocrData;
	});

export const extractImageText = <M extends keyof AiModels>(
	url: string,
	model: M,
) =>
	Effect.gen(function* () {
		const buffer = yield* fetchImageBinary(url);
		const contentHash = yield* hashBytes(buffer);
		const imageBinary = [...new Uint8Array(buffer)];

		const text = yield* runOcr(imageBinary, model, url).pipe(
			cached(`OCR_${contentHash}`, { ttl: OCR_CACHE_TTL }),
		);

		return text ? Option.some({ url, text }) : Option.none();
	});

export const formatText = Effect.fn("formatText")(function* (text: string) {
	const env = yield* CloudflareEnv;

	const response = yield* Effect.tryPromise(() =>
		env.AI.run("@cf/moonshotai/kimi-k2.5", {
			temperature: 0,
			max_tokens: 800,
			prompt: `
Convert ONLY the text between <menu> and </menu> into Slack-compatible markdown.

Hard rules:
- Return ONLY the formatted menu.
- Do not add, infer, translate, complete, or invent any item.
- Do not add descriptions.
- Do not include items that are not present in the input.
- Preserve all original words, spelling, prices, and ordering.
- Use only bullets, bold, and italic.
- No headings with #.
- No code fences.

<menu>
${text}
</menu>
`,
		}),
	).pipe(Effect.tapError(Effect.logError));

	const formattedText = yield* Arr.head(response.choices).pipe(
		Option.andThen((choice: any) => Option.fromNullable(choice?.text)),
		Option.andThen(Option.liftPredicate((txt) => txt.trim().length > 0)),
	);

	return String(formattedText);
});
