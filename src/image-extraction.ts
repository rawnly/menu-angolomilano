import { Data, Effect, Option } from "effect";
import { CloudflareEnv } from "./types";

class AIException extends Data.TaggedError("AIException")<{ cause: unknown }> {}

class FetchError extends Data.TaggedError("FetchError")<{ cause: unknown }> {}

class ImageException extends Data.TaggedError("ImageException")<{
	cause: unknown;
}> {}

export const extractImageText = <M extends keyof AiModels>(
	url: string,
	model: M,
) =>
	Effect.gen(function* () {
		const env = yield* CloudflareEnv;

		const imageBinary = yield* Effect.tryPromise(() => fetch(url)).pipe(
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
			Effect.andThen((buffer) => [...new Uint8Array(buffer)]),
		);

		const ocrData = yield* Effect.tryPromise({
			try: () =>
				env.AI.run(model, {
					image: imageBinary,
					max_tokens: 800,
					prompt: `transcribe ALL the text visible in this image exactly as written.
					Include every word, number and price. if theres no text reploy exactly: NO_TEXT.
					Otherwise reply with ONLY the transcribed text - no commentary, no explanations.`,
				}),
			catch: (cause) => new AIException({ cause }),
		}).pipe(
			Effect.tap((text) =>
				Effect.logInfo("ai ocr output", {
					data: text,
					model,
					url,
				}),
			),
			Effect.map((ocr: any) => String(ocr?.response ?? "")?.trim() ?? ""),
			Effect.map((s) =>
				s.length > 10 && !s.toUpperCase().includes("NO_TEXT")
					? Option.some({ url, text: s })
					: Option.none(),
			),
		);

		return ocrData;
	});
