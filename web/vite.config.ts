import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss(), svelte()],
	server: {
		// `wrangler dev` (with DEV_AUTH_BYPASS=1) serves the API on :8787
		proxy: { "/api": "http://localhost:8787" },
	},
});
