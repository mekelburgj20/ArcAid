import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// defineConfig is imported from 'vitest/config' (a superset of vite's) so the
// `test` block below is typed. At runtime it is vite's defineConfig — `vite
// build` loads this file unchanged.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.ts',
    css: false,
  },
})
