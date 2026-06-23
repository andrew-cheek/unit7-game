// CityLife — persistent, distributed sci-fi activity for the OUTER city, so the
// world stays interesting once you leave the spawn square. The ambient events
// (WorldEvents) fire near the player and expire; this is the opposite: standing
// fixtures spread across the mid/outer districts that are always moving, so
// wherever you roam there is traffic overhead and a powered-up skyline.
//
// Three layers, all cheap and tier-scaled:
//  - Sky lanes: streams of glowing hover-pods crossing the city at mid altitude,
//    drawn as ONE InstancedMesh (a single draw call for all the traffic).
//  - Freight blimps: a couple of big airships circling slowly at high altitude,
//    readable moving silhouettes on the skyline.
//  - Set-pieces: fusion reactors (counter-rotating rings + energy beam) and a
//    construction crane site, placed out in the districts as lit destinations.
//
// Earth-only (hidden off-world). No per-frame allocation: the per-pod matrix
// update reuses scratch objects. All geometry/materials are disposed.

import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

export interface CityLifeOpts {
  /** Ground height at (x, z) so set-pieces sit on the terrain. */
  groundY: (x: number, z: number) => number
}

interface Lane {
  from: THREE.Vector3
  to: THREE.Vector3
  quat: THREE.Quaternion
}
interface Blimp {
  group: THREE.Group
  cx: number
  cz: number
  r: number
  ang: number
  spd: number
  y: number
  belly: THREE.MeshBasicMaterial
}
interface Reactor {
  rings: { mesh: THREE.Mesh; axis: 'x' | 'y' | 'z'; spd: number }[]
  core: THREE.MeshStandardMaterial
  beam: THREE.MeshBasicMaterial
}

export class CityLife implements GameSystem {
  private scene: THREE.Scene
  private group = new THREE.Group()
  private zone: Zone = 'earth'

  private pods: THREE.InstancedMesh | null = null
  private lanes: Lane[] = []
  private podLane: number[] = []
  private podT: number[] = []
  private podSpeed: number[] = []

  private blimps: Blimp[] = []
  private reactors: Reactor[] = []
  private crane: { jib: THREE.Group; hook: THREE.Group; sparks: THREE.MeshStandardMaterial[] } | null = null
  private streetDrones: { g: THREE.Group; axis: 'x' | 'z'; off: number; pos: number; dir: number; spd: number; bob: number }[] = []
  private gates: THREE.Vector3[] = []
  private racer: { g: THREE.Group; idx: number; speed: number } | null = null
  private creatures: { g: THREE.Group; segs: THREE.Mesh[]; cx: number; cz: number; r: number; ang: number; spd: number; y: number; phase: number }[] = []
  private holo: THREE.Mesh | null = null

  // scratch (no per-frame allocation)
  private m = new THREE.Matrix4()
  private v = new THREE.Vector3()
  private one = new THREE.Vector3(1, 1, 1)
  private t = 0

  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []

  constructor(scene: THREE.Scene, opts: CityLifeOpts) {
    this.scene = scene
    this.buildSkyLanes()
    this.buildBlimps()
    this.buildSetPieces(opts)
    this.buildStreetDrones()
    this.buildRaceCourse(opts)
    this.buildCreatures()
    this.buildMarket(opts)
    this.scene.add(this.group)
  }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }
  private get fx(): number { return config.tier.fxScale }

  // --- sky traffic ----------------------------------------------------------

  private buildSkyLanes() {
    const half = config.world.half
    const laneN = this.fx >= 0.9 ? 6 : this.fx >= 0.6 ? 4 : 2
    const perLane = this.fx >= 0.9 ? 8 : this.fx >= 0.6 ? 6 : 4
    const fwd = new THREE.Vector3(0, 0, 1) // pod model faces +Z
    const tints = [0x27e7ff, 0xff2bd0, 0x9bff4d, 0xff8a1e, 0x8a5cff, 0x7fd7ff]
    for (let i = 0; i < laneN; i++) {
      const axisX = i % 2 === 0
      // spread lanes across the outer city, skipping the central square
      const off = (((i * 2 + 1) / (laneN * 2)) - 0.5) * 2 * (half - 90)
      const y = 36 + (i % 3) * 18
      const from = axisX ? new THREE.Vector3(-half - 50, y, off) : new THREE.Vector3(off, y, -half - 50)
      const to = axisX ? new THREE.Vector3(half + 50, y, off) : new THREE.Vector3(off, y, half + 50)
      const quat = new THREE.Quaternion().setFromUnitVectors(fwd, this.v.copy(to).sub(from).normalize())
      this.lanes.push({ from, to, quat })
      for (let j = 0; j < perLane; j++) {
        this.podLane.push(i)
        this.podT.push((j / perLane + Math.random() * 0.03) % 1)
        // mid-tier pods cruise a touch slower; vary so they don't move in lockstep
        this.podSpeed.push((0.02 + Math.random() * 0.03) * (1 + i * 0.05))
      }
    }
    const count = this.podLane.length
    if (count === 0) return
    const geo = this.ownG(new THREE.BoxGeometry(1.0, 0.6, 4.4))
    const mat = this.own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const pods = new THREE.InstancedMesh(geo, mat, count)
    pods.frustumCulled = false // instances span the whole map; don't cull the mesh
    const col = new THREE.Color()
    for (let k = 0; k < count; k++) pods.setColorAt(k, col.setHex(tints[this.podLane[k] % tints.length]))
    if (pods.instanceColor) pods.instanceColor.needsUpdate = true
    this.pods = pods
    this.group.add(pods)
  }

  // --- freight blimps -------------------------------------------------------

  private buildBlimps() {
    const half = config.world.half
    const n = this.fx >= 0.9 ? 2 : this.fx >= 0.6 ? 1 : 0
    const hullMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3142, metalness: 0.5, roughness: 0.6 }))
    for (let i = 0; i < n; i++) {
      const g = new THREE.Group()
      const hull = new THREE.Mesh(this.ownG(new THREE.CapsuleGeometry(7, 26, 8, 16)), hullMat)
      hull.rotation.z = Math.PI / 2
      g.add(hull)
      for (const s of [-1, 1]) {
        const fin = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(8, 0.5, 5)), hullMat)
        fin.position.set(-16, 0, s * 3)
        fin.rotation.x = s * 0.4
        g.add(fin)
      }
      const tailFin = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(8, 5, 0.5)), hullMat)
      tailFin.position.set(-16, 0, 0)
      g.add(tailFin)
      // Lit gondola + glowing belly advertising strip.
      const gondola = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(10, 2.2, 3)), this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0x2b3550, emissiveIntensity: 1, roughness: 0.4 })))
      gondola.position.y = -7.5
      g.add(gondola)
      const bellyMat = this.own(new THREE.MeshBasicMaterial({ color: i % 2 ? 0xff2bd0 : 0x27e7ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const belly = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(22, 4)), bellyMat)
      belly.rotation.x = Math.PI / 2
      belly.position.y = -8.6
      g.add(belly)
      this.group.add(g)
      this.blimps.push({
        group: g,
        cx: (Math.random() * 2 - 1) * half * 0.3,
        cz: (Math.random() * 2 - 1) * half * 0.3,
        r: half * (0.45 + i * 0.18),
        ang: Math.random() * Math.PI * 2,
        spd: 0.03 + i * 0.01,
        y: 95 + i * 28,
        belly: bellyMat,
      })
    }
  }

  // --- ground set-pieces ----------------------------------------------------

  private buildSetPieces(opts: CityLifeOpts) {
    const half = config.world.half
    const ringR = half * 0.55
    // Two fusion reactors out in opposite districts.
    const reactorN = this.fx >= 0.6 ? 2 : 1
    for (let i = 0; i < reactorN; i++) {
      const a = 0.7 + i * Math.PI
      this.buildReactor(Math.cos(a) * ringR, Math.sin(a) * ringR * 0.86, opts)
    }
    // One construction crane site (skipped on low tier to save draw calls).
    if (this.fx >= 0.6) {
      const a = 2.1
      this.buildCrane(Math.cos(a) * ringR * 0.82, Math.sin(a) * ringR * 0.82, opts)
    }
  }

  private buildReactor(cx: number, cz: number, opts: CityLifeOpts) {
    const by = opts.groundY(cx, cz)
    const site = new THREE.Group()
    site.position.set(cx, by, cz)
    this.group.add(site)
    const steel = this.own(new THREE.MeshStandardMaterial({ color: 0x1a1f2b, metalness: 0.7, roughness: 0.4 }))
    const base = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(11, 13, 5, 24)), steel)
    base.position.y = 2.5
    site.add(base)
    // Pulsing core column.
    const coreMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0x49f2c0, emissiveIntensity: 2.4, roughness: 0.3 }))
    const core = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(2.6, 2.6, 30, 18)), coreMat)
    core.position.y = 20
    site.add(core)
    // Energy beam shooting up out of the core.
    const beamMat = this.own(new THREE.MeshBasicMaterial({ color: 0x6fffe0, transparent: true, opacity: 0.25, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const beam = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.2, 2.0, 120, 14, 1, true)), beamMat)
    beam.position.y = 90
    site.add(beam)
    // Counter-rotating containment rings.
    const rings: Reactor['rings'] = []
    const ringMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0x27e7ff, emissiveIntensity: 2, roughness: 0.4 }))
    const ringSpec: Array<['x' | 'y' | 'z', number, number]> = [['x', 9, 1.0], ['z', 9, -1.3], ['y', 12, 0.6]]
    for (const [axis, rad, spd] of ringSpec) {
      const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(rad, 0.5, 8, 32)), ringMat)
      ring.position.y = 20
      if (axis === 'x') ring.rotation.y = Math.PI / 2
      else if (axis === 'y') ring.rotation.x = Math.PI / 2
      site.add(ring)
      rings.push({ mesh: ring, axis, spd })
    }
    this.reactors.push({ rings, core: coreMat, beam: beamMat })
  }

  private buildCrane(cx: number, cz: number, opts: CityLifeOpts) {
    const by = opts.groundY(cx, cz)
    const site = new THREE.Group()
    site.position.set(cx, by, cz)
    this.group.add(site)
    const steel = this.own(new THREE.MeshStandardMaterial({ color: 0x23262e, metalness: 0.5, roughness: 0.6 }))
    const scaffold = this.own(new THREE.MeshStandardMaterial({ color: 0xffb14a, metalness: 0.4, roughness: 0.6 }))
    // Half-built tower wrapped in scaffolding.
    const TOWER_H = 52
    const tower = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(14, TOWER_H, 14)), steel)
    tower.position.y = TOWER_H / 2
    site.add(tower)
    for (const sx of [-8, 8]) for (const sz of [-8, 8]) {
      const post = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.5, TOWER_H + 8, 0.5)), scaffold)
      post.position.set(sx, (TOWER_H + 8) / 2, sz)
      site.add(post)
    }
    // Rotating tower crane: mast + jib that slews, with a load on a cable.
    const mast = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(1.4, 70, 1.4)), steel)
    mast.position.y = 35
    site.add(mast)
    const jib = new THREE.Group()
    jib.position.y = 66
    const arm = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(1, 1, 44)), steel)
    arm.position.z = 14
    jib.add(arm)
    const counter = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(2.4, 2, 6)), steel)
    counter.position.z = -9
    jib.add(counter)
    const hook = new THREE.Group()
    hook.position.set(0, 0, 28)
    const cable = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.08, 0.08, 18, 6)), scaffold)
    cable.position.y = -9
    hook.add(cable)
    const load = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(3, 2.5, 3)), steel)
    load.position.y = -18
    hook.add(load)
    jib.add(hook)
    site.add(jib)
    // Welding sparks at the build face.
    const sparks: THREE.MeshStandardMaterial[] = []
    for (let i = 0; i < 4; i++) {
      const m = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0xfff0b0, emissiveIntensity: 0 }))
      const s = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.3, 6, 6)), m)
      s.position.set((Math.random() * 2 - 1) * 6, 6 + Math.random() * TOWER_H, 7.2)
      site.add(s)
      sparks.push(m)
    }
    this.crane = { jib, hook, sparks }
  }

  // --- street drones --------------------------------------------------------

  /** Small police/courier drones patrolling down the road grid at low altitude
   *  with a downward scan beam, so the streets themselves have life. They ride
   *  road centrelines (multiples of the block pitch) to stay clear of buildings. */
  private buildStreetDrones() {
    const half = config.world.half
    const pitch = config.world.block
    const n = this.fx >= 0.9 ? 10 : this.fx >= 0.6 ? 6 : 3
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x12151d, metalness: 0.7, roughness: 0.4 }))
    const tints = [0x27e7ff, 0xff2bd0, 0x9bff4d, 0xffb14a]
    for (let i = 0; i < n; i++) {
      const g = new THREE.Group()
      const body = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(1.6, 0.5, 1.6)), bodyMat)
      g.add(body)
      const tint = tints[i % tints.length]
      const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(1.1, 0.12, 6, 16)), this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
      ring.rotation.x = Math.PI / 2
      g.add(ring)
      const beam = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(1.1, 8, 12, 1, true)), this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })))
      beam.position.y = -4
      g.add(beam)
      this.group.add(g)
      const axis: 'x' | 'z' = i % 2 === 0 ? 'x' : 'z'
      // snap the perpendicular offset to a road centreline out in the city
      const lines = Math.floor(half / pitch)
      const off = (Math.floor(Math.random() * (lines * 2 + 1)) - lines) * pitch
      this.streetDrones.push({ g, axis, off, pos: (Math.random() * 2 - 1) * half, dir: Math.random() < 0.5 ? 1 : -1, spd: 12 + Math.random() * 10, bob: Math.random() * 6 })
    }
  }

  // --- drone race course ----------------------------------------------------

  /** A floating circuit of neon gates out in a district with an AI racer drone
   *  threading them on a loop (banking into the turns). Pure spectacle you can
   *  chase; placed off-centre so it reads as its own destination. */
  private buildRaceCourse(opts: CityLifeOpts) {
    if (this.fx < 0.6) return
    const half = config.world.half
    const ccx = -half * 0.5, ccz = half * 0.42
    const by = opts.groundY(ccx, ccz)
    const gateN = 7
    const courseR = 70
    const gateMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0xff2bd0, emissiveIntensity: 2.2, roughness: 0.4 }))
    for (let i = 0; i < gateN; i++) {
      const a = (i / gateN) * Math.PI * 2
      const gx = ccx + Math.cos(a) * courseR
      const gz = ccz + Math.sin(a) * (courseR * 0.7)
      const gy = by + 24 + Math.sin(a * 2) * 12 // weave the altitude
      const gate = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(5, 0.5, 8, 24)), gateMat)
      gate.position.set(gx, gy, gz)
      gate.rotation.y = a + Math.PI / 2 // face along the track
      this.group.add(gate)
      this.gates.push(new THREE.Vector3(gx, gy, gz))
    }
    const g = new THREE.Group()
    const hull = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(0.9, 4, 12)), this.own(new THREE.MeshStandardMaterial({ color: 0xdfe6f0, metalness: 0.6, roughness: 0.3 })))
    hull.rotation.x = Math.PI / 2
    g.add(hull)
    const trail = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(0.7, 6, 12, 1, true)), this.own(new THREE.MeshBasicMaterial({ color: 0x9bff4d, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    trail.rotation.x = -Math.PI / 2
    trail.position.z = -4
    g.add(trail)
    g.position.copy(this.gates[0])
    this.group.add(g)
    this.racer = { g, idx: 1, speed: 34 }
  }

  // --- drifting sky creatures -----------------------------------------------

  /** Big bioluminescent "sky-whales" cruising slowly between the towers high up,
   *  undulating as they go. Translucent + additive so they glow like jellyfish. */
  private buildCreatures() {
    const half = config.world.half
    const n = this.fx >= 0.9 ? 2 : this.fx >= 0.6 ? 1 : 0
    for (let i = 0; i < n; i++) {
      const g = new THREE.Group()
      const skin = this.own(new THREE.MeshBasicMaterial({ color: i % 2 ? 0x7fd7ff : 0xbf8aff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const segs: THREE.Mesh[] = []
      const SEG = 6
      for (let s = 0; s < SEG; s++) {
        const r = 3.4 * (1 - s / (SEG + 2))
        const seg = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(r, 12, 8)), skin)
        seg.position.z = -s * 4
        seg.scale.z = 1.6
        g.add(seg)
        segs.push(seg)
      }
      for (const sx of [-1, 1]) {
        const fin = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(1.2, 7, 8)), skin)
        fin.position.set(sx * 3, 0, -4)
        fin.rotation.z = sx * 1.2
        g.add(fin)
      }
      this.group.add(g)
      this.creatures.push({ g, segs, cx: (Math.random() * 2 - 1) * half * 0.2, cz: (Math.random() * 2 - 1) * half * 0.2, r: half * (0.35 + i * 0.15), ang: Math.random() * 6.28, spd: 0.05 + i * 0.015, y: 120 + i * 30, phase: Math.random() * 6.28 })
    }
  }

  // --- market plaza ---------------------------------------------------------

  /** A lit street-market cluster in an outer district: rows of canopied stalls
   *  with glowing awnings around a rotating holographic vendor sign. Mostly
   *  static (cheap); only the central holo spins. */
  private buildMarket(opts: CityLifeOpts) {
    const half = config.world.half
    const cx = half * 0.42, cz = -half * 0.5
    const by = opts.groundY(cx, cz)
    const site = new THREE.Group()
    site.position.set(cx, by, cz)
    this.group.add(site)
    const post = this.own(new THREE.MeshStandardMaterial({ color: 0x1a1d26, metalness: 0.5, roughness: 0.6 }))
    const awnings = [0xff2bd0, 0x27e7ff, 0x9bff4d, 0xffb14a, 0x8a5cff]
    let k = 0
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) {
        const sx = (c - 1.5) * 7
        const sz = (r === 0 ? -1 : 1) * 8
        const stall = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(5, 3, 4)), post)
        stall.position.set(sx, 1.5, sz)
        site.add(stall)
        const awn = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(5.6, 0.4, 4.6)), this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: awnings[k % awnings.length], emissiveIntensity: 1.8, roughness: 0.4 })))
        awn.position.set(sx, 3.4, sz)
        site.add(awn)
        k++
      }
    }
    // Rotating holographic vendor sign on a plinth in the middle.
    const plinth = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.4, 1.8, 1.2, 16)), post)
    plinth.position.y = 0.6
    site.add(plinth)
    const holo = new THREE.Mesh(this.ownG(new THREE.IcosahedronGeometry(2.2, 0)), this.own(new THREE.MeshBasicMaterial({ color: 0x6fffe0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    holo.position.y = 4
    site.add(holo)
    this.holo = holo
  }

  // --- system contract ------------------------------------------------------

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    if (this.zone !== 'earth') return
    this.t += dt

    // Sky traffic: advance each pod along its lane and rewrite its matrix.
    if (this.pods) {
      for (let k = 0; k < this.podLane.length; k++) {
        let tt = this.podT[k] + this.podSpeed[k] * dt
        if (tt >= 1) tt -= 1
        this.podT[k] = tt
        const lane = this.lanes[this.podLane[k]]
        this.v.copy(lane.from).lerp(lane.to, tt)
        this.m.compose(this.v, lane.quat, this.one)
        this.pods.setMatrixAt(k, this.m)
      }
      this.pods.instanceMatrix.needsUpdate = true
    }

    // Blimps circle their loops; belly strip pulses.
    for (const b of this.blimps) {
      b.ang += b.spd * dt
      b.group.position.set(b.cx + Math.cos(b.ang) * b.r, b.y, b.cz + Math.sin(b.ang) * b.r)
      b.group.rotation.y = -b.ang
      b.belly.opacity = 0.6 + Math.sin(this.t * 1.5) * 0.25
    }

    // Reactors: spin the containment rings, pulse the core + beam.
    for (const r of this.reactors) {
      for (const ring of r.rings) ring.mesh.rotation[ring.axis] += ring.spd * dt
      const p = 1.8 + Math.sin(this.t * 2.5) * 0.8
      r.core.emissiveIntensity = p
      r.beam.opacity = 0.18 + Math.sin(this.t * 2.5) * 0.1
    }

    // Crane: slew the jib slowly and flicker the welding sparks.
    if (this.crane) {
      this.crane.jib.rotation.y += 0.12 * dt
      for (const s of this.crane.sparks) s.emissiveIntensity = Math.random() < 0.5 ? 2.5 + Math.random() * 2 : 0
    }

    // Street drones: cruise along their road line, wrap at the city edge, bob.
    const lim = config.world.half
    for (const d of this.streetDrones) {
      d.pos += d.dir * d.spd * dt
      if (d.pos > lim) d.pos = -lim
      else if (d.pos < -lim) d.pos = lim
      d.bob += dt
      const y = 8.5 + Math.sin(d.bob * 1.6) * 0.6
      if (d.axis === 'x') {
        d.g.position.set(d.pos, y, d.off)
        d.g.rotation.y = d.dir > 0 ? Math.PI / 2 : -Math.PI / 2
      } else {
        d.g.position.set(d.off, y, d.pos)
        d.g.rotation.y = d.dir > 0 ? 0 : Math.PI
      }
    }

    // Race drone: fly toward the next gate, hop to the following one on arrival.
    if (this.racer && this.gates.length > 1) {
      const r = this.racer
      const target = this.gates[r.idx]
      this.v.copy(target).sub(r.g.position)
      const dist = this.v.length()
      if (dist < 4) {
        r.idx = (r.idx + 1) % this.gates.length
      } else {
        this.v.multiplyScalar((r.speed * dt) / dist)
        r.g.position.add(this.v)
        r.g.lookAt(target) // nose toward the gate (banks through the weave)
      }
    }

    // Sky creatures: drift their loop and undulate the body segments.
    for (const c of this.creatures) {
      c.ang += c.spd * dt
      const x = c.cx + Math.cos(c.ang) * c.r
      const z = c.cz + Math.sin(c.ang) * c.r
      c.g.position.set(x, c.y + Math.sin(this.t * 0.5 + c.phase) * 4, z)
      c.g.rotation.y = -c.ang + Math.PI / 2
      for (let s = 0; s < c.segs.length; s++) {
        c.segs[s].position.y = Math.sin(this.t * 2 + c.phase + s * 0.6) * (0.5 + s * 0.18)
      }
    }

    // Market holo sign slowly turns.
    if (this.holo) this.holo.rotation.y += dt * 0.8
  }

  dispose() {
    this.scene.remove(this.group)
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
    this.geos = []
    this.mats = []
    this.pods = null
  }
}
