import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so the rain field always surrounds wherever you are. */
  focus: () => THREE.Vector3
}

const HALF = 45 // half-extent of the rain box around the player (XZ)
const WRAP = 45 // distance from player at which a drop wraps to the far side
const Y_LO = 1 // floor of the band (above the player's feet)
const Y_HI = 38 // ceiling of the band

/**
 * Intermittent neon weather: occasional showers of thin glowing rain streaks that
 * fall through the air around the player, fade in, last a while, then fade out, with
 * calm dry spells between. Earth only. One additive THREE.Points draw call that wraps
 * to stay centred on you. Pure atmosphere - no colliders, no gameplay. Disposed together.
 */
export class NeonRain implements GameSystem {
  private points: THREE.Points
  private geo: THREE.BufferGeometry
  private mat: THREE.PointsMaterial
  private pos: Float32Array
  private n: number
  private low: boolean
  private zone: Zone = 'earth'
  // Scratch centre, reused each frame so we never allocate in update().
  private center = new THREE.Vector3()

  // Intermittent weather state machine.
  private wetness = 0 // 0 (dry) .. 1 (full shower)
  private phase: 'dry' | 'up' | 'rain' | 'down' = 'dry'
  private timer: number

  constructor(scene: THREE.Scene, private deps: Deps) {
    this.low = config.tier.name === 'low'
    // Medium (iPad-class) sits ~65% of high, matching the tier's reduced fxScale.
    this.n = this.low ? 110 : (config.tier.name === 'medium' ? 170 : 260)
    this.timer = 20 + Math.random() * 25 // initial dry spell

    this.pos = new Float32Array(this.n * 3)
    const f = this.deps.focus()
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3
      this.pos[i3] = f.x + (Math.random() * 2 - 1) * HALF
      this.pos[i3 + 1] = Y_LO + Math.random() * (Y_HI - Y_LO)
      this.pos[i3 + 2] = f.z + (Math.random() * 2 - 1) * HALF
    }

    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))

    this.mat = new THREE.PointsMaterial({
      size: this.low ? 0.7 : 0.5,
      color: 0x7fd8ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
      sizeAttenuation: true,
    })

    this.points = new THREE.Points(this.geo, this.mat)
    // Bounds shift every frame as the field wraps around the player; skip the
    // frustum cull so drops never pop out when the box centre moves.
    this.points.frustumCulled = false
    this.points.visible = false
    scene.add(this.points)
  }

  setZone(zone: Zone) {
    this.zone = zone
    if (zone !== 'earth') this.points.visible = false
  }

  update(dt: number) {
    if (this.zone !== 'earth') {
      if (this.points.visible) this.points.visible = false
      return
    }

    // Advance the weather state machine.
    this.timer -= dt
    switch (this.phase) {
      case 'dry':
        this.wetness += (0 - this.wetness) * Math.min(1, dt * 1.5)
        if (this.timer <= 0) { this.phase = 'up' }
        break
      case 'up':
        this.wetness += (1 - this.wetness) * Math.min(1, dt * 0.4)
        if (this.wetness > 0.97) { this.wetness = 1; this.phase = 'rain'; this.timer = 15 + Math.random() * 15 }
        break
      case 'rain':
        if (this.timer <= 0) { this.phase = 'down' }
        break
      case 'down':
        this.wetness += (0 - this.wetness) * Math.min(1, dt * 0.4)
        if (this.wetness < 0.03) { this.wetness = 0; this.phase = 'dry'; this.timer = 20 + Math.random() * 25 }
        break
    }

    const f = this.deps.focus()
    this.center.copy(f)
    const span = WRAP * 2
    const ySpan = Y_HI - Y_LO
    const yLo = this.center.y + Y_LO
    const yHi = this.center.y + Y_HI
    // Drops fall faster during a heavier shower.
    const fall = (18 + 10 * this.wetness) * dt

    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3
      // Fall.
      this.pos[i3 + 1] -= fall

      // Wrap horizontally to keep the field centred on the player.
      const dx = this.pos[i3] - this.center.x
      if (dx > WRAP) this.pos[i3] -= span
      else if (dx < -WRAP) this.pos[i3] += span
      const dz = this.pos[i3 + 2] - this.center.z
      if (dz > WRAP) this.pos[i3 + 2] -= span
      else if (dz < -WRAP) this.pos[i3 + 2] += span

      // Recycle drops that fall below the floor to the top of the band.
      const y = this.pos[i3 + 1]
      if (y < yLo) this.pos[i3 + 1] = y + ySpan
      else if (y > yHi) this.pos[i3 + 1] = y - ySpan
    }

    // Opacity follows wetness, kept subtle.
    this.mat.opacity = this.wetness * 0.5
    this.points.visible = this.wetness > 0.02

    ;(this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  dispose() {
    this.geo.dispose()
    this.mat.dispose()
  }
}
