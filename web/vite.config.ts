import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-node: web is always deployed as a Node server (docker/Dockerfile.web,
			// cloudron/Dockerfile). Configured here rather than in svelte.config.js — kit
			// warns if both exist, and inline options win.
			adapter: adapter()
		})
	]
});
