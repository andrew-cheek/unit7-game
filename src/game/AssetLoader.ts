import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * Optional asset manifest, fetched from `${base}manifest.json`. Ships with
 * `useAssets: false`, so by default the game runs entirely on the procedural
 * models/sky in procedural.ts - no network requests, no console noise. To use
 * the real CC0 assets: drop the files into public/unit7/<path>, list them here,
 * and flip useAssets to true. Anything that fails to load silently falls back
 * to its procedural placeholder, so the game always runs.
 */
export interface AssetManifest {
  useAssets?: boolean
  env?: string | null
  models?: Record<string, string>
  textures?: Record<string, { map?: string; normal?: string; rough?: string }>
}

export interface TextureSet {
  map?: THREE.Texture
  normalMap?: THREE.Texture
  roughnessMap?: THREE.Texture
}

export class AssetLoader {
  readonly base: string
  loaded = false
  usedAssets = false

  envTexture: THREE.Texture | null = null
  background: THREE.Texture | null = null

  private gltfLoader = new GLTFLoader()
  private rgbeLoader = new RGBELoader()
  private texLoader = new THREE.TextureLoader()
  private models: Record<string, GLTF> = {}
  private textures: Record<string, TextureSet> = {}

  constructor(base = '/unit7/') {
    this.base = base
  }

  /** Resolve the manifest and load anything it declares. Never throws. */
  async loadAll(renderer: THREE.WebGLRenderer, onProgress?: (p: number, msg: string) => void) {
    let manifest: AssetManifest = {}
    try {
      const res = await fetch(this.base + 'manifest.json', { cache: 'no-cache' })
      if (res.ok) manifest = await res.json()
    } catch {
      /* no manifest -> procedural */
    }

    if (!manifest.useAssets) {
      onProgress?.(1, 'Procedural assets ready')
      this.loaded = true
      return
    }
    this.usedAssets = true

    const jobs: Array<Promise<void>> = []
    let done = 0
    let total = 0
    const tick = (msg: string) => onProgress?.(total ? done / total : 1, msg)

    if (manifest.env) {
      total++
      jobs.push(
        this.rgbeLoader
          .loadAsync(this.base + manifest.env)
          .then((tex) => {
            const pmrem = new THREE.PMREMGenerator(renderer)
            this.envTexture = pmrem.fromEquirectangular(tex).texture
            tex.mapping = THREE.EquirectangularReflectionMapping
            this.background = tex
            pmrem.dispose()
          })
          .catch(() => {})
          .finally(() => {
            done++
            tick('Environment')
          }),
      )
    }

    for (const [key, path] of Object.entries(manifest.models ?? {})) {
      total++
      jobs.push(
        this.gltfLoader
          .loadAsync(this.base + path)
          .then((gltf) => {
            this.models[key] = gltf
          })
          .catch(() => {})
          .finally(() => {
            done++
            tick(`Model: ${key}`)
          }),
      )
    }

    for (const [key, set] of Object.entries(manifest.textures ?? {})) {
      total++
      jobs.push(
        this.loadTextureSet(set)
          .then((ts) => {
            this.textures[key] = ts
          })
          .catch(() => {})
          .finally(() => {
            done++
            tick(`Texture: ${key}`)
          }),
      )
    }

    await Promise.all(jobs)
    this.loaded = true
    onProgress?.(1, 'Assets ready')
  }

  private async loadTextureSet(set: { map?: string; normal?: string; rough?: string }): Promise<TextureSet> {
    const out: TextureSet = {}
    if (set.map) {
      out.map = await this.texLoader.loadAsync(this.base + set.map)
      out.map.colorSpace = THREE.SRGBColorSpace
      out.map.wrapS = out.map.wrapT = THREE.RepeatWrapping
    }
    if (set.normal) {
      out.normalMap = await this.texLoader.loadAsync(this.base + set.normal)
      out.normalMap.wrapS = out.normalMap.wrapT = THREE.RepeatWrapping
    }
    if (set.rough) {
      out.roughnessMap = await this.texLoader.loadAsync(this.base + set.rough)
      out.roughnessMap.wrapS = out.roughnessMap.wrapT = THREE.RepeatWrapping
    }
    return out
  }

  /** A fresh clone of a loaded model's scene, or null to use a procedural one. */
  getModelScene(key: string): THREE.Object3D | null {
    const gltf = this.models[key]
    return gltf ? gltf.scene.clone(true) : null
  }
  getAnimations(key: string): THREE.AnimationClip[] {
    return this.models[key]?.animations ?? []
  }
  getTextureSet(key: string): TextureSet | null {
    return this.textures[key] ?? null
  }

  dispose() {
    this.envTexture?.dispose()
    this.background?.dispose()
    for (const ts of Object.values(this.textures)) {
      ts.map?.dispose()
      ts.normalMap?.dispose()
      ts.roughnessMap?.dispose()
    }
  }
}
