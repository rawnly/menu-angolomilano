import { Context, type Ref } from "effect";

export type CacheStatusValue = "HIT" | "MISS";

export class CacheStatusRef extends Context.Tag("CacheStatusRef")<
	CacheStatusRef,
	Ref.Ref<CacheStatusValue>
>() {}

export class CacheOptions extends Context.Tag("CacheOptions")<
	CacheOptions,
	{ readonly skip: boolean }
>() {}

export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
	CloudflareEnv,
	Cloudflare.Env
>() {}

export class CloudflareContext extends Context.Tag("CloudflareContext")<
	CloudflareContext,
	ExecutionContext
>() {}
