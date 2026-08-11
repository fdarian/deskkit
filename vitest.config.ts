import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * `src/sqlite/client.ts` imports `bun:sqlite`, so this suite only runs under
 * Bun — see the `test` script's `bun --bun vitest run` (plain `vitest run`
 * resolves vitest's bin via its `#!/usr/bin/env node` shebang and hands the
 * *entire* process tree, workers included, to the system Node.js instead).
 */
export default defineConfig({
	plugins: [
		{
			// `gen-migrations` embeds each migration's `.sql` file via Bun's
			// `with { type: 'text' }` import attribute (see
			// `src/sqlite/gen-migrations.ts`) so `bun build --compile` can inline
			// it. Vite/rolldown doesn't understand that attribute — without this,
			// it loads the raw SQL and then tries to parse it as JS. Short-circuit
			// with the same result Bun's own loader produces: the file's text as
			// the module's default export.
			name: 'bun-sql-text-import',
			load(id) {
				if (id.endsWith('.sql')) {
					return `export default ${JSON.stringify(readFileSync(id, 'utf-8'))};`;
				}
			},
		},
	],
	test: {
		server: {
			deps: {
				// `bun:sqlite` isn't a Node builtin, so Vite tries to resolve it as
				// an npm package and fails before the test ever runs. Treat any
				// `bun:` specifier as external so it's left for Bun's own runtime
				// import to resolve — this suite only ever runs under Bun (see the
				// `test` script).
				external: [/^bun:/],
			},
		},
	},
});
