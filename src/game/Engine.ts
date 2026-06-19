import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { SAOPass } from 'three/examples/jsm/postprocessing/SAOPass.js'
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { config } from './config'
import { disposeObject } from './utils'
import { createEnvTexture } from './procedural'
import type { QualityTier } from './tiers'

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
  readonly tier: QualityTier

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
  private saoPass: SAOPass | null = null
  private bokehPass: BokehPass | null = null
  private smaaPass: SMAAPass | null = null

  constructor(container: HTMLElement, tier: QualityTier) {
    this.container = container
    this.tier = tier
    this.pixelCap = tier.pixelRatioCap
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
    this.renderer.shadowMap.enabled = tier.shadows
    this.renderer.shadowMap.type = tier.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap
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
      samples: tier.msaaSamples,
    })
    this.composer = new EffectComposer(this.renderer, this.renderTarget)
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)

    this.composer.addPass(new RenderPass(this.scene, this.camera))

    // SSAO (desktop): grounds geometry contact and adds depth to the city. Added
    // before bloom so occluded creases stay dark before neon is bloomed.
    if (tier.ssao) {
      this.saoPass = new SAOPass(this.scene, this.camera)
      this.saoPass.params.saoIntensity = 0.012
      this.saoPass.params.saoScale = 6
      this.saoPass.params.saoKernelRadius = 24
      this.saoPass.params.saoBlur = true
      this.composer.addPass(this.saoPass)
    }

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      config.render.bloom.strength * (tier.name === 'high' ? 1 : 0.85),
      config.render.bloom.radius,
      config.render.bloom.threshold,
    )
    if (tier.bloom) this.composer.addPass(this.bloomPass)

    // Subtle cinematic depth of field (desktop). Keeps the focal subject crisp
    // while distant towers soften - reads as a lens, not a blur.
    if (tier.dof) {
      this.bokehPass = new BokehPass(this.scene, this.camera, {
        focus: 18,
        aperture: 0.00018,
        maxblur: 0.006,
      })
      this.composer.addPass(this.bokehPass)
    }

    this.composer.addPass(new OutputPass())

    // Cheap edge AA on the path that has no MSAA (mobile).
    if (tier.smaa) {
      this.smaaPass = new SMAAPass(w * dpr, h * dpr)
      this.composer.addPass(this.smaaPass)
    }

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
  }

  /** Drive the DoF focus distance from gameplay (e.g. distance to the player). */
  setFocusDistance(d: number) {
    if (!this.bokehPass) return
    const u = (this.bokehPass.uniforms as Record<string, { value: number }>)['focus']
    if (u) u.value = THREE.MathUtils.clamp(d, 4, 120)
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
    this.saoPass?.setSize(w, h)
    const dpr = this.renderer.getPixelRatio()
    this.smaaPass?.setSize(w * dpr, h * dpr)
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
