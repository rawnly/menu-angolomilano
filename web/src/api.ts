export type MenuData = {
	url: string;
	text: string;
	markdown: string | null;
	fetchedAt: string;
};

export type RunSummary = {
	key: string;
	at: string;
	trigger: "cron" | "manual" | "slash";
	status: "published" | "skipped" | "error";
	error?: string;
};

export type RunDetail = Omit<RunSummary, "key"> & {
	url?: string;
	similarity?: number;
	text?: string;
	cause?: unknown;
};

export type KvKey = { name: string; expiration?: number };

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
	const res = await fetch(path, {
		...init,
		headers: { "Content-Type": "application/json", ...init?.headers },
	});
	const body = (await res.json().catch(() => ({}))) as {
		ok?: boolean;
		error?: string;
		code?: string;
	};
	if (!res.ok || body.ok === false) {
		throw new ApiError(body.error ?? body.code ?? res.statusText, res.status);
	}
	return body as T;
};

export const api = {
	me: () => call<{ email: string }>("/api/me"),
	state: () =>
		call<{ channels: string[]; lastPublished: string | null }>("/api/state"),
	/**
	 * B: read-only. Cached menu (null if none today). `status: "running"` is
	 * present only while a refresh is in progress; otherwise `lastError` tells
	 * whether the previous refresh failed.
	 */
	menu: () =>
		call<{
			data: MenuData | null;
			status?: "running";
			lastError?: string | null;
		}>("/api/menu"),
	/** A: starts a refresh (or no-op if one is running). Always "running". */
	refreshMenu: () =>
		call<{ status: "running" }>("/api/menu/refresh", { method: "POST" }),
	runs: () => call<{ runs: RunSummary[] }>("/api/runs"),
	run: (key: string) =>
		call<{ run: RunDetail }>(`/api/runs/detail?key=${encodeURIComponent(key)}`),
	kvList: (prefix: string, cursor?: string | null) => {
		const q = new URLSearchParams({ prefix });
		if (cursor) q.set("cursor", cursor);
		return call<{ keys: KvKey[]; cursor: string | null }>(`/api/kv?${q}`);
	},
	kvValue: (key: string) =>
		call<{ value: string }>(`/api/kv/value?key=${encodeURIComponent(key)}`),
	kvDelete: (key: string) =>
		call<unknown>(`/api/kv?key=${encodeURIComponent(key)}`, {
			method: "DELETE",
		}),
	broadcast: (force: boolean) =>
		call<unknown>(`/api/broadcast${force ? "?force=1" : ""}`, {
			method: "POST",
		}),
	addChannel: (id: string) =>
		call<unknown>("/api/channels", {
			method: "POST",
			body: JSON.stringify({ id }),
		}),
	removeChannel: (id: string) =>
		call<unknown>(`/api/channels/${id}`, { method: "DELETE" }),
	postToChannel: (id: string) =>
		call<unknown>(`/api/channels/${id}/post`, { method: "POST" }),
};
