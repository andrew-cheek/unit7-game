// GrindRails — neon rails the player can ride on the hoverboard. The rails are
// just line segments with glowing tube meshes; Player owns the grind movement
// and asks this system (via querySnap) whether a rail is close enough to latch.
//
// A small rail park sits off to the side of spawn (easy to find and learn on),
// plus longer rails strung through the city at varying heights so flying up and
// dropping into a grind is a traversal move, not just a spawn-side toy.
//
// Earth-only. Cheap: a dozen-ish tube + post meshes, one shared pulsing material
// per hue. querySnap reuses a single result object (no per-call allocation).

import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

/** A rail the player has latched: endpoints + the closest-point param t. */
export interface GrindHit {
  ax: number; ay: number; az: number
  bx: number; by: number; bz: number
  t: number
}

export interface GrindRailsOpts {
  groundY: (x: number, z: number) => number
}

interface Seg { ax: number; ay: number; az: number; bx: number; by: number; bz: number }

export class GrindRails implements GameSystem {
  private scene: THREE.Scene
  private group = new THREE.Group()
  private zone: Zone = 'earth'
  private segs: Seg[] = []
  private glowMats: THREE.MeshStandardMaterial[] = []
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private hit: GrindHit = { ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, t: 0 }
  private t = 0
  private up = new THREE.Vector3(0, 1, 0)
  private dir = new THREE.Vector3()

  constructor(scene: THREE.Scene, opts: GrindRailsOpts) {
    this.scene = scene
    this.build(opts)
    this.scene.add(this.group)
  }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  private railMat(color: number): THREE.MeshStandardMaterial {
    const m = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: 2.4, roughness: 0.4 }))
    this.glowMats.push(m)
    return m
  }

  /** Add a rail segment: stored for snapping + a glowing tube with end pylons. */
  private addRail(ax: number, ay: number, az: number, bx: number, by: number, bz: number, mat: THREE.MeshStandardMaterial, opts: GrindRailsOpts) {
    this.segs.push({ ax, ay, az, bx, by, bz })
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const len = Math.hypot(dx, dy, dz) || 1
    const tube = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.17, 0.17, len, 8)), mat)
    tube.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2)
    tube.quaternion.setFromUnitVectors(this.up, this.dir.set(dx, dy, dz).multiplyScalar(1 / len))
    this.group.add(tube)
    // Support pylons from each end down to the ground so rails read as structures.
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x12151d, metalness: 0.6, roughness: 0.5 }))
    for (const [px, py, pz] of [[ax, ay, az], [bx, by, bz]] as Array<[number, number, number]>) {
      const g0 = opts.groundY(px, pz)
      const h = py - g0
      if (h <= 1.2) continue
      const post = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.16, 0.22, h, 7)), postMat)
      post.position.set(px, g0 + h / 2, pz)
      this.group.add(post)
    }
  }

  private build(opts: GrindRailsOpts) {
    const low = config.tier.fxScale < 0.6
    const cyan = this.railMat(0x27e7ff)
    const magenta = this.railMat(0xff2bd0)
    const lime = this.railMat(0x9bff4d)

    // --- rail park off to the side of spawn (learn-it-here) ---
    const px = -64, pz = 6
    const g0 = opts.groundY(px, pz)
    for (let i = 0; i < 3; i++) {
      const x = px + (i - 1) * 7
      this.addRail(x, g0 + 1.4, pz - 22, x, g0 + 1.4, pz + 22, cyan, opts) // straight low rails
    }
    // a drop-in rail sloping down to the park
    this.addRail(px + 16, g0 + 11, pz - 26, px + 7, g0 + 1.4, pz - 6, magenta, opts)
    // an L-kink (two segments) along the park edge
    this.addRail(px - 9, g0 + 2.4, pz - 22, px - 9, g0 + 2.4, pz + 10, lime, opts)
    this.addRail(px - 9, g0 + 2.4, pz + 10, px + 12, g0 + 2.4, pz + 10, lime, opts)

    // --- longer rails strung through the city at height ---
    const half = config.world.half
    const hue = [cyan, magenta, lime]
    const cityRails: Array<[number, number, number, number, number, number]> = [
      [-half * 0.35, 22, -half * 0.4, -half * 0.05, 14, -half * 0.15],
      [half * 0.1, 26, half * 0.3, half * 0.45, 16, half * 0.5],
      [half * 0.4, 20, -half * 0.2, half * 0.15, 12, -half * 0.45],
      [-half * 0.5, 18, half * 0.15, -half * 0.2, 10, half * 0.4],
      [half * 0.05, 30, -half * 0.55, half * 0.3, 18, -half * 0.3],
    ]
    const cityN = low ? 2 : cityRails.length
    for (let i = 0; i < cityN; i++) {
      const [ax, ay, az, bx, by, bz] = cityRails[i]
      this.addRail(ax, ay, az, bx, by, bz, hue[i % hue.length], opts)
    }
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    if (this.zone !== 'earth') return
    this.t += dt
    const p = 2.0 + Math.sin(this.t * 3) * 0.7
    for (const m of this.glowMats) m.emissiveIntensity = p
  }

  /** Nearest rail whose closest point is within snapRadius of (x,y,z), or null.
   *  Returns a reused object - copy the fields if you keep them. */
  querySnap(x: number, y: number, z: number): GrindHit | null {
    if (this.zone !== 'earth') return null
    // Latch with a small margin over the configured snapRadius so fast lateral
    // passes (hoverboard ~22 m/s) still catch the rail between frames; without it
    // the test needs near-frame-perfect alignment and high-speed passes miss.
    const r = config.grind.snapRadius + 0.35
    const r2 = r * r
    let best = Infinity, bi = -1, bt = 0
    for (let i = 0; i < this.segs.length; i++) {
      const s = this.segs[i]
      const dx = s.bx - s.ax, dy = s.by - s.ay, dz = s.bz - s.az
      const len2 = dx * dx + dy * dy + dz * dz || 1
      let t = ((x - s.ax) * dx + (y - s.ay) * dy + (z - s.az) * dz) / len2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const cx = s.ax + dx * t, cy = s.ay + dy * t, cz = s.az + dz * t
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz)
      if (d2 < best && d2 < r2) { best = d2; bi = i; bt = t }
    }
    if (bi < 0) return null
    const s = this.segs[bi]
    this.hit.ax = s.ax; this.hit.ay = s.ay; this.hit.az = s.az
    this.hit.bx = s.bx; this.hit.by = s.by; this.hit.bz = s.bz
    this.hit.t = bt
    return this.hit
  }

  dispose() {
    this.scene.remove(this.group)
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
    this.geos = []
    this.mats = []
    this.segs = []
  }
}
