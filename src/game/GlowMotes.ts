import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'

interface Deps {
  /** Player focus, so the mote field always surrounds wherever you are. */
  focus: () => THREE.Vector3
}

/** Deterministic PRNG so the field is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const HALF = 60 // half-extent of the spawn box around the player (XZ)
const WRAP = 70 // distance from player at which a mote wraps to the far side
const Y_LO = 2 // floor of the vertical band
const Y_HI = 40 // ceiling of the vertical band

/**
 * Ambient bio-luminescent motes: a cloud of tiny drifting fireflies that softly
 * float through the air around the player in every zone. Gentle upward/sideways
 * drift with twinkling opacity, and the field slowly wraps to stay centred on you
 * as you move. Pure atmosphere - one additive THREE.Points draw call, no colliders,
 * no gameplay. Disposed together.
 */
export class GlowMotes implements GameSystem {
  private points: THREE.Points
  private geo: THREE.BufferGeometry
  private mat: THREE.PointsMaterial
  private pos: Float32Array
  private vel: Float32Array
  private phase: Float32Array
  private n: number
  private t = 0
  // Scratch centre, reused each frame so we never allocate in update().
  private center = new THREE.Vector3()

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    this.n = low ? 90 : 220
    const rnd = mulberry32(740011)

    this.pos = new Float32Array(this.n * 3)
    this.vel = new Float32Array(this.n * 3)
    this.phase = new Float32Array(this.n)
    const colors = new Float32Array(this.n * 3)

    const f = this.deps.focus()
    const tints = [
      [0.30, 0.88, 1.00], // cyan
      [0.61, 1.00, 0.42], // green
      [1.00, 0.84, 0.29], // amber
      [0.69, 0.49, 1.00], // violet
    ]
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3
      this.pos[i3] = f.x + (rnd() * 2 - 1) * HALF
      this.pos[i3 + 1] = Y_LO + rnd() * (Y_HI - Y_LO)
      this.pos[i3 + 2] = f.z + (rnd() * 2 - 1) * HALF
      // Gentle, mostly-upward drift with a little lateral wander (units/sec).
      this.vel[i3] = (rnd() * 2 - 1) * 0.7
      this.vel[i3 + 1] = 0.25 + rnd() * 0.6
      this.vel[i3 + 2] = (rnd() * 2 - 1) * 0.7
      this.phase[i] = rnd() * 6.28
      const t = tints[(rnd() * tints.length) | 0]
      colors[i3] = t[0]; colors[i3 + 1] = t[1]; colors[i3 + 2] = t[2]
    }

    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    this.mat = new THREE.PointsMaterial({
      size: low ? 0.9 : 0.7,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
      sizeAttenuation: true,
    })

    this.points = new THREE.Points(this.geo, this.mat)
    // Bounds shift every frame as the field wraps around the player; skip the
    // frustum cull so motes never pop out when the box centre moves.
    this.points.frustumCulled = false
    scene.add(this.points)
  }

  update(dt: number) {
    this.t += dt
    const f = this.deps.focus()
    this.center.copy(f)
    const span = WRAP * 2
    const ySpan = Y_HI - Y_LO

    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3
      // Drift.
      this.pos[i3] += this.vel[i3] * dt
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt

      // Wrap horizontally to keep the field centred on the player.
      let dx = this.pos[i3] - this.center.x
      if (dx > WRAP) this.pos[i3] -= span
      else if (dx < -WRAP) this.pos[i3] += span
      let dz = this.pos[i3 + 2] - this.center.z
      if (dz > WRAP) this.pos[i3 + 2] -= span
      else if (dz < -WRAP) this.pos[i3 + 2] += span

      // Wrap vertically within the band (motes mostly rise, so recycle at the top).
      const y = this.pos[i3 + 1]
      if (y > Y_HI) this.pos[i3 + 1] = y - ySpan
      else if (y < Y_LO) this.pos[i3 + 1] = y + ySpan
    }

    // Twinkle: animate global opacity and a subtle size pulse. Per-mote sparkle
    // comes from the additive blend over the moving field.
    const tw = 0.5 + 0.5 * Math.sin(this.t * 1.7)
    this.mat.opacity = 0.55 + tw * 0.35
    this.mat.size = (config.tier.name === 'low' ? 0.9 : 0.7) * (1 + 0.18 * Math.sin(this.t * 2.3))

    ;(this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  dispose() {
    this.geo.dispose()
    this.mat.dispose()
  }
}
