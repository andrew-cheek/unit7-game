import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so bursts always go off in the sky around wherever you are. */
  focus: () => THREE.Vector3
  /** Day/night factor: ~1 = full day, ~0 = night. Fireworks fire only at night. */
  dayFactor: () => number
}

/**
 * Night-only Earth spectacle: periodic firework bursts that pop high over the
 * neon city after dark. Each burst is a pooled additive THREE.Points cloud whose
 * sparks fly out on a sphere, fall under a little gravity, and fade over ~1.6s.
 * Pure atmosphere - no colliders, no gameplay; pooled and disposed together.
 */

interface Burst {
  points: THREE.Points
  geo: THREE.BufferGeometry
  mat: THREE.PointsMaterial
  pos: Float32Array // per-spark position
  vel: Float32Array // per-spark velocity
  active: boolean
  life: number // seconds remaining
  maxLife: number
}

const NIGHT_AT = 0.35 // dayFactor below this counts as night
const GRAVITY = 9 // units/sec^2 pulling sparks down
const MAX_LIFE = 1.6 // seconds per burst

export class NightFireworks implements GameSystem {
  private group = new THREE.Group()
  private bursts: Burst[] = []
  private zone: Zone = 'earth'
  private timer = 1.5 // countdown to the next launch
  private sparks: number
  // Scratch colour reused each launch so we never allocate per burst.
  private scratchCol = new THREE.Color()

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const pool = low ? 2 : 4
    this.sparks = low ? 30 : 60

    for (let i = 0; i < pool; i++) {
      const pos = new Float32Array(this.sparks * 3)
      const col = new Float32Array(this.sparks * 3)
      const vel = new Float32Array(this.sparks * 3)

      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3))

      const mat = new THREE.PointsMaterial({
        size: low ? 1.6 : 1.3,
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
        fog: false,
      })

      const points = new THREE.Points(geo, mat)
      points.visible = false
      // Bounds change every frame as sparks fly out; skip culling so a burst
      // never pops out when its centre drifts.
      points.frustumCulled = false
      this.group.add(points)

      this.bursts.push({ points, geo, mat, pos, vel, active: false, life: 0, maxLife: MAX_LIFE })
    }

    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
    if (zone !== 'earth') this.hideAll()
  }

  private hideAll() {
    for (const b of this.bursts) {
      b.active = false
      b.life = 0
      b.points.visible = false
    }
  }

  /** Neon palette, one colour per launch. */
  private pickColor(out: THREE.Color) {
    const palette = [
      0x3fd8ff, // cyan
      0xff4fd8, // magenta
      0x66ff7a, // green
      0xffcc3f, // gold
      0xb07cff, // violet
      0xffffff, // white
    ]
    out.set(palette[(Math.random() * palette.length) | 0])
  }

  /** Arm a free burst: place it in the sky around the player and seed sparks. */
  private launch() {
    const b = this.bursts.find((x) => !x.active)
    if (!b) return
    const f = this.deps.focus()

    // Sky point: a random direction in XZ at 60..140 units, y 55..95.
    const ang = Math.random() * Math.PI * 2
    const dist = 60 + Math.random() * 80
    const cx = f.x + Math.cos(ang) * dist
    const cy = 55 + Math.random() * 40
    const cz = f.z + Math.sin(ang) * dist

    const color = this.scratchCol
    this.pickColor(color)
    const col = this.geoColor(b)

    const speed = 11 + Math.random() * 8
    for (let i = 0; i < this.sparks; i++) {
      const i3 = i * 3
      // Random point on a unit sphere, scaled by a per-spark speed.
      const u = Math.random() * 2 - 1
      const t = Math.random() * Math.PI * 2
      const r = Math.sqrt(1 - u * u)
      const dx = r * Math.cos(t)
      const dy = u
      const dz = r * Math.sin(t)
      const s = speed * (0.5 + Math.random() * 0.7)

      b.pos[i3] = cx
      b.pos[i3 + 1] = cy
      b.pos[i3 + 2] = cz
      b.vel[i3] = dx * s
      b.vel[i3 + 1] = dy * s
      b.vel[i3 + 2] = dz * s

      // Slight per-spark colour variation around the launch colour.
      const j = 0.75 + Math.random() * 0.25
      col[i3] = color.r * j
      col[i3 + 1] = color.g * j
      col[i3 + 2] = color.b * j
    }

    b.active = true
    b.life = b.maxLife
    b.mat.opacity = 1
    b.points.visible = true
    ;(b.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(b.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true
  }

  private geoColor(b: Burst): Float32Array {
    return (b.geo.attributes.color as THREE.BufferAttribute).array as Float32Array
  }

  update(dt: number) {
    // Drive group visibility from the zone each frame so it's correct at startup
    // too (setZone only fires on a zone *change*, and you begin on Earth).
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    const night = this.deps.dayFactor() < NIGHT_AT

    // Launch scheduling: only at night, and only when a burst is free.
    if (night) {
      this.timer -= dt
      if (this.timer <= 0) {
        this.launch()
        this.timer = 1.2 + Math.random() * 2.3
      }
    }

    // Animate every in-flight burst to completion regardless of day/night, so a
    // burst that began at dusk still finishes cleanly.
    for (const b of this.bursts) {
      if (!b.active) continue
      b.life -= dt
      if (b.life <= 0) {
        b.active = false
        b.points.visible = false
        continue
      }

      for (let i = 0; i < this.sparks; i++) {
        const i3 = i * 3
        b.vel[i3 + 1] -= GRAVITY * dt
        b.pos[i3] += b.vel[i3] * dt
        b.pos[i3 + 1] += b.vel[i3 + 1] * dt
        b.pos[i3 + 2] += b.vel[i3 + 2] * dt
      }

      // Fade out over the burst lifetime.
      b.mat.opacity = b.life / b.maxLife
      ;(b.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    }
  }

  dispose() {
    for (const b of this.bursts) {
      b.geo.dispose()
      b.mat.dispose()
    }
  }
}
