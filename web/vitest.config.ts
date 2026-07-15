import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: { include: ['src/**/*.test.ts'] },
	resolve: {
		alias: {
			'$env/dynamic/private': new URL('./test/env-stub.ts', import.meta.url).pathname,
			$lib: new URL('./src/lib', import.meta.url).pathname
		}
	}
})
