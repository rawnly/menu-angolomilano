<script lang="ts">
	import { onMount } from "svelte";
	import { api } from "./api";
	import Cache from "./Cache.svelte";
	import Dashboard from "./Dashboard.svelte";
	import History from "./History.svelte";

	const TABS = ["dashboard", "history", "cache"] as const;
	type Tab = (typeof TABS)[number];

	const fromHash = (): Tab => {
		const h = location.hash.slice(1) as Tab;
		return TABS.includes(h) ? h : "dashboard";
	};

	let tab = $state<Tab>(fromHash());
	let email = $state<string | null>(null);

	onMount(() => {
		api.me().then((m) => (email = m.email)).catch(() => {});
	});
</script>

<svelte:window onhashchange={() => (tab = fromHash())} />

<main class="mx-auto max-w-4xl space-y-6 p-6">
	<header class="flex items-center justify-between">
		<h1 class="text-xl font-semibold">🍝 Angolo Milano</h1>
		<span class="text-sm text-zinc-400">{email ?? ""}</span>
	</header>

	<nav class="flex gap-1 border-b border-zinc-800">
		{#each TABS as t}
			<a
				href="#{t}"
				class="px-3 py-2 text-sm capitalize {tab === t
					? 'border-b-2 border-amber-500 text-zinc-100'
					: 'text-zinc-400 hover:text-zinc-200'}">{t}</a
			>
		{/each}
	</nav>

	{#if tab === "dashboard"}<Dashboard />
	{:else if tab === "history"}<History />
	{:else}<Cache />{/if}
</main>
