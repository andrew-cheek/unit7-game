import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'

interface Deps {
  /** Player focus position, so ripples bloom wherever you actually are. */
  focus: () => THREE.Vector3
  /** Whether the player is currently touching the ground. */
  grounded: () => boolean
  /** Current planar movement speed (used for step cadence). */
  speed: () => number
  /** Sampled ground height at an XZ, so rings sit on the floor in any zone. */
  groundY: (x: number, z: number) => number
}

// A pooled flat ground ripple. Reused in place: no per-emit allocation, no splice.
interface Ripple {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  active: boolean
  t: number
  life: number
  maxR: number
  baseOpacity: number
}

/**
 * Traversal juice: subtle expanding neon rings that bloom on the ground at the
 * player's feet as they move - a soft ripple emitted periodically while running,
 * and a bigger, brighter one when they land from the air. Pure feedback on the
 * neon floor: no colliders, no gameplay, works in every zone. Rings are a shared
 * geometry + a small pool of additive materials, expanded + faded in place and
 * disposed together.
 */
export class StepRipples implements GameSystem {
  private group = new THREE.Group()
  private ringGeo = new THREE.RingGeometry(0.74, 1, 32)
  private ripples: Ripple[] = []
  // Cyan/teal palette, cycled subtly per emit.
  private tints = [0x49e0ff, 0x3fd8ff, 0x5affe0, 0x6af0ff]
  private colorIdx = 0
  private stepTimer = 0
  private wasGrounded = true

  constructor(scene: THREE.Scene, private deps: Deps) {
    // Pool size scales with tier: medium gets a trimmed count between low and high.
    const tier = config.tier.name
    const n = tier === 'low' ? 8 : tier === 'medium' ? 10 : 14
    this.ringGeo.rotateX(-Math.PI / 2) // bake flat-on-the-ground orientation
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x49e0ff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
      const mesh = new THREE.Mesh(this.ringGeo, mat)
      mesh.visible = false
      this.group.add(mesh)
      this.ripples.push({ mesh, mat, active: false, t: 0, life: 0.5, maxR: 2.4, baseOpacity: 0.5 })
    }
    scene.add(this.group)
  }

  /** Bloom one ring on the floor at the player's feet. */
  private emit(maxR: number, opacity: number) {
    const r = this.ripples.find((x) => !x.active)
    if (!r) return // pool exhausted - drop this ripple
    const f = this.deps.focus()
    const gy = this.deps.groundY(f.x, f.z)
    this.colorIdx = (this.colorIdx + 1) % this.tints.length
    r.active = true
    r.t = 0
    r.life = 0.5
    r.maxR = maxR
    r.baseOpacity = opacity
    r.mat.color.setHex(this.tints[this.colorIdx])
    r.mat.opacity = opacity
    r.mesh.visible = true
    r.mesh.position.set(f.x, gy + 0.1, f.z)
    r.mesh.scale.setScalar(0.15)
  }

  update(dt: number) {
    const grounded = this.deps.grounded()
    const speed = this.deps.speed()

    // Landing detection: airborne -> grounded fires one bigger, brighter ring.
    if (grounded && !this.wasGrounded) this.emit(4.6, 0.75)
    this.wasGrounded = grounded

    // Running ripples: while grounded and moving, emit on a speed-scaled cadence
    // (faster steps when faster). Below the threshold the timer just idles.
    if (grounded && speed > 1.4) {
      this.stepTimer -= dt
      if (this.stepTimer <= 0) {
        this.emit(2.2 + Math.min(speed, 16) * 0.06, 0.45)
        // Cadence shrinks with speed; clamp so it stays sane at extremes.
        const interval = Math.max(0.16, 0.5 - speed * 0.02)
        this.stepTimer = interval
      }
    } else {
      this.stepTimer = 0 // emit promptly the moment movement resumes
    }

    // Expand + fade every active ring, then retire it.
    for (const r of this.ripples) {
      if (!r.active) continue
      r.t += dt
      const k = r.t / r.life
      r.mesh.scale.setScalar(r.maxR * (0.15 + k * 0.85))
      r.mat.opacity = Math.max(0, r.baseOpacity * (1 - k))
      if (r.t >= r.life) { r.active = false; r.mesh.visible = false }
    }
  }

  dispose() {
    this.ringGeo.dispose()
    for (const r of this.ripples) r.mat.dispose()
  }
}
