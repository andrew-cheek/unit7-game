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
