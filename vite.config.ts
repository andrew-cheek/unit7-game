import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// .hdr / .glb / .gltf are treated as static assets so `import url from './x.glb'`
// resolves to a served URL that GLTFLoader / RGBELoader can fetch.
export default defineConfig({
  plugins: [react()],
  assetsInclude: ['**/*.hdr', '**/*.glb', '**/*.gltf', '**/*.exr'],
  server: { host: true },
})
