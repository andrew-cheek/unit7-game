// Data shards — the discovery layer that retrofits a reason to explore onto the
// whole city. Hundreds of small glowing pickups scattered across the ground, up
// in the air, and high over the rooftops, plus a rising spiral above spawn that
// teaches the jetpack in the first seconds. Collecting one pays credits + XP and
// ticks the lifetime counter that drives the Scavenger/Archivist achievements.
//
// Perf: every uncollected shard is one instance of a single InstancedMesh (one
// draw call for the whole field), tinted per-instance by height band. Pickup is
// an O(n) squared-distance scan against the player; the field is modest and
// tier-scaled, so this is cheap. Earth-only for now (ground heights are sampled
// at construction, when the earth surfaces are active); off-world fields can
// follow with lazy per-zone building.

import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Shard {
  x: number
  y: number // animated centre height
  baseY: number
  z: number
  value: number
  phase: number
  collected: boolean
}

/** Height bands: ground shards are easy credits, high ones reward flight. */
const BANDS = [
  { name: 'ground', frac: 0.45, color: 0x27e7ff, value: 12, yMin: 1.2, yMax: 1.2 },
  { name: 'mid', frac: 0.35, color: 0x8a5cff, value: 18, yMin: 9, yMax: 34 },
  { name: 'high', frac: 0.2, color: 0xffd24a, value: 30, yMin: 42, yMax: 86 },
] as const

/** Small deterministic PRNG so the field is the same every load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface CollectiblesOpts {
  groundY: (x: number, z: number) => number
  getZone: () => Zone
  getPlayer: () => THREE.Vector3
  /** Awards the pickup (credits/XP/FX live in Game); pos is where it popped. */
  onCollect: (value: number, x: number, y: number, z: number) => void
}

export class Collectibles implements GameSystem {
  private scene: THREE.Scene
  private opts: CollectiblesOpts
  private geo: THREE.OctahedronGeometry
  private mat: THREE.MeshBasicMaterial
  private mesh: THREE.InstancedMesh
  private shards: Shard[] = []
  private found = 0
  private t = 0
  private active = true // visible only on earth
  // Scratch objects so per-frame animation allocates nothing.
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private up = new THREE.Vector3(0, 1, 0)
  private s = new THREE.Vector3()
  private p = new THREE.Vector3()

  constructor(scene: THREE.Scene, opts: CollectiblesOpts) {
    this.scene = scene
    this.opts = opts
    this.buildShards()
    this.geo = new THREE.OctahedronGeometry(0.55, 0)
    // Unlit, bright material so shards read as emitters and the brightest (gold,
    // high-altitude) tip over the bloom threshold. fog:true so distant shards
    // fade into the city haze instead of speckling the whole map.
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true })
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, this.shards.length)
    this.mesh.frustumCulled = false // the field spans the city; cull per-shard via fog instead
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    const color = new THREE.Color()
    for (let i = 0; i < this.shards.length; i++) {
      const sh = this.shards[i]
      this.m.compose(this.p.set(sh.x, sh.y, sh.z), this.q.identity(), this.s.set(1, 1, 1))
      this.mesh.setMatrixAt(i, this.m)
      this.mesh.setColorAt(i, color.setHex(this.colorFor(sh.value)))
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    scene.add(this.mesh)
  }

  private colorFor(value: number): number {
    return BANDS.find((b) => b.value === value)?.color ?? 0x27e7ff
  }

  /** Seeded scatter across the city: banded heights + a jetpack-teaching spiral. */
  private buildShards() {
    const rnd = mulberry32(20260623)
    const half = config.world.half
    const reach = half * 0.92
    const total = Math.max(40, Math.round(170 * config.tier.densityScale))
    for (let i = 0; i < total; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      // Pick a height band by its fraction.
      const r = rnd()
      let acc = 0
      let band: (typeof BANDS)[number] = BANDS[0]
      for (const b of BANDS) {
        acc += b.frac
        if (r <= acc) { band = b; break }
      }
      const gy = this.opts.groundY(x, z)
      const y = gy + band.yMin + rnd() * (band.yMax - band.yMin)
      this.shards.push({ x, y, baseY: y, z, value: band.value, phase: rnd() * 6.28, collected: false })
    }
    // A rising spiral above spawn: hold jetpack to climb the trail. Values ramp
    // with height so the climb pays off and the verb is learned immediately.
    const gy0 = this.opts.groundY(0, 8)
    const turns = 12
    for (let i = 0; i < turns; i++) {
      const a = i * 1.1
      const rad = 5 + i * 0.35
      const y = gy0 + 4 + i * 5.6
      this.shards.push({ x: Math.cos(a) * rad, y, baseY: y, z: 8 + Math.sin(a) * rad, value: 12 + i * 2, phase: a, collected: false })
    }
  }

  setZone(zone: Zone) {
    this.active = zone === 'earth'
    this.mesh.visible = this.active
  }

  /** Found / total for the active zone (drives the HUD counter). */
  counts(): { found: number; total: number } {
    return this.active ? { found: this.found, total: this.shards.length } : { found: 0, total: 0 }
  }

  /** Visit uncollected shards within `range` of (x,z) for the radar (capped). */
  forEachNearby(x: number, z: number, range: number, cap: number, cb: (x: number, z: number) => void) {
    if (!this.active) return
    const r2 = range * range
    let n = 0
    for (const sh of this.shards) {
      if (sh.collected) continue
      const dx = sh.x - x
      const dz = sh.z - z
      if (dx * dx + dz * dz > r2) continue
      cb(sh.x, sh.z)
      if (++n >= cap) return
    }
  }

  update(dt: number) {
    if (!this.active) return
    this.t += dt
    const player = this.opts.getPlayer()
    const pickR2 = 3 * 3
    let dirty = false
    for (let i = 0; i < this.shards.length; i++) {
      const sh = this.shards[i]
      if (sh.collected) continue
      // Pickup: simple 3D-ish gate (use full distance so air shards need flight).
      const dx = sh.x - player.x
      const dy = sh.baseY - player.y
      const dz = sh.z - player.z
      if (dx * dx + dz * dz < pickR2 && dy * dy < 9) {
        sh.collected = true
        this.found++
        this.m.compose(this.p.set(0, -9999, 0), this.q.identity(), this.s.set(0, 0, 0))
        this.mesh.setMatrixAt(i, this.m)
        dirty = true
        this.opts.onCollect(sh.value, sh.x, sh.baseY, sh.z)
        continue
      }
      // Spin + bob. Cheap per-instance compose; the field is tier-scaled.
      sh.y = sh.baseY + Math.sin(this.t * 2 + sh.phase) * 0.35
      this.q.setFromAxisAngle(this.up, this.t * 1.6 + sh.phase)
      this.m.compose(this.p.set(sh.x, sh.y, sh.z), this.q, this.s.set(1, 1, 1))
      this.mesh.setMatrixAt(i, this.m)
      dirty = true
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.scene.remove(this.mesh)
    this.mesh.dispose()
    this.geo.dispose()
    this.mat.dispose()
  }
}
