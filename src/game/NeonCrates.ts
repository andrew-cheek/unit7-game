import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position, for smash-contact detection. */
  focus: () => THREE.Vector3
  /** Sampled ground height at an XZ, so crates sit on the floor. */
  groundY: (x: number, z: number) => number
  /** Called on a smash: award credits + pop a floating label at the crate. */
  onSmash: (x: number, y: number, z: number, credits: number) => void
}

/**
 * Smashable neon crates: glowing street containers you burst by running through
 * them. On contact a crate vanishes, fires a pooled additive shard-burst, and
 * pays a few credits via a Game callback, then respawns after a cooldown so the
 * streets stay populated. Earth-gated; shared geo + pooled bursts, disposed together.
 */

interface Crate {
  group: THREE.Group
  x: number
  y: number // ground height the crate sits on
  z: number
  credits: number
  cooldown: number // >0 = smashed, counting down to respawn
}

interface Burst {
  points: THREE.Points
  pos: Float32Array
  vel: Float32Array
  active: boolean
  life: number
}

/** Deterministic PRNG so the crate layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const SIZE = 1.2 // crate edge length
const REACH = 1.6 // horizontal smash radius
const VBAND = 2.2 // vertical band above the ground the smash is allowed in
const RESPAWN = 12 // seconds before a smashed crate returns
const SHARDS = 14 // shards per burst
const BURST_LIFE = 0.5 // seconds
const GRAVITY = 16 // units/sec^2 pulling shards down

export class NeonCrates implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private crates: Crate[] = []
  private bursts: Burst[] = []
  private zone: Zone = 'earth'
  private t = 0

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 10 : 18
    const rnd = mulberry32(40404)
    const reach = config.world.half * 0.7

    // Shared geometry across every crate: a dark body box + a wireframe edge box.
    const bodyGeo = this.ownG(new THREE.BoxGeometry(SIZE, SIZE, SIZE))
    const edgeGeo = this.ownG(new THREE.BoxGeometry(SIZE * 1.02, SIZE * 1.02, SIZE * 1.02))
    // Shared dark body material; edge materials are per-tint (a small palette).
    const bodyMat = this.own(new THREE.MeshBasicMaterial({ color: 0x0a0e1a, fog: true }))
    const tints = [0x49e0ff, 0x9bff6a, 0xffd24a, 0xb07cff, 0xff5ad0]
    const edgeMats = tints.map((t) =>
      this.own(new THREE.MeshBasicMaterial({ color: t, wireframe: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })),
    )

    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const gy = this.deps.groundY(x, z)
      const edgeMat = edgeMats[(rnd() * edgeMats.length) | 0]

      const group = new THREE.Group()
      group.position.set(x, gy + SIZE * 0.5, z)
      group.rotation.y = rnd() * Math.PI * 2
      group.add(new THREE.Mesh(bodyGeo, bodyMat))
      group.add(new THREE.Mesh(edgeGeo, edgeMat))
      this.group.add(group)

      const credits = 8 + ((rnd() * 8) | 0) // 8..15
      this.crates.push({ group, x, y: gy, z, credits, cooldown: 0 })
    }

    // Pooled shard bursts: relocated to wherever the latest smash happens. A small
    // pool covers two crates popping close together; never allocate per smash.
    const burstColor = new THREE.Color(0xfff2c0)
    const pool = low ? 2 : 3
    for (let b = 0; b < pool; b++) {
      const pos = new Float32Array(SHARDS * 3)
      const col = new Float32Array(SHARDS * 3)
      const vel = new Float32Array(SHARDS * 3)
      for (let i = 0; i < SHARDS; i++) {
        const i3 = i * 3
        col[i3] = burstColor.r; col[i3 + 1] = burstColor.g; col[i3 + 2] = burstColor.b
      }
      const geo = this.ownG(new THREE.BufferGeometry())
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
      const mat = this.own(new THREE.PointsMaterial({ size: low ? 0.9 : 0.7, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, fog: false }))
      const points = new THREE.Points(geo, mat)
      points.visible = false
      points.frustumCulled = false // bounds change every frame as shards fly out
      this.group.add(points)
      this.bursts.push({ points, pos, vel, active: false, life: 0 })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
    if (zone !== 'earth') {
      for (const b of this.bursts) { b.active = false; b.life = 0; b.points.visible = false }
    }
  }

  /** Arm a free pooled burst at the crate and seed outward shard velocities. */
  private burst(cx: number, cy: number, cz: number) {
    const b = this.bursts.find((x) => !x.active)
    if (!b) return
    for (let i = 0; i < SHARDS; i++) {
      const i3 = i * 3
      // Random direction on a unit sphere, biased upward + outward.
      const u = Math.random() * 2 - 1
      const a = Math.random() * Math.PI * 2
      const r = Math.sqrt(1 - u * u)
      const s = 4 + Math.random() * 4
      b.pos[i3] = cx
      b.pos[i3 + 1] = cy
      b.pos[i3 + 2] = cz
      b.vel[i3] = r * Math.cos(a) * s
      b.vel[i3 + 1] = (1 + u) * s * 0.7 + 2
      b.vel[i3 + 2] = r * Math.sin(a) * s
    }
    b.active = true
    b.life = BURST_LIFE
    b.points.visible = true
    ;(b.points.material as THREE.PointsMaterial).opacity = 1
    ;(b.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt
    const f = this.deps.focus()
    const pulse = 0.85 + 0.15 * Math.sin(this.t * 3)

    for (const c of this.crates) {
      if (c.cooldown > 0) {
        c.cooldown -= dt
        if (c.cooldown <= 0) { c.group.visible = true; c.group.scale.setScalar(0.01) } // pop back in
        else continue
      }
      // Grow back to full size after a respawn pop-in.
      if (c.group.scale.x < 1) c.group.scale.setScalar(Math.min(1, c.group.scale.x + dt * 4))
      // Idle hover + neon pulse (drive opacity via the edge child only).
      c.group.position.y = c.y + SIZE * 0.5 + Math.sin(this.t * 1.6 + c.x) * 0.12
      c.group.rotation.y += dt * 0.4
      const edge = c.group.children[1] as THREE.Mesh
      ;(edge.material as THREE.MeshBasicMaterial).opacity = pulse

      // Smash on contact: close in XZ and within a vertical band at ground level.
      const dx = c.x - f.x, dz = c.z - f.z
      if (dx * dx + dz * dz < REACH * REACH && Math.abs(f.y - c.y) < VBAND) {
        this.burst(c.x, c.y + SIZE * 0.6, c.z)
        this.deps.onSmash(c.x, c.y + SIZE * 0.6, c.z, c.credits)
        c.cooldown = RESPAWN
        c.group.visible = false
      }
    }

    // Animate every live burst: fly out, fall, fade.
    for (const b of this.bursts) {
      if (!b.active) continue
      b.life -= dt
      if (b.life <= 0) { b.active = false; b.points.visible = false; continue }
      for (let i = 0; i < SHARDS; i++) {
        const i3 = i * 3
        b.vel[i3 + 1] -= GRAVITY * dt
        b.pos[i3] += b.vel[i3] * dt
        b.pos[i3 + 1] += b.vel[i3 + 1] * dt
        b.pos[i3 + 2] += b.vel[i3 + 2] * dt
      }
      ;(b.points.material as THREE.PointsMaterial).opacity = b.life / BURST_LIFE
      ;(b.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
