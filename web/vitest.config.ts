import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
	plugins: [svelte()],
	test: { include: ['src/**/*.test.ts'] },
	resolve: {
		alias: {
			'$env/dynamic/private': new URL('./test/env-stub.ts', import.meta.url).pathname,
			$lib: new URL('./src/lib', import.meta.url).pathname
		}
	}
})
