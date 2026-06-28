import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player position, so the puddle field always surrounds wherever you are. */
  playerPos: () => THREE.Vector3
  /** Current zone; these reflections are Earth-only. */
  zone: () => Zone
}

/** Deterministic PRNG so the puddle layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const HALF = 26 // half-extent of the puddle spread around the player (XZ)
const WRAP = 26 // distance from player at which a puddle wraps to the far side
const Y = 0.05 // sit just above the asphalt to avoid z-fighting with the ground

/**
 * Neon reflections: a handful of soft additive coloured light "puddles" smeared
 * flat on the wet asphalt around the player, in neon hues (cyan / magenta / lime /
 * orange). Each gently drifts and pulses opacity, reading as signage bleeding onto
 * the ground rather than a solid decal. The field wraps to stay centred on you (like
 * NeonRain) so puddles are always underfoot without infinite spawning. Earth only.
 * One InstancedMesh of flat quads with a radial-glow texture = ~1 draw call. Pure
 * atmosphere - no colliders, no gameplay. Disposed together.
 */
export class NeonReflections implements GameSystem {
  private mesh: THREE.InstancedMesh | null = null
  private geo: THREE.PlaneGeometry | null = null
  private mat: THREE.MeshBasicMaterial | null = null
  private tex: THREE.Texture | null = null

  private n = 0
  private t = 0
  private zone: Zone = 'earth'

  // Per-instance state (flat arrays, no per-frame allocation).
  private baseX: Float32Array = new Float32Array(0)
  private baseZ: Float32Array = new Float32Array(0)
  private size: Float32Array = new Float32Array(0)
  private rot: Float32Array = new Float32Array(0)
  private rotVel: Float32Array = new Float32Array(0)
  private driftX: Float32Array = new Float32Array(0)
  private driftZ: Float32Array = new Float32Array(0)
  private driftSpeed: Float32Array = new Float32Array(0)
  private pulsePhase: Float32Array = new Float32Array(0)
  private pulseRate: Float32Array = new Float32Array(0)
  private baseAlpha: Float32Array = new Float32Array(0)

  // Scratch, reused every frame so update() never allocates.
  private center = new THREE.Vector3()
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private eul = new THREE.Euler()
  private scratchPos = new THREE.Vector3()
  private scratchScale = new THREE.Vector3(1, 1, 1)

  // Neon hues for the reflected signage.
  private tints = [
    new THREE.Color(0x29e6ff), // cyan
    new THREE.Color(0xff36c6), // magenta
    new THREE.Color(0x9bff42), // lime
    new THREE.Color(0xff8a1e), // orange
  ]

  constructor(scene: THREE.Scene, private deps: Deps) {
    // Tier counts: high 14 / medium 9 / low 0 (disabled).
    this.n = config.tier.name === 'low' ? 0 : (config.tier.name === 'medium' ? 9 : 14)
    if (this.n === 0) return

    this.tex = this.makeGlowTexture()

    // A 1x1 quad in the XY plane; per-instance scale sizes each puddle and the
    // instance rotation lays it flat on the ground.
    this.geo = new THREE.PlaneGeometry(1, 1)

    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    })

    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, this.n)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // The field wraps every frame; skip frustum cull so puddles never pop.
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 2

    // Allocate per-instance state.
    this.baseX = new Float32Array(this.n)
    this.baseZ = new Float32Array(this.n)
    this.size = new Float32Array(this.n)
    this.rot = new Float32Array(this.n)
    this.rotVel = new Float32Array(this.n)
    this.driftX = new Float32Array(this.n)
    this.driftZ = new Float32Array(this.n)
    this.driftSpeed = new Float32Array(this.n)
    this.pulsePhase = new Float32Array(this.n)
    this.pulseRate = new Float32Array(this.n)
    this.baseAlpha = new Float32Array(this.n)

    const rnd = mulberry32(551237)
    const f = this.deps.playerPos()
    for (let i = 0; i < this.n; i++) {
      this.baseX[i] = f.x + (rnd() * 2 - 1) * HALF
      this.baseZ[i] = f.z + (rnd() * 2 - 1) * HALF
      // Wide soft puddles / streaks.
      this.size[i] = 4 + rnd() * 7
      this.rot[i] = rnd() * Math.PI * 2
      this.rotVel[i] = (rnd() * 2 - 1) * 0.12
      // Gentle drift direction (unit vector), advanced by driftSpeed.
      const a = rnd() * Math.PI * 2
      this.driftX[i] = Math.cos(a)
      this.driftZ[i] = Math.sin(a)
      this.driftSpeed[i] = 0.15 + rnd() * 0.35
      this.pulsePhase[i] = rnd() * Math.PI * 2
      this.pulseRate[i] = 0.5 + rnd() * 0.9
      this.baseAlpha[i] = 0.55 + rnd() * 0.45

      const c = this.tints[(rnd() * this.tints.length) | 0]
      this.mesh.setColorAt(i, c)
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true

    // Seed the first frame's matrices so it's valid before update() runs.
    this.writeFrame(f)
    scene.add(this.mesh)
  }

  setZone(zone: Zone) {
    this.zone = zone
    if (this.mesh) this.mesh.visible = zone === 'earth'
  }

  /**
   * Build every instance matrix for the current frame, laid flat on the ground and
   * wrapped around `center`. The 0..1 pulse drives a gentle scale breathe here; the
   * caller folds the returned peak alpha into the global material opacity. Returns
   * the peak per-instance alpha so the field stays subtle.
   */
  private writeFrame(center: THREE.Vector3): number {
    if (!this.mesh) return 0
    const span = WRAP * 2
    let peak = 0
    for (let i = 0; i < this.n; i++) {
      let x = this.baseX[i]
      let z = this.baseZ[i]
      const dx = x - center.x
      if (dx > WRAP) { x -= span; this.baseX[i] = x }
      else if (dx < -WRAP) { x += span; this.baseX[i] = x }
      const dz = z - center.z
      if (dz > WRAP) { z -= span; this.baseZ[i] = z }
      else if (dz < -WRAP) { z += span; this.baseZ[i] = z }

      // 0..1 pulse drives both a gentle alpha swell and a soft scale breathe.
      const pulse = 0.5 + 0.5 * Math.sin(this.t * this.pulseRate[i] + this.pulsePhase[i])
      const alpha = this.baseAlpha[i] * (0.55 + 0.45 * pulse)
      if (alpha > peak) peak = alpha
      const s = this.size[i] * (0.92 + 0.08 * pulse)

      // Lay flat: tilt -90deg about X (face up), then spin in-plane about Y.
      this.eul.set(-Math.PI / 2, this.rot[i], 0, 'YXZ')
      this.q.setFromEuler(this.eul)
      this.scratchPos.set(x, Y, z)
      this.scratchScale.set(s, s, 1)
      this.m.compose(this.scratchPos, this.q, this.scratchScale)
      this.mesh.setMatrixAt(i, this.m)
    }
    return peak
  }

  update(dt: number) {
    if (!this.mesh) return
    // Earth-only; hide off-world.
    if (this.deps.zone() !== 'earth') {
      if (this.mesh.visible) this.mesh.visible = false
      return
    }
    if (!this.mesh.visible) this.mesh.visible = true

    this.t += dt

    // Advance drift + rotation (frame-rate-independent: scaled by dt).
    for (let i = 0; i < this.n; i++) {
      this.baseX[i] += this.driftX[i] * this.driftSpeed[i] * dt
      this.baseZ[i] += this.driftZ[i] * this.driftSpeed[i] * dt
      this.rot[i] += this.rotVel[i] * dt
    }

    const f = this.deps.playerPos()
    this.center.copy(f)
    const peak = this.writeFrame(this.center)

    this.mesh.instanceMatrix.needsUpdate = true
    // Keep it subtle: cap the global opacity low so the field never reads solid.
    if (this.mat) this.mat.opacity = Math.min(0.6, 0.22 + peak * 0.3)
  }

  /** Radial soft-glow sprite: bright centre fading to transparent edges. */
  private makeGlowTexture(): THREE.Texture {
    const S = 128
    const cv = document.createElement('canvas')
    cv.width = S
    cv.height = S
    const ctx = cv.getContext('2d')!
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
    g.addColorStop(0.0, 'rgba(255,255,255,1.0)')
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)')
    g.addColorStop(0.6, 'rgba(255,255,255,0.18)')
    g.addColorStop(1.0, 'rgba(255,255,255,0.0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, S, S)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    return tex
  }

  dispose() {
    if (this.mesh) {
      this.mesh.parent?.remove(this.mesh)
      this.mesh.dispose()
      this.mesh = null
    }
    this.geo?.dispose()
    this.mat?.dispose()
    this.tex?.dispose()
    this.geo = null
    this.mat = null
    this.tex = null
  }
}
