import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { config } from './config'
import { disposeObject } from './utils'
import { createEnvTexture } from './procedural'
import type { AssetQuality } from './types'

/**
 * Owns the renderer, scene, camera, post-processing chain and the hand-rolled
 * render loop. Knows nothing about gameplay - `onUpdate` is the single hook the
 * orchestrator (Game) drives each frame. Variable timestep, clamped so a
 * backgrounded tab can't produce a huge dt that tunnels entities through walls.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly composer: EffectComposer
  readonly bloomPass: UnrealBloomPass
  readonly container: HTMLElement

  /** Driven by Game; receives clamped delta + total elapsed seconds. */
  onUpdate: ((dt: number, elapsed: number) => void) | null = null

  private clock = new THREE.Clock()
  private elapsed = 0
  private rafId = 0
  private running = false
  private disposed = false
  private resizeObserver: ResizeObserver
  private renderTarget: THREE.WebGLRenderTarget
  private envTex: THREE.Texture
  private pixelCap: number

  constructor(container: HTMLElement, quality: AssetQuality) {
    this.container = container
    this.pixelCap = quality === 'high' ? config.render.pixelRatioCap : 1.5
    const w = Math.max(1, container.clientWidth)
    const h = Math.max(1, container.clientHeight)

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // MSAA is done on the composer's HDR target instead
      powerPreference: 'high-performance',
      stencil: false,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelCap))
    this.renderer.setSize(w, h)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = config.render.exposure
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.renderer.domElement.style.touchAction = 'none'
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    // IBL so PBR metals reflect cohesive neon instead of rendering black at night.
    this.envTex = createEnvTexture(this.renderer)
    this.scene.environment = this.envTex

    this.camera = new THREE.PerspectiveCamera(config.camera.fov, w / h, 0.1, 2000)
    this.camera.position.set(0, 12, 22)
    this.camera.lookAt(0, 1, 0)

    // HDR, optionally multisampled buffer so neon edges stay clean through bloom.
    const dpr = this.renderer.getPixelRatio()
    this.renderTarget = new THREE.WebGLRenderTarget(Math.floor(w * dpr), Math.floor(h * dpr), {
      type: THREE.HalfFloatType,
      samples: quality === 'high' ? 4 : 0,
    })
    this.composer = new EffectComposer(this.renderer, this.renderTarget)
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)

    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      config.render.bloom.strength,
      config.render.bloom.radius,
      config.render.bloom.threshold,
    )
    this.composer.addPass(this.bloomPass)
    this.composer.addPass(new OutputPass())

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
  }

  start() {
    if (this.running || this.disposed) return
    this.running = true
    this.clock.start()
    this.rafId = requestAnimationFrame(this.loop)
  }

  stop() {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  private loop = () => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.loop)
    let dt = this.clock.getDelta()
    if (dt > config.render.maxFrameDelta) dt = config.render.maxFrameDelta
    this.elapsed += dt
    if (this.onUpdate) {
      try {
        this.onUpdate(dt, this.elapsed)
      } catch (err) {
        console.error('[Unit7] update error:', err)
      }
    }
    this.composer.render()
  }

  resize = () => {
    if (this.disposed) return
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelCap))
    this.renderer.setSize(w, h)
    this.composer.setPixelRatio(this.renderer.getPixelRatio())
    this.composer.setSize(w, h)
    this.bloomPass.setSize(w, h)
  }

  /** Full GPU + DOM teardown. Safe to call twice. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.onUpdate = null
    this.resizeObserver.disconnect()

    disposeObject(this.scene)
    this.scene.clear()
    this.envTex.dispose()

    for (const pass of this.composer.passes) {
      const p = pass as unknown as { dispose?: () => void }
      p.dispose?.()
    }
    this.renderTarget.dispose()
    this.composer.renderTarget1.dispose()
    this.composer.renderTarget2.dispose()

    this.renderer.dispose()
    this.renderer.forceContextLoss()
    const el = this.renderer.domElement
    if (el.parentNode) el.parentNode.removeChild(el)
  }
}
