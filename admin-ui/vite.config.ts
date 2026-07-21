import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { computeBuildId, injectBuildId } from './scripts/swBuildId'

// S19 — injects a deterministic BUILD_ID into the built sw.js so its static
// cache name changes automatically every deploy (see admin-ui/public/sw.js
// and admin-ui/scripts/swBuildId.ts). Only runs for `vite build`; `vite dev`
// serves public/sw.js raw with the placeholder intact (harmless — see the
// comment at the top of sw.js).
function arcaidSwBuildId(): Plugin {
  let outDir = 'dist';
  let assetFileNames: string[] = [];

  return {
    name: 'arcaid-sw-build-id',
    apply: 'build',
    configResolved(config) {
      outDir = path.isAbsolute(config.build.outDir)
        ? config.build.outDir
        : path.join(config.root, config.build.outDir);
    },
    generateBundle(_options, bundle) {
      assetFileNames = Object.keys(bundle);
    },
    // closeBundle is the last hook in the build lifecycle — runs after
    // writeBundle, so both the rollup-emitted assets AND vite's copy of
    // public/ (which includes sw.js and index.html) are already on disk.
    // Verified empirically: a build fails loudly below if either file is
    // missing at this point, and the real build (see gates) passes.
    closeBundle() {
      const swPath = path.join(outDir, 'sw.js')
      const indexPath = path.join(outDir, 'index.html')

      if (!fs.existsSync(swPath)) {
        throw new Error(
          `[arcaid-sw-build-id] ${swPath} not found — expected public/sw.js to already be ` +
            'copied into the output directory by closeBundle. Build ordering assumption broken.'
        )
      }
      if (!fs.existsSync(indexPath)) {
        throw new Error(`[arcaid-sw-build-id] ${indexPath} not found.`)
      }

      const indexHtml = fs.readFileSync(indexPath, 'utf8')
      const buildId = computeBuildId(assetFileNames, indexHtml)
      const swSource = fs.readFileSync(swPath, 'utf8')
      const injected = injectBuildId(swSource, buildId)
      fs.writeFileSync(swPath, injected)
    },
  }
}

// defineConfig is imported from 'vitest/config' (a superset of vite's) so the
// `test` block below is typed. At runtime it is vite's defineConfig — `vite
// build` loads this file unchanged.
export default defineConfig({
  plugins: [react(), arcaidSwBuildId()],
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
