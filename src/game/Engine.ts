import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { SAOPass } from 'three/examples/jsm/postprocessing/SAOPass.js'
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { config } from './config'
import { disposeObject } from './utils'
import { createEnvTexture } from './procedural'
import type { QualityTier } from './tiers'

// Cinematic colour-grade + vignette applied as a final full-screen pass: a cool
// cyberpunk tint, gentle S-curve contrast, and darkened corners. Cheap (one
// texture read), runs on every tier. The tint / highlight / vignette are
// uniforms so the grade can be set per zone (warm Mars, cool Moon, neon Earth).
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTint: { value: new THREE.Vector3(0.9, 1.0, 1.1) }, // shadow/mid color push
    uTintAmt: { value: 0.45 }, // how much of the tint to mix in
    uHi: { value: new THREE.Vector3(0.04, 0.0, 0.05) }, // additive highlight cast
    uVignette: { value: 0.45 }, // corner darkening strength
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec3 uTint;
    uniform float uTintAmt;
    uniform vec3 uHi;
    uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // gentle contrast S-curve
      c.rgb = (c.rgb - 0.5) * 1.07 + 0.5;
      // tinted shadows/mids + an additive highlight cast (neon-noir on Earth,
      // warm on Mars, near-neutral on the Moon - all driven by uniforms)
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(c.rgb, c.rgb * uTint, uTintAmt);
      c.rgb += uHi * smoothstep(0.6, 1.0, l);
      // vignette
      float d = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - smoothstep(0.55, 0.95, d) * uVignette;
      gl_FragColor = c;
    }
  `,
}

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
  /** Driven by Game once per rendered frame (real clamped frame delta), before
   *  the composer renders. Hosts per-frame work that must stay smooth at the
   *  display rate rather than the fixed sim rate — the follow camera + look. */
  onRender: ((frameDt: number) => void) | null = null
  /** Smoothed real render frame rate (the sim now always steps at a fixed dt). */
  fps = 60
  /** Interpolation fraction into the next fixed sim step (0..1), for smooth render. */
  alpha = 0
  // Per-frame render stats, cached once at the end of each frame so a console
  // read (window.__UNIT7__) gets stable numbers instead of catching the counter
  // mid-accumulation or after a 1-triangle post-processing pass.
  drawCalls = 0
  triangles = 0

  private clock = new THREE.Clock()
  private elapsed = 0
  private accumulator = 0
  private rafId = 0
  private running = false
  private disposed = false
  private resizeObserver: ResizeObserver
  private renderTarget: THREE.WebGLRenderTarget
  private envTex: THREE.Texture
  private pixelCap: number
  private baseBloom = 1
  private saoPass: SAOPass | null = null
  private bokehPass: BokehPass | null = null
  private smaaPass: SMAAPass | null = null
  private gradePass: ShaderPass | null = null
  // Adaptive resolution: scales the drawing-buffer pixel ratio up/down to hold
  // a smooth frame rate. 1 = full (capped) res; floor keeps it from getting too
  // soft. Re-evaluated on a timer so we don't reallocate buffers every frame.
  private renderScale = 1
  private adaptTimer = 0
  private adaptiveOn = true // when false, adapt() is frozen (e.g. during the drop-in)
  private contextLost = false // true between webglcontextlost and ...restored
  private static readonly SCALE_FLOOR = 0.6
  // Hitstop: a brief sim-time slowdown for impact weight. We scale the wall-clock
  // time fed into the fixed-step accumulator (NOT the fixed dt itself), so every
  // simulation step is still exactly 1/60 and gameplay stays deterministic - we
  // just feed the accumulator fewer steps for a few real milliseconds.
  private hitstop = 0
  private hitstopScale = 0.06
  // Additive FOV (degrees) layered on the adaptive base, e.g. a sprint punch.
  private baseFov = config.camera.fov
  private fovBoost = 0
  // Bloom render-target scale relative to the frame. Half-res = soft, cheap,
  // and free of the sub-pixel shimmer full-res bloom amplifies on far neon.
  // Mobile (low) drops to 0.4 for a cheaper blur that still reads as neon glow.
  private bloomScale = 0.5

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
      // A logarithmic depth buffer gives near-uniform precision across the whole
      // 0.5..900 range, which is what kills the z-fighting/flicker on distant
      // towers, the road grid and the big fog-immune landmarks. Standard depth
      // precision is starved here because the near plane is forced very small
      // (the wall-collision camera tucks to 0.7).
      //
      // Off on mobile (low): a logarithmic depth buffer writes gl_FragDepth in
      // the fragment shader, which disables early-Z / hierarchical-Z on the
      // tile-based GPUs phones use - a real fill-rate cost. The low tier's short
      // draw distance (~220m) + heavy fog hide the distant surfaces that would
      // otherwise z-fight, so standard depth is the better trade there.
      logarithmicDepthBuffer: tier.name !== 'low',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelCap))
    this.renderer.setSize(w, h)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    // Manual reset: the counter accumulates across the whole frame (scene +
    // every composer pass) and we snapshot it after composer.render, so the
    // exposed stat is the real per-frame total, not whatever the last pass left.
    this.renderer.info.autoReset = false
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = config.render.exposure
    this.renderer.shadowMap.enabled = tier.shadows
    this.renderer.shadowMap.type = tier.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.renderer.domElement.style.touchAction = 'none'
    container.appendChild(this.renderer.domElement)

    // WebGL context loss recovery. Phones drop the GL context under memory
    // pressure (or when backgrounded); without this the canvas just stays black.
    // preventDefault() asks the browser to restore it, and we pause rendering in
    // between so we don't thrash a dead context.
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.contextLost = true
      console.warn('[Unit7] WebGL context lost - pausing render until restored')
    }, false)
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextLost = false
      // Three.js reinitialises its GL state on the restored context; nudge the
      // size so all render targets are reallocated cleanly.
      this.applyResolution()
      console.warn('[Unit7] WebGL context restored')
    }, false)

    this.scene = new THREE.Scene()
    // IBL so PBR metals reflect cohesive neon instead of rendering black at night.
    this.envTex = createEnvTexture(this.renderer)
    this.scene.environment = this.envTex

    // Near/far define depth-buffer precision: the ratio (far/near) is what
    // matters. 0.1/2000 (20,000:1) starved the buffer and let distant towers,
    // the road grid and billboards z-fight and shimmer. 0.5/900 (1,800:1) is
    // ~9x tighter while still clearing every fog-immune landmark (640m space
    // elevator, 220m plaza beam, skyline ring, high ship flyovers).
    this.camera = new THREE.PerspectiveCamera(config.camera.fov, w / h, 0.5, 900)
    this.applyAdaptiveFov(w / h)
    this.camera.updateProjectionMatrix()
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

    // Bloom runs at half resolution. It's a blur to begin with, so the quality
    // hit is invisible, but the downsample low-pass-filters the high-frequency
    // sub-pixel glints on distant neon that full-res bloom was turning into
    // crawling shimmer. Cheaper too.
    this.bloomScale = tier.name === 'low' ? 0.4 : 0.5
    this.baseBloom = config.render.bloom.strength * (tier.name === 'high' ? 1 : tier.name === 'low' ? 0.72 : 0.85)
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(1, w * this.bloomScale), Math.max(1, h * this.bloomScale)),
      this.baseBloom,
      config.render.bloom.radius,
      // High tier lowers the threshold a touch so mid-bright hero neon actually
      // halos: after ACES tonemapping the bright signs/cores sit below white, so
      // the old ~1.0 threshold meant almost nothing bloomed. 0.78 is deliberately
      // conservative — it lets the hero emitters bloom while keeping the dimmer
      // lit windows out of it, so the city doesn't haze up (the original intent).
      // Tune down further toward 0.7 if the neon should read punchier on a device.
      // Low/medium keep the tuned default (their bloom is already closer to right).
      tier.name === 'high' ? 0.78 : config.render.bloom.threshold,
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

    // Cinematic colour-grade + vignette (final look pass). Kept as a field so the
    // grade can be retuned per zone (warm Mars, cool Moon) from gameplay.
    this.gradePass = new ShaderPass(GradeShader)
    this.composer.addPass(this.gradePass)

    // Cheap edge AA on the path that has no MSAA (mobile).
    if (tier.smaa) {
      this.smaaPass = new SMAAPass(w * dpr, h * dpr)
      this.composer.addPass(this.smaaPass)
    }

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)

    // Debug handle for inspecting live render stats from the console:
    //   __UNIT7__.fps                     smoothed render FPS
    //   __UNIT7__.drawCalls               per-frame draw calls (stable snapshot)
    //   __UNIT7__.triangles               per-frame triangles (stable snapshot)
    //   __UNIT7__.renderer.info.memory    geometries / textures
    //   __UNIT7__.renderScale             current adaptive-resolution scale
    // Read-only; cleared on dispose. No effect on gameplay.
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __UNIT7__?: unknown }).__UNIT7__ = this
    }
  }

  /**
   * Scale bloom by time of day: full (capped) neon glow at night, eased down in
   * daylight so noon reads calm/warm and the night reads as the bright neon
   * city — without ever exceeding the tuned night value (keeps bloom FPS-safe).
   */
  setBloomScale(s: number) {
    this.bloomPass.strength = this.baseBloom * s
  }

  /** Ramp tone-mapping exposure (e.g. by time of day): a touch darker at noon so
   *  highlights don't clip, lifted at night so the neon city reads. Pure scalar,
   *  no added cost, both tiers. */
  setExposure(e: number) {
    this.renderer.toneMappingExposure = e
  }

  /** Retune the final colour grade for the active zone. tint multiplies the
   *  shadows/mids, hi is an additive highlight cast, vignette is corner darkening. */
  setGrade(tint: readonly [number, number, number], tintAmt: number, hi: readonly [number, number, number], vignette: number) {
    if (!this.gradePass) return
    const u = this.gradePass.uniforms as Record<string, { value: THREE.Vector3 | number }>
    ;(u.uTint.value as THREE.Vector3).set(tint[0], tint[1], tint[2])
    u.uTintAmt.value = tintAmt
    ;(u.uHi.value as THREE.Vector3).set(hi[0], hi[1], hi[2])
    u.uVignette.value = vignette
  }

  /** Drive the DoF focus distance from gameplay (e.g. distance to the player). */
  setFocusDistance(d: number) {
    if (!this.bokehPass) return
    const u = (this.bokehPass.uniforms as Record<string, { value: number }>)['focus']
    if (u) u.value = THREE.MathUtils.clamp(d, 4, 120)
  }

  /** Trigger a brief freeze-frame for impact weight (capped so rapid hits don't
   *  stack into a long stall). Deterministic: only the sim-time intake slows. */
  triggerHitstop(duration: number, scale = 0.06) {
    this.hitstop = Math.min(0.12, Math.max(this.hitstop, duration))
    this.hitstopScale = scale
  }

  /** Layer an additive FOV (degrees) on the adaptive base, e.g. a sprint punch.
   *  Cheap; only touches the projection matrix when the value actually changes. */
  setFovBoost(deg: number) {
    if (Math.abs(deg - this.fovBoost) < 0.02) return
    this.fovBoost = deg
    this.camera.fov = this.baseFov + this.fovBoost
    this.camera.updateProjectionMatrix()
  }

  /** Live GPU memory counts (geometries / textures) for the debug overlay. */
  memoryInfo(): { geometries: number; textures: number } {
    const m = this.renderer.info.memory
    return { geometries: m.geometries, textures: m.textures }
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

    // rAF drives rendering; a fixed-timestep accumulator drives simulation. Frame
    // time is clamped first so a long stall (backgrounded tab) can't dump a huge
    // backlog of substeps in one go.
    const raw = this.clock.getDelta()
    // Smoothed FPS from the *real* frame time (raw, pre-clamp).
    this.fps += ((1 / Math.max(raw, 1e-4)) - this.fps) * 0.1
    let frame = raw
    if (frame > config.render.maxFrameDelta) frame = config.render.maxFrameDelta
    // Hitstop counts down in real time but throttles the sim intake, so the
    // freeze lasts a fixed wall-clock duration regardless of frame rate.
    if (this.hitstop > 0) {
      this.hitstop = Math.max(0, this.hitstop - raw)
      frame *= this.hitstopScale
    }
    this.accumulator += frame

    const fixed = config.render.fixedDelta
    const maxSteps = this.tier.maxSubSteps
    let steps = 0
    while (this.accumulator >= fixed && steps < maxSteps) {
      this.elapsed += fixed
      if (this.onUpdate) {
        try {
          this.onUpdate(fixed, this.elapsed)
        } catch (err) {
          console.error('[Unit7] update error:', err)
        }
      }
      this.accumulator -= fixed
      steps++
    }
    // Hit the catch-up cap: drop the leftover so we don't spiral after a hitch.
    if (steps === maxSteps) this.accumulator = 0

    // Fraction of the way into the next fixed step (0..1). Render code lerps the
    // player between its previous and current sim positions by this, so motion is
    // smooth on high-refresh displays instead of stepping at the 60Hz sim rate.
    this.alpha = this.accumulator / fixed

    this.adapt(frame)
    // Per-frame hook (camera + look) right before the render, using the real
    // clamped frame delta so it stays smooth on high-refresh displays.
    if (this.onRender) {
      try {
        this.onRender(frame)
      } catch (err) {
        console.error('[Unit7] render error:', err)
      }
    }
    if (this.contextLost) return // GL context is gone; skip rendering until it's restored
    this.renderer.info.reset()
    this.composer.render()
    // Snapshot the accumulated per-frame totals (scene draw + post passes).
    this.drawCalls = this.renderer.info.render.calls
    this.triangles = this.renderer.info.render.triangles
  }

  /**
   * Adaptive resolution: every second, nudge the render scale down when the
   * frame rate is struggling and back up when there's headroom. This is the
   * mobile "never drop below ~30fps" guarantee - it trades a little sharpness
   * for a steady frame rate, then restores sharpness once the load eases.
   */
  /**
   * Freeze or resume adaptive resolution. Freezing pins the drawing-buffer size
   * so no render-target reallocation happens - we use this during the drop-in,
   * where a mid-skydive resize could flash a black frame on some mobile GPUs.
   * Optionally snaps to a fixed scale first (a touch lower on mobile for headroom).
   */
  setAdaptive(on: boolean, snapScale?: number) {
    this.adaptiveOn = on
    if (snapScale != null && Math.abs(snapScale - this.renderScale) > 0.001) {
      this.renderScale = Math.max(Engine.SCALE_FLOOR, Math.min(1, snapScale))
      this.applyResolution()
    }
  }

  private adapt(frame: number) {
    if (!this.adaptiveOn) return
    this.adaptTimer += frame
    if (this.adaptTimer < 1) return
    this.adaptTimer = 0
    const prev = this.renderScale
    // Tier-aware band: desktop targets 60fps (back off below 48, recover above 56);
    // mobile only needs its 30fps floor (back off below 28, recover above 44). The
    // old 30/52 band left a dead zone so a 36-43fps desktop crowd never downscaled.
    const downAt = this.tier.name === 'low' ? 28 : 48
    const upAt = this.tier.name === 'low' ? 44 : 56
    if (this.fps < downAt && this.renderScale > Engine.SCALE_FLOOR) {
      this.renderScale = Math.max(Engine.SCALE_FLOOR, this.renderScale - 0.1)
    } else if (this.fps > upAt && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale + 0.1)
    }
    if (Math.abs(this.renderScale - prev) > 0.001) this.applyResolution()
  }

  /** Effective drawing-buffer pixel ratio (device ratio, capped, then scaled). */
  private effectiveDpr() {
    return Math.min(window.devicePixelRatio || 1, this.pixelCap) * this.renderScale
  }

  private applyResolution() {
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    const dpr = this.effectiveDpr()
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(w, h)
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)
    this.bloomPass.setSize(Math.max(1, w * this.bloomScale), Math.max(1, h * this.bloomScale))
    this.saoPass?.setSize(w, h)
    this.smaaPass?.setSize(w * dpr, h * dpr)
  }

  /**
   * Keep a consistent HORIZONTAL field of view across aspect ratios. Three.js
   * `fov` is vertical, so a tall portrait phone would otherwise collapse the
   * view into a narrow tunnel. We treat `config.camera.fov` as the vertical fov
   * at a 16:9 reference and, on anything narrower, widen the vertical fov so the
   * horizontal view is preserved (capped to avoid fisheye). Landscape is
   * unchanged. This is what makes the game playable in portrait.
   */
  private applyAdaptiveFov(aspect: number) {
    // Reference at 3:2 so normal laptop/desktop ratios (1.5..2.1) keep the exact
    // framing they had; only narrower/portrait viewports widen the fov.
    const refAspect = 1.5
    const baseV = config.camera.fov
    if (aspect >= refAspect) {
      this.baseFov = baseV
    } else {
      const hRef = 2 * Math.atan(Math.tan((baseV * Math.PI) / 360) * refAspect)
      const v = (2 * Math.atan(Math.tan(hRef / 2) / Math.max(0.35, aspect)) * 180) / Math.PI
      this.baseFov = Math.min(100, v)
    }
    this.camera.fov = this.baseFov + this.fovBoost
  }

  resize = () => {
    if (this.disposed) return
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    this.camera.aspect = w / h
    this.applyAdaptiveFov(w / h)
    this.camera.updateProjectionMatrix()
    const dpr = this.effectiveDpr()
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(w, h)
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)
    this.bloomPass.setSize(Math.max(1, w * this.bloomScale), Math.max(1, h * this.bloomScale))
    this.saoPass?.setSize(w, h)
    this.smaaPass?.setSize(w * dpr, h * dpr)
  }

  /** Full GPU + DOM teardown. Safe to call twice. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.onUpdate = null
    this.onRender = null
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

    if (typeof window !== 'undefined') {
      const w = window as unknown as { __UNIT7__?: unknown }
      if (w.__UNIT7__ === this) delete w.__UNIT7__
    }
  }
}
