import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@asm/shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // Stable vendor chunks improve repeat navigation and release-to-release
        // caching while route-level chunks keep admin/editor code off the login path.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/firebase/') || id.includes('/@firebase/')) return 'firebase';
          if (
            id.includes('/react/')
            || id.includes('/react-dom/')
            || id.includes('/react-router')
            || id.includes('/@tanstack/react-query/')
          ) return 'react-vendor';
          if (id.includes('/@radix-ui/')) return 'radix-ui';
          return undefined;
        },
      },
    },
  },
});
