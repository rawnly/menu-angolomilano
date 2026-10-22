<script lang="ts">
	import { onMount } from "svelte";
	import { api, type KvKey } from "./api";
	import { btnDanger, btnGhost, card } from "./styles";

	const PRESETS = [
		["All", ""],
		["OCR", "OCR_"],
		["Channels", "slack:"],
		["Menu", "menu:"],
		["Runs", "run:"],
	] as const;

	let prefix = $state("");
	let keys = $state<KvKey[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let open = $state<string | null>(null);
	let value = $state<string | null>(null);

	const load = async (more = false) => {
		loading = true;
		error = null;
		try {
			const page = await api.kvList(prefix, more ? cursor : null);
			keys = more ? [...keys, ...page.keys] : page.keys;
			cursor = page.cursor;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	};

	const pick = (p: string) => {
		prefix = p;
		open = null;
		load();
	};

	const toggle = async (key: string) => {
		if (open === key) return (open = null);
		open = key;
		value = null;
		try {
			const raw = (await api.kvValue(key)).value;
			try {
				value = JSON.stringify(JSON.parse(raw), null, 2);
			} catch {
				value = raw;
			}
		} catch (e) {
			value = e instanceof Error ? e.message : String(e);
		}
	};

	const remove = async (key: string) => {
		if (!confirm(`Delete ${key}?`)) return;
		try {
			await api.kvDelete(key);
			keys = keys.filter((k) => k.name !== key);
			if (open === key) open = null;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	};

	const expires = (exp?: number) =>
		exp ? `expires ${new Date(exp * 1000).toLocaleString()}` : "no expiry";

	onMount(() => load());
</script>

<section class={card}>
	<div class="mb-4 flex flex-wrap items-center gap-2">
		<h2 class="mr-auto font-medium">KV cache</h2>
		{#each PRESETS as [label, p]}
			<button
				class="{btnGhost} {prefix === p ? 'bg-zinc-800' : ''}"
				onclick={() => pick(p)}>{label}</button
			>
		{/each}
	</div>
	{#if error}<p class="mb-2 text-sm text-red-400">{error}</p>{/if}
	<ul class="divide-y divide-zinc-800">
		{#each keys as k (k.name)}
			<li class="py-2">
				<div class="flex items-center justify-between gap-3">
					<button class="min-w-0 text-left" onclick={() => toggle(k.name)}>
						<code class="block truncate text-sm">{k.name}</code>
						<span class="text-xs text-zinc-500">{expires(k.expiration)}</span>
					</button>
					<button class={btnDanger} onclick={() => remove(k.name)}>Delete</button>
				</div>
				{#if open === k.name}
					<pre
						class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">{value ?? "Loading…"}</pre>
				{/if}
			</li>
		{:else}
			<li class="py-2 text-sm text-zinc-500">{loading ? "Loading…" : "No keys."}</li>
		{/each}
	</ul>
	{#if cursor}
		<button class="{btnGhost} mt-4" disabled={loading} onclick={() => load(true)}>
			Load more
		</button>
	{/if}
</section>
