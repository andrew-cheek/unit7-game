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
  group: THREE.Group
  plume: THREE.Mesh
  windows: THREE.Mesh
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
 */
export class OrbitalTraffic implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private shuttles: Shuttle[] = []
  private zone: Zone = 'earth'
  private plumeMat: THREE.MeshBasicMaterial
  private rnd = mulberry32(0x57ace5)
  // Pre-allocated scratch reused every frame (no per-frame heap allocation).
  private focus = new THREE.Vector3()
  // Per-zone plume tints, set once; switched in update without allocating.
  private moonPlume = new THREE.Color(0x6fe9ff)
  private marsPlume = new THREE.Color(0xff7a2a)

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const count = low ? 4 : 7

    // Shared geometries reused across every shuttle.
    const noseGeo = this.ownG(new THREE.ConeGeometry(0.9, 2.4, 12))
    const bodyGeo = this.ownG(new THREE.CylinderGeometry(0.9, 1.1, 3.2, 12))
    const finGeo = this.ownG(new THREE.BoxGeometry(0.12, 1.2, 1.6))
    const winGeo = this.ownG(new THREE.BoxGeometry(1.3, 0.5, 1.3))
    const plumeGeo = this.ownG(new THREE.ConeGeometry(0.7, 3.0, 10))

    // Shared materials. Hull is a lit metal; windows + plume are additive glows.
    const hullMat = this.own(new THREE.MeshStandardMaterial({ color: 0xc9d2dd, metalness: 0.65, roughness: 0.35, emissive: 0x10161f, emissiveIntensity: 0.3 }))
    const winMat = this.own(new THREE.MeshBasicMaterial({ color: 0xfff2c2, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.plumeMat = this.own(new THREE.MeshBasicMaterial({ color: 0x6fe9ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))

    for (let i = 0; i < count; i++) {
      const group = new THREE.Group()
      // Tapered fuselage: cone nose over a cylinder body.
      const nose = new THREE.Mesh(noseGeo, hullMat); nose.position.y = 2.8; group.add(nose)
      const body = new THREE.Mesh(bodyGeo, hullMat); body.position.y = 0.9; group.add(body)
      // Small wings/fins around the base.
      for (let f = 0; f < 3; f++) {
        const fin = new THREE.Mesh(finGeo, hullMat)
        const a = (f / 3) * Math.PI * 2
        fin.position.set(Math.cos(a) * 0.95, 0.2, Math.sin(a) * 0.95)
        fin.rotation.y = a
        group.add(fin)
      }
      // Lit cockpit window band high on the body.
      const windows = new THREE.Mesh(winGeo, winMat); windows.position.y = 1.9; group.add(windows)
      // Bright additive engine plume cone at the tail, pointing down.
      const plume = new THREE.Mesh(plumeGeo, this.plumeMat); plume.position.y = -1.1; plume.rotation.x = Math.PI; group.add(plume)

      group.visible = false
      this.group.add(group)
      const s: Shuttle = {
        group, plume, windows,
        mode: 'depart', baseX: 0, baseZ: 0, groundY: 0,
        alt: 0, vel: 0, lean: 0, yaw: 0,
        // Stagger each shuttle so the sky has steady comings-and-goings.
        delay: (i / count) * 8 + this.rnd() * 3,
        fade: 0,
      }
      this.shuttles.push(s)
    }

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
    s.group.visible = true
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'moon' || zone === 'mars'
  }

  update(dt: number) {
    const active = this.zone === 'moon' || this.zone === 'mars'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return

    // Theme the (shared) plume per active zone - one color set, no per-frame alloc.
    this.plumeMat.color.copy(this.zone === 'mars' ? this.marsPlume : this.moonPlume)

    for (const s of this.shuttles) {
      if (s.delay > 0) {
        s.delay -= dt
        if (s.delay <= 0) this.launch(s)
        else { s.group.visible = false; continue }
      }

      const winMat = s.windows.material as THREE.MeshBasicMaterial
      const plumeMat = s.plume.material as THREE.MeshBasicMaterial

      if (s.mode === 'depart') {
        // Accelerate up the column; plume burns bright; fade out high up.
        s.vel += 9 * dt
        s.alt += s.vel * dt
        s.fade = s.alt > DEPART_TOP - 30 ? Math.max(0, (DEPART_TOP - s.alt) / 30) : 1
        s.plume.scale.setScalar(1.1)
        if (s.alt > DEPART_TOP) { this.recycle(s); continue }
      } else {
        // Descend from orbit, braking near the pad; fade in on approach.
        if (s.alt < 40) s.vel = Math.min(s.vel + 18 * dt, -3) // plume braking thrust
        s.alt += s.vel * dt
        s.fade = Math.min(1, (ARRIVE_TOP - s.alt) / 40)
        s.plume.scale.setScalar(s.alt < 40 ? 1.3 : 0.5)
        if (s.alt <= 0.5) { this.recycle(s, true); continue }
      }

      s.group.position.set(s.baseX, s.groundY + s.alt, s.baseZ)
      s.group.rotation.set(s.lean, s.yaw, 0)
      winMat.opacity = 0.9 * s.fade
      plumeMat.opacity = 0.85 * s.fade
      // Cheap plume flicker keeps the exhaust alive.
      s.plume.scale.x = s.plume.scale.z = 0.9 + 0.2 * Math.sin(s.alt * 0.7)
    }
  }

  /** End a run: hide, then schedule the next launch after a brief park/delay. */
  private recycle(s: Shuttle, parked = false) {
    s.group.visible = false
    s.delay = (parked ? 3 : 1) + this.rnd() * 4
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
