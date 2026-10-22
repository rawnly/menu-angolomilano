<script lang="ts">
	import { onMount } from "svelte";
	import { api, type RunDetail, type RunSummary } from "./api";
	import { btnGhost, card } from "./styles";

	let runs = $state<RunSummary[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let open = $state<string | null>(null);
	let detail = $state<RunDetail | null>(null);

	const load = async () => {
		loading = true;
		error = null;
		try {
			runs = (await api.runs()).runs;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	};

	const toggle = async (key: string) => {
		if (open === key) return (open = null);
		open = key;
		detail = null;
		try {
			detail = (await api.run(key)).run;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	};

	const badge = {
		published: "bg-emerald-900 text-emerald-300",
		skipped: "bg-zinc-800 text-zinc-300",
		error: "bg-red-900 text-red-300",
	};

	onMount(load);
</script>

<section class={card}>
	<div class="mb-4 flex items-center justify-between">
		<div>
			<h2 class="font-medium">Run history</h2>
			<p class="text-sm text-zinc-400">Last 30 days, newest first.</p>
		</div>
		<button class={btnGhost} onclick={load} disabled={loading}>Reload</button>
	</div>
	{#if error}<p class="text-sm text-red-400">{error}</p>{/if}
	<ul class="divide-y divide-zinc-800">
		{#each runs as r (r.key)}
			<li class="py-2">
				<button
					class="flex w-full items-center gap-3 text-left text-sm"
					onclick={() => toggle(r.key)}
				>
					<span class="rounded px-2 py-0.5 text-xs {badge[r.status]}">{r.status}</span>
					<span class="text-zinc-400">{r.trigger}</span>
					<span class="text-zinc-500">{new Date(r.at).toLocaleString()}</span>
					{#if r.error}<span class="truncate text-red-400">{r.error}</span>{/if}
				</button>
				{#if open === r.key}
					<div class="mt-2 space-y-2 rounded-lg bg-zinc-950 p-3 text-sm">
						{#if !detail}
							<p class="text-zinc-500">Loading…</p>
						{:else}
							{#if detail.similarity !== undefined}
								<p class="text-zinc-400">
									similarity vs previous: {(detail.similarity * 100).toFixed(1)}%
								</p>
							{/if}
							{#if detail.url}
								<img src={detail.url} alt="" class="max-h-64 rounded" />
							{/if}
							{#if detail.text}
								<pre class="whitespace-pre-wrap text-zinc-300">{detail.text}</pre>
							{/if}
							{#if detail.cause}
								<pre class="overflow-auto text-xs text-red-300">{JSON.stringify(detail.cause, null, 2)}</pre>
							{/if}
						{/if}
					</div>
				{/if}
			</li>
		{:else}
			<li class="py-2 text-sm text-zinc-500">
				{loading ? "Loading…" : "No runs recorded yet — history starts from the next run."}
			</li>
		{/each}
	</ul>
</section>
