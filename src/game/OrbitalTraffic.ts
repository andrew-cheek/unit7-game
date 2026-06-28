import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player position - traffic clusters around wherever you are on the surface. */
  focus: () => THREE.Vector3
  /** Surface height of the active off-world zone under a point. */
  groundY: (x: number, z: number) => number
}

interface Shuttle {
  /** 'depart' = rising off the pad; 'arrive' = settling down from orbit. */
  mode: 'depart' | 'arrive'
  baseX: number // launch/land pad position on the surface
  baseZ: number
  groundY: number // cached pad height
  alt: number // current altitude above the pad
  vel: number // vertical speed (units/s)
  lean: number // fixed slight tilt for this run
  yaw: number // heading, so fins don't all face the same way
  delay: number // >0 = parked/waiting before the next run, counting down
  fade: number // 0..1 visible alpha
  visible: boolean // whether this shuttle is currently flying
  plumeScale: number // current plume scale (with flicker), driven each frame
}

const DEPART_TOP = 120 // departures fade out above this altitude
const ARRIVE_TOP = 150 // arrivals begin their descent from here
const REACH = 120 // pads spawn within this radius of the player

/** Deterministic PRNG so the traffic rhythm is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Off-world orbital traffic: a pooled fleet of sleek shuttles that rise from the
 * colony surface on a bright engine plume and climb into orbit (departures), or
 * descend from high up and settle onto the pads (arrivals). Pure ambience, no
 * colliders. Shared geos/mats, Moon/Mars-gated, plume tinted per zone, disposed
 * together.
 *
 * The whole fleet is drawn with one InstancedMesh per part (nose, body, fins,
 * windows, plume) instead of one Group of 7 Meshes per shuttle, so a 7-shuttle
 * fleet costs ~5 draw calls rather than ~49. Each shuttle's world transform is
 * written via setMatrixAt every frame (single shared scratch matrix, no per-frame
 * heap allocation); inactive shuttles are collapsed with a zero-scale matrix.
 * Per-shuttle fade and the per-zone plume tint - which used to live on cloned
 * materials - are folded into per-instance colors (setColorAt) on the additive
 * windows/plume meshes: with additive blending, scaling the instance color by the
 * alpha reproduces the old `opacity = base * fade` look exactly.
 */
export class OrbitalTraffic implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private shuttles: Shuttle[] = []
  private zone: Zone = 'earth'
  private rnd = mulberry32(0x57ace5)
  // Pre-allocated scratch reused every frame (no per-frame heap allocation).
  private focus = new THREE.Vector3()
  private mat = new THREE.Matrix4()
  private quat = new THREE.Quaternion()
  private euler = new THREE.Euler()
  private pos = new THREE.Vector3()
  private scl = new THREE.Vector3()
  private partMat = new THREE.Matrix4() // shuttle-world * part-local-offset
  private color = new THREE.Color()
  private zero = new THREE.Matrix4().makeScale(0, 0, 0) // collapse inactive instances
  // Per-zone plume tints, set once; switched in update without allocating.
  private moonPlume = new THREE.Color(0x6fe9ff)
  private marsPlume = new THREE.Color(0xff7a2a)
  private winColor = new THREE.Color(0xfff2c2) // window base tint, scaled by fade

  // Instanced parts of the fleet. Hull parts share one opaque hull material;
  // windows + plume are additive glows carrying per-instance fade/tint colors.
  private nose: THREE.InstancedMesh
  private body: THREE.InstancedMesh
  private fins: THREE.InstancedMesh // 3 instances per shuttle (count * 3)
  private windows: THREE.InstancedMesh
  private plume: THREE.InstancedMesh
  // Fixed local offsets/rotations of each fin, baked into per-shuttle matrices.
  private finLocal: THREE.Matrix4[] = []

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const medium = config.tier.name === 'medium'
    // Three-step fleet size so mid-range devices sit between the trimmed mobile
    // fleet and the full desktop one rather than jumping straight to it.
    const count = low ? 4 : medium ? 6 : 7

    // Shared geometries reused across every shuttle.
    const noseGeo = this.ownG(new THREE.ConeGeometry(0.9, 2.4, 12))
    const bodyGeo = this.ownG(new THREE.CylinderGeometry(0.9, 1.1, 3.2, 12))
    const finGeo = this.ownG(new THREE.BoxGeometry(0.12, 1.2, 1.6))
    const winGeo = this.ownG(new THREE.BoxGeometry(1.3, 0.5, 1.3))
    const plumeGeo = this.ownG(new THREE.ConeGeometry(0.7, 3.0, 10))

    // Shared materials. Hull is a lit metal; windows + plume are additive glows.
    // Windows/plume use per-instance color (vertexColors path) to carry fade/tint;
    // their base opacity is folded into the instance color, so opacity stays 1.
    const hullMat = this.own(new THREE.MeshStandardMaterial({ color: 0xc9d2dd, metalness: 0.65, roughness: 0.35, emissive: 0x10161f, emissiveIntensity: 0.3 }))
    const winMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const plumeMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))

    // Bake each fin's fixed local transform (position + yaw) once.
    for (let f = 0; f < 3; f++) {
      const a = (f / 3) * Math.PI * 2
      const m = new THREE.Matrix4()
      const e = new THREE.Euler(0, a, 0)
      m.compose(
        new THREE.Vector3(Math.cos(a) * 0.95, 0.2, Math.sin(a) * 0.95),
        new THREE.Quaternion().setFromEuler(e),
        new THREE.Vector3(1, 1, 1),
      )
      this.finLocal.push(m)
    }

    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
      const m = new THREE.InstancedMesh(geo, mat, n)
      m.frustumCulled = false
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.group.add(m)
      return m
    }

    this.nose = inst(noseGeo, hullMat, count)
    this.body = inst(bodyGeo, hullMat, count)
    this.fins = inst(finGeo, hullMat, count * 3)
    this.windows = inst(winGeo, winMat, count)
    this.plume = inst(plumeGeo, plumeMat, count)
    // Allocate instance-color buffers for the additive parts (start dark/hidden).
    this.windows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
    this.plume.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
    this.windows.instanceColor.setUsage(THREE.DynamicDrawUsage)
    this.plume.instanceColor.setUsage(THREE.DynamicDrawUsage)

    for (let i = 0; i < count; i++) {
      const s: Shuttle = {
        mode: 'depart', baseX: 0, baseZ: 0, groundY: 0,
        alt: 0, vel: 0, lean: 0, yaw: 0,
        // Stagger each shuttle so the sky has steady comings-and-goings.
        delay: (i / count) * 8 + this.rnd() * 3,
        fade: 0, visible: false, plumeScale: 1,
      }
      this.shuttles.push(s)
    }

    // Start every instance collapsed; update() reveals flying shuttles.
    for (let i = 0; i < count; i++) {
      this.nose.setMatrixAt(i, this.zero)
      this.body.setMatrixAt(i, this.zero)
      this.windows.setMatrixAt(i, this.zero)
      this.plume.setMatrixAt(i, this.zero)
      for (let f = 0; f < 3; f++) this.fins.setMatrixAt(i * 3 + f, this.zero)
    }
    this.nose.instanceMatrix.needsUpdate = true
    this.body.instanceMatrix.needsUpdate = true
    this.fins.instanceMatrix.needsUpdate = true
    this.windows.instanceMatrix.needsUpdate = true
    this.plume.instanceMatrix.needsUpdate = true

    this.group.visible = false
    scene.add(this.group)
  }

  /** Begin a fresh run for a shuttle: pick a pad near the player and a mode. */
  private launch(s: Shuttle) {
    this.focus.copy(this.deps.focus())
    const r = 25 + this.rnd() * (REACH - 25)
    const a = this.rnd() * Math.PI * 2
    s.baseX = this.focus.x + Math.cos(a) * r
    s.baseZ = this.focus.z + Math.sin(a) * r
    s.groundY = this.deps.groundY(s.baseX, s.baseZ)
    s.yaw = this.rnd() * Math.PI * 2
    s.lean = (this.rnd() * 2 - 1) * 0.14
    s.mode = this.rnd() < 0.5 ? 'depart' : 'arrive'
    if (s.mode === 'depart') {
      s.alt = 0
      s.vel = 6 + this.rnd() * 3
      s.fade = 1
    } else {
      s.alt = ARRIVE_TOP
      s.vel = -22 - this.rnd() * 6
      s.fade = 0 // fades in as it nears the surface
    }
    s.visible = true
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'moon' || zone === 'mars'
  }

  update(dt: number) {
    const active = this.zone === 'moon' || this.zone === 'mars'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return

    const plumeTint = this.zone === 'mars' ? this.marsPlume : this.moonPlume

    for (let i = 0; i < this.shuttles.length; i++) {
      const s = this.shuttles[i]

      if (s.delay > 0) {
        s.delay -= dt
        if (s.delay <= 0) this.launch(s)
        else { s.visible = false; this.writeHidden(i); continue }
      }

      if (s.mode === 'depart') {
        // Accelerate up the column; plume burns bright; fade out high up.
        s.vel += 9 * dt
        s.alt += s.vel * dt
        s.fade = s.alt > DEPART_TOP - 30 ? Math.max(0, (DEPART_TOP - s.alt) / 30) : 1
        s.plumeScale = 1.1
        if (s.alt > DEPART_TOP) { this.recycle(s); this.writeHidden(i); continue }
      } else {
        // Descend from orbit, braking near the pad; fade in on approach.
        if (s.alt < 40) s.vel = Math.min(s.vel + 18 * dt, -3) // plume braking thrust
        s.alt += s.vel * dt
        s.fade = Math.min(1, (ARRIVE_TOP - s.alt) / 40)
        s.plumeScale = s.alt < 40 ? 1.3 : 0.5
        if (s.alt <= 0.5) { this.recycle(s, true); this.writeHidden(i); continue }
      }

      this.writeVisible(i, s, plumeTint)
    }

    this.nose.instanceMatrix.needsUpdate = true
    this.body.instanceMatrix.needsUpdate = true
    this.fins.instanceMatrix.needsUpdate = true
    this.windows.instanceMatrix.needsUpdate = true
    this.plume.instanceMatrix.needsUpdate = true
    this.windows.instanceColor!.needsUpdate = true
    this.plume.instanceColor!.needsUpdate = true
  }

  /** Collapse every part of shuttle `i` to zero scale so it draws nothing. */
  private writeHidden(i: number) {
    this.nose.setMatrixAt(i, this.zero)
    this.body.setMatrixAt(i, this.zero)
    this.windows.setMatrixAt(i, this.zero)
    this.plume.setMatrixAt(i, this.zero)
    for (let f = 0; f < 3; f++) this.fins.setMatrixAt(i * 3 + f, this.zero)
  }

  /** Write shuttle `i`'s world transform and fade/tint into every instanced part. */
  private writeVisible(i: number, s: Shuttle, plumeTint: THREE.Color) {
    // Shuttle root world transform: position + (lean, yaw, 0) rotation, unit scale.
    this.pos.set(s.baseX, s.groundY + s.alt, s.baseZ)
    this.euler.set(s.lean, s.yaw, 0)
    this.quat.setFromEuler(this.euler)
    this.scl.set(1, 1, 1)
    this.mat.compose(this.pos, this.quat, this.scl)

    // Hull parts: root matrix composed with each part's fixed local offset.
    this.partMat.copy(this.mat).multiply(NOSE_LOCAL)
    this.nose.setMatrixAt(i, this.partMat)
    this.partMat.copy(this.mat).multiply(BODY_LOCAL)
    this.body.setMatrixAt(i, this.partMat)
    for (let f = 0; f < 3; f++) {
      this.partMat.copy(this.mat).multiply(this.finLocal[f])
      this.fins.setMatrixAt(i * 3 + f, this.partMat)
    }

    // Windows: fixed local offset, fade folded into instance color (additive).
    this.partMat.copy(this.mat).multiply(WIN_LOCAL)
    this.windows.setMatrixAt(i, this.partMat)
    // base opacity 0.9 * fade  ->  color = winColor * (0.9 * fade)
    this.color.copy(this.winColor).multiplyScalar(0.9 * s.fade)
    this.windows.setColorAt(i, this.color)

    // Plume: local offset with the live (flickering) scale on x/z, fade in color.
    // Original flicker: scale.setScalar(plumeScale) then scale.x = scale.z =
    // 0.9 + 0.2*sin(alt*0.7). So y keeps plumeScale, x/z take the flicker value.
    const flick = 0.9 + 0.2 * Math.sin(s.alt * 0.7)
    this.partMat.copy(this.mat).multiply(this.plumeLocal(flick, s.plumeScale, flick))
    this.plume.setMatrixAt(i, this.partMat)
    // base opacity 0.85 * fade, tinted by the per-zone plume color.
    this.color.copy(plumeTint).multiplyScalar(0.85 * s.fade)
    this.plume.setColorAt(i, this.color)
  }

  // Scratch matrix for the plume's per-frame local transform (offset + flicker
  // scale). Reused every call; no per-frame allocation.
  private _plumeLocal = new THREE.Matrix4()
  private _plumePos = new THREE.Vector3(0, -1.1, 0)
  private _plumeQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0))
  private _plumeScl = new THREE.Vector3()
  private plumeLocal(sx: number, sy: number, sz: number): THREE.Matrix4 {
    this._plumeScl.set(sx, sy, sz)
    this._plumeLocal.compose(this._plumePos, this._plumeQuat, this._plumeScl)
    return this._plumeLocal
  }

  /** End a run: hide, then schedule the next launch after a brief park/delay. */
  private recycle(s: Shuttle, parked = false) {
    s.visible = false
    s.delay = (parked ? 3 : 1) + this.rnd() * 4
  }

  dispose() {
    this.nose.dispose()
    this.body.dispose()
    this.fins.dispose()
    this.windows.dispose()
    this.plume.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}

// Fixed local offsets of the hull/window parts (matching the original Group
// children's positions/rotations). Module-level constants, never mutated.
const NOSE_LOCAL = new THREE.Matrix4().makeTranslation(0, 2.8, 0)
const BODY_LOCAL = new THREE.Matrix4().makeTranslation(0, 0.9, 0)
const WIN_LOCAL = new THREE.Matrix4().makeTranslation(0, 1.9, 0)
