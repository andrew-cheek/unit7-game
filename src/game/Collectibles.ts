// Data shards — the discovery layer that retrofits a reason to explore onto the
// whole city. Hundreds of small glowing pickups scattered across the ground, up
// in the air, and high over the rooftops, plus a rising spiral above spawn that
// teaches the jetpack in the first seconds. Collecting one pays credits + XP and
// ticks the lifetime counter that drives the Scavenger/Archivist achievements.
//
// Earth's field is built up front; the Moon and Mars fields build lazily the
// first time you set foot there (their ground heights are only correct once that
// zone's surfaces are active, which happens a frame after the zone change), so
// each world gets its own themed scatter to explore.
//
// Perf: every uncollected shard is one instance of a per-zone InstancedMesh (one
// draw call for the whole field), tinted per-instance. Pickup is an O(n) squared-
// distance scan against the player over the active field only; fields are modest
// and tier-scaled, so this is cheap.

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
  color: number
  phase: number
  collected: boolean
}

interface Band {
  frac: number
  color: number
  value: number
  yMin: number
  yMax: number
}

/** A per-zone shard field: its scatter, its draw-call mesh, and its tally. */
interface Field {
  shards: Shard[]
  mesh: THREE.InstancedMesh
  found: number
}

/** Earth height bands: ground shards are easy credits, high ones reward flight. */
const EARTH_BANDS: Band[] = [
  { frac: 0.45, color: 0x27e7ff, value: 12, yMin: 1.2, yMax: 1.2 },
  { frac: 0.35, color: 0x8a5cff, value: 18, yMin: 9, yMax: 34 },
  { frac: 0.2, color: 0xffd24a, value: 30, yMin: 42, yMax: 86 },
]
// The Moon's low gravity makes the floating crystals an easy, rewarding climb.
const MOON_BANDS: Band[] = [
  { frac: 0.55, color: 0x7fe9ff, value: 16, yMin: 1.2, yMax: 1.2 },
  { frac: 0.45, color: 0xeafcff, value: 26, yMin: 7, yMax: 30 },
]
// Mars ore: warm rust + ember tones to match the red planet.
const MARS_BANDS: Band[] = [
  { frac: 0.55, color: 0xff9a3c, value: 16, yMin: 1.2, yMax: 1.2 },
  { frac: 0.45, color: 0xffd24a, value: 26, yMin: 7, yMax: 30 },
]

interface FieldSpec {
  seed: number
  count: number
  reach: number
  bands: Band[]
  spiral: boolean // earth gets the jetpack-teaching spiral over spawn
}

/** Small deterministic PRNG so each field is the same every load. */
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
  private fields: Partial<Record<Zone, Field>> = {}
  private activeZone: Zone = 'earth'
  private t = 0
  // Scratch objects so per-frame animation allocates nothing.
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private up = new THREE.Vector3(0, 1, 0)
  private s = new THREE.Vector3()
  private p = new THREE.Vector3()

  constructor(scene: THREE.Scene, opts: CollectiblesOpts) {
    this.scene = scene
    this.opts = opts
    // Unlit, bright material so shards read as emitters and the brightest tip
    // over the bloom threshold. fog:true so distant shards fade into the haze.
    this.geo = new THREE.OctahedronGeometry(0.55, 0)
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true })
    // Earth's surfaces are live at startup, so build its field now.
    this.fields.earth = this.buildField(this.earthSpec())
    this.fields.earth.mesh.visible = true
  }

  private earthSpec(): FieldSpec {
    const half = config.world.half
    return { seed: 20260623, count: Math.max(40, Math.round(170 * config.tier.densityScale)), reach: half * 0.92, bands: EARTH_BANDS, spiral: true }
  }

  private specFor(zone: Zone): FieldSpec {
    if (zone === 'moon') return { seed: 31415926, count: Math.max(24, Math.round(80 * config.tier.densityScale)), reach: 130, bands: MOON_BANDS, spiral: false }
    if (zone === 'mars') return { seed: 27182818, count: Math.max(24, Math.round(80 * config.tier.densityScale)), reach: 130, bands: MARS_BANDS, spiral: false }
    return this.earthSpec()
  }

  /** Seeded scatter for a zone: banded heights (+ a jetpack spiral on Earth). */
  private buildField(spec: FieldSpec): Field {
    const rnd = mulberry32(spec.seed)
    const shards: Shard[] = []
    for (let i = 0; i < spec.count; i++) {
      const x = (rnd() * 2 - 1) * spec.reach
      const z = (rnd() * 2 - 1) * spec.reach
      const r = rnd()
      let acc = 0
      let band = spec.bands[0]
      for (const b of spec.bands) {
        acc += b.frac
        if (r <= acc) { band = b; break }
      }
      const gy = this.opts.groundY(x, z)
      const y = gy + band.yMin + rnd() * (band.yMax - band.yMin)
      shards.push({ x, y, baseY: y, z, value: band.value, color: band.color, phase: rnd() * 6.28, collected: false })
    }
    if (spec.spiral) {
      // A rising spiral above spawn: hold jetpack to climb the trail. Values ramp
      // with height so the climb pays off and the verb is learned immediately.
      const gy0 = this.opts.groundY(0, 8)
      for (let i = 0; i < 12; i++) {
        const a = i * 1.1
        const rad = 5 + i * 0.35
        const y = gy0 + 4 + i * 5.6
        shards.push({ x: Math.cos(a) * rad, y, baseY: y, z: 8 + Math.sin(a) * rad, value: 12 + i * 2, color: 0x27e7ff, phase: a, collected: false })
      }
    }
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, shards.length)
    mesh.frustumCulled = false // the field spans the zone; cull per-shard via fog instead
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.visible = false
    const color = new THREE.Color()
    for (let i = 0; i < shards.length; i++) {
      const sh = shards[i]
      this.m.compose(this.p.set(sh.x, sh.y, sh.z), this.q.identity(), this.s.set(1, 1, 1))
      mesh.setMatrixAt(i, this.m)
      mesh.setColorAt(i, color.setHex(sh.color))
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    this.scene.add(mesh)
    return { shards, mesh, found: 0 }
  }

  setZone(zone: Zone) {
    this.activeZone = zone
    for (const z of Object.keys(this.fields) as Zone[]) {
      const f = this.fields[z]
      if (f) f.mesh.visible = z === zone
    }
    // Planet fields build lazily in update() once their surfaces are live.
  }

  /** Found / total for the active zone (drives the HUD counter). */
  counts(): { found: number; total: number } {
    const f = this.fields[this.activeZone]
    return f ? { found: f.found, total: f.shards.length } : { found: 0, total: 0 }
  }

  /** Visit uncollected shards within `range` of (x,z) for the radar (capped). */
  forEachNearby(x: number, z: number, range: number, cap: number, cb: (x: number, z: number) => void) {
    const f = this.fields[this.activeZone]
    if (!f) return
    const r2 = range * range
    let n = 0
    for (const sh of f.shards) {
      if (sh.collected) continue
      const dx = sh.x - x
      const dz = sh.z - z
      if (dx * dx + dz * dz > r2) continue
      cb(sh.x, sh.z)
      if (++n >= cap) return
    }
  }

  update(dt: number) {
    // Build (and show) the active planet field on first arrival - by now its
    // ground surfaces are active, so the scatter sits on the real terrain.
    if (!this.fields[this.activeZone]) {
      const f = this.buildField(this.specFor(this.activeZone))
      f.mesh.visible = true
      this.fields[this.activeZone] = f
    }
    const field = this.fields[this.activeZone]!
    this.t += dt
    const player = this.opts.getPlayer()
    const pickR2 = 3 * 3
    let dirty = false
    const shards = field.shards
    for (let i = 0; i < shards.length; i++) {
      const sh = shards[i]
      if (sh.collected) continue
      // Pickup: simple 3D-ish gate (use full distance so air shards need flight).
      const dx = sh.x - player.x
      const dy = sh.baseY - player.y
      const dz = sh.z - player.z
      if (dx * dx + dz * dz < pickR2 && dy * dy < 9) {
        sh.collected = true
        field.found++
        this.m.compose(this.p.set(0, -9999, 0), this.q.identity(), this.s.set(0, 0, 0))
        field.mesh.setMatrixAt(i, this.m)
        dirty = true
        this.opts.onCollect(sh.value, sh.x, sh.baseY, sh.z)
        continue
      }
      // Spin + bob. Cheap per-instance compose; the field is tier-scaled.
      sh.y = sh.baseY + Math.sin(this.t * 2 + sh.phase) * 0.35
      this.q.setFromAxisAngle(this.up, this.t * 1.6 + sh.phase)
      this.m.compose(this.p.set(sh.x, sh.y, sh.z), this.q, this.s.set(1, 1, 1))
      field.mesh.setMatrixAt(i, this.m)
      dirty = true
    }
    if (dirty) field.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    for (const z of Object.keys(this.fields) as Zone[]) {
      const f = this.fields[z]
      if (!f) continue
      this.scene.remove(f.mesh)
      f.mesh.dispose()
    }
    this.geo.dispose()
    this.mat.dispose()
  }
}
