<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { api, type MenuData } from "./api";
	import { btn, btnDanger, btnGhost } from "./styles";

	let channels = $state<string[]>([]);
	let lastPublished = $state<string | null>(null);
	let menu = $state<MenuData | null>(null);
	let menuError = $state<string | null>(null);
	let newChannel = $state("");
	let busy = $state<Record<string, boolean>>({});
	let toast = $state<{ kind: "ok" | "err"; text: string } | null>(null);
	let toastTimer: ReturnType<typeof setTimeout>;

	const notify = (kind: "ok" | "err", text: string) => {
		toast = { kind, text };
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 4000);
	};

	const run = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
		busy[key] = true;
		try {
			await fn();
			notify("ok", okMsg);
		} catch (e) {
			notify("err", e instanceof Error ? e.message : String(e));
		} finally {
			busy[key] = false;
		}
	};

	const loadState = async () => {
		const s = await api.state();
		channels = s.channels;
		lastPublished = s.lastPublished;
	};

	// --- menu loading --------------------------------------------------
	// B (GET /api/menu) is the default: it returns the cached menu and carries
	// `status: "running"` while a refresh is in progress. A (POST
	// /api/menu/refresh) starts a refresh; we then poll B until the status
	// disappears.
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let destroyed = false;
	onDestroy(() => {
		destroyed = true;
		clearTimeout(pollTimer);
	});

	const sleep = (ms: number) =>
		new Promise<void>((r) => (pollTimer = setTimeout(r, ms)));

	// one B call; returns true while a refresh is running
	const fetchMenu = async () => {
		const r = await api.menu();
		if (r.data) menu = r.data;
		if (r.status !== "running" && r.lastError) menuError = r.lastError;
		return r.status === "running";
	};

	const loadMenu = async (start = false) => {
		menuError = null;
		busy.menu = true;
		try {
			if (start) await api.refreshMenu();
			let running = await fetchMenu();
			for (let i = 0; running && i < 150 && !destroyed; i++) {
				await sleep(3000);
				running = await fetchMenu();
			}
		} catch (e) {
			menuError = e instanceof Error ? e.message : String(e);
		} finally {
			busy.menu = false;
		}
	};

	onMount(() => {
		loadState().catch((e) => notify("err", e.message));
		loadMenu();
	});

	const addChannel = async (e: SubmitEvent) => {
		e.preventDefault();
		const id = newChannel.trim().toUpperCase();
		if (!id) return;
		await run(
			"add",
			async () => {
				await api.addChannel(id);
				newChannel = "";
				await loadState();
			},
			`Tracking ${id}`,
		);
	};

	const removeChannel = (id: string) => {
		if (!confirm(`Stop tracking ${id}?`)) return;
		return run(
			`rm:${id}`,
			async () => {
				await api.removeChannel(id);
				await loadState();
			},
			`Removed ${id}`,
		);
	};

	const btnPrimary = `${btn} bg-amber-500 text-zinc-950 hover:bg-amber-400`;
</script>

<div class="space-y-6">
	<section class="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
		<div class="mb-4 flex items-center justify-between">
			<h2 class="font-medium">Today's menu</h2>
			<button
				class={btnGhost}
				disabled={busy.menu}
				onclick={() => loadMenu(true)}
			>
				{busy.menu ? "Loading…" : "Refresh"}
			</button>
		</div>
		{#if menuError}
			<p class="mb-3 text-sm text-red-400">Last refresh failed: {menuError}</p>
		{/if}
		{#if menu}
			<div
				class="grid gap-4 transition-opacity md:grid-cols-2 {busy.menu ? 'opacity-50' : ''}"
			>
				<img src={menu.url} alt="Menu" class="max-h-96 rounded-lg object-contain" />
				<pre
					class="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-sm text-zinc-300">{menu.markdown ?? menu.text}</pre>
			</div>
			<p class="mt-3 text-xs text-zinc-500">
				{busy.menu
					? "Refreshing — showing the previous result…"
					: `fetched ${new Date(menu.fetchedAt).toLocaleTimeString()}`}
			</p>
		{:else}
			<p class="text-sm text-zinc-500">
				{busy.menu
					? "Fetching today's menu — this can take up to a minute…"
					: "No menu yet today. Press Refresh to fetch it."}
			</p>
		{/if}
	</section>

	<section class="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
		<h2 class="mb-1 font-medium">Broadcast</h2>
		<p class="mb-4 text-sm text-zinc-400">
			Same flow as the cron. "Force" posts even if the menu matches the last
			published one.
		</p>
		<div class="flex gap-2">
			<button
				class={btnPrimary}
				disabled={busy.broadcast}
				onclick={() =>
					run("broadcast", async () => { await api.broadcast(false); await loadState(); }, "Broadcast done")}
			>
				{busy.broadcast ? "Running…" : "Run broadcast"}
			</button>
			<button
				class={btnGhost}
				disabled={busy.broadcast}
				onclick={() =>
					confirm("Post to all tracked channels even if unchanged?") &&
					run("broadcast", async () => { await api.broadcast(true); await loadState(); }, "Forced broadcast done")}
			>
				Force
			</button>
		</div>
		{#if lastPublished}
			<details class="mt-4 text-sm text-zinc-400">
				<summary class="cursor-pointer">Last published text</summary>
				<pre
					class="mt-2 whitespace-pre-wrap rounded-lg bg-zinc-950 p-3">{lastPublished}</pre>
			</details>
		{/if}
	</section>

	<section class="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
		<h2 class="mb-4 font-medium">Tracked channels ({channels.length})</h2>
		<ul class="divide-y divide-zinc-800">
			{#each channels as id (id)}
				<li class="flex items-center justify-between py-2">
					<code class="text-sm">{id}</code>
					<div class="flex gap-2">
						<button
							class={btnGhost}
							disabled={busy[`post:${id}`]}
							onclick={() =>
								run(`post:${id}`, () => api.postToChannel(id), `Posted to ${id}`)}
						>
							Post menu
						</button>
						<button
							class={btnDanger}
							disabled={busy[`rm:${id}`]}
							onclick={() => removeChannel(id)}
						>
							Remove
						</button>
					</div>
				</li>
			{:else}
				<li class="py-2 text-sm text-zinc-500">No channels tracked.</li>
			{/each}
		</ul>
		<form class="mt-4 flex gap-2" onsubmit={addChannel}>
			<input
				bind:value={newChannel}
				placeholder="Channel ID (C0123ABCD)"
				class="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm outline-none focus:border-amber-500"
			/>
			<button class={btnGhost} disabled={busy.add || !newChannel.trim()}>Add</button>
		</form>
	</section>
</div>

{#if toast}
	<div
		class="fixed bottom-4 right-4 rounded-lg px-4 py-2 text-sm shadow-lg {toast.kind === 'ok'
			? 'bg-emerald-600'
			: 'bg-red-600'}"
	>
		{toast.text}
	</div>
{/if}
