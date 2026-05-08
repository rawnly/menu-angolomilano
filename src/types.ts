import { Context } from "effect";

export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
	CloudflareEnv,
	Cloudflare.Env
>() {}

export class CloudflareContext extends Context.Tag("CloudflareContext")<
	CloudflareContext,
	ExecutionContext
>() {}
