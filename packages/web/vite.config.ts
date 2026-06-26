import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type PluginOption } from 'vite'

// Plain Vite SPA (no @cloudflare/vite-plugin — it forces SSR, which we don't want).
// Build output (dist/) is served by the main worker via its `assets` config.
// Dev: proxy /api to the local main worker (wrangler dev on :8787).
export default defineConfig({
  // react() and @tailwindcss/vite resolve against slightly different vite type
  // identities under bun's hoisting; the cast keeps tsc happy (runtime is fine).
  plugins: [react(), tailwindcss()] as unknown as PluginOption[],
  resolve: {
    // ESM-safe alias (no __dirname in a type:module config).
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
})
