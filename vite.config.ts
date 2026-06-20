import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// .hdr / .glb / .gltf are treated as static assets so `import url from './x.glb'`
// resolves to a served URL that GLTFLoader / RGBELoader can fetch.
//
// PREVIEW=1 emits stable (un-hashed) asset filenames. The githack preview serves
// files straight off a branch; with hashed names a force-push leaves the cached
// index.html pointing at a JS file that no longer exists (-> blank page). Stable
// names mean index.html always references the same path. Real production builds
// (no PREVIEW) keep content hashes for proper cache-busting.
const preview = !!process.env.PREVIEW

export default defineConfig({
  plugins: [react()],
  assetsInclude: ['**/*.hdr', '**/*.glb', '**/*.gltf', '**/*.exr'],
  server: { host: true },
  build: preview
    ? {
        rollupOptions: {
          output: {
            entryFileNames: 'assets/[name].js',
            chunkFileNames: 'assets/[name].js',
            assetFileNames: 'assets/[name][extname]',
          },
        },
      }
    : {},
})

