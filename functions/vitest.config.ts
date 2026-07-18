import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mirror the esbuild alias (see package.json build script) so tests can import
// modules that depend on @asm/shared.
export default defineConfig({
  resolve: {
    alias: {
      '@asm/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
});
