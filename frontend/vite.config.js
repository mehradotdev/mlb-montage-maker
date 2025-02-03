import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // root: 'src/',
  // assetsInclude: ['**/*.json', '**/*.mp3'],
  build: {
    // outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'main': resolve(__dirname, 'index.html'),
        'beat-editor': resolve(__dirname, 'beat-editor/index.html'),
        'montage-viewer': resolve(__dirname, 'montage-viewer/index.html'),
      },
    },
  },
})
