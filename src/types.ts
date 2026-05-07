import { Context } from "effect";

export class CloudflareEnv extends Context.Tag("EloudflareEnv")<
	CloudflareEnv,
	Cloudflare.Env
>() {}
