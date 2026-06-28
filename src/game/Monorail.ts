// Monorail — an elevated neon train that endlessly loops the city on a glowing
// elliptical rail. A multi-car train glides around a large ring above the
// skyline with lit windows and a headlight, riding a thin additive rail held up
// by support pylons. Pure ambience: no colliders, no gameplay, Earth-only.
//
// The track is built once. Cars share geometry/materials and follow a single
// scalar `progress` sampled analytically along the ellipse — no per-frame heap
// allocation (scratch Vector3s are reused).

import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Car {
  group: THREE.Group
  /** Fractional offset behind the lead car along the loop (0..1). */
  offset: number
}

export class Monorail implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private instanced: THREE.InstancedMesh[] = []
  private cars: Car[] = []
  private zone: Zone = 'earth'
  private progress = 0

  // Ellipse params (x/z radii), height, and travel speed in loop-fractions/sec.
  private readonly rx: number
  private readonly rz: number
  private readonly y: number
  private readonly speed: number

  // Pre-allocated scratch reused every frame (no per-frame heap allocation).
  private pos = new THREE.Vector3()
  private tan = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene) {
    const low = config.tier.name === 'low'
    const half = config.world.half
    this.rx = half * 0.7
    this.rz = half * 0.7
    this.y = 19
    this.speed = 0.012 // ~83s per lap

    this.buildTrack(low)
    this.buildTrain(low ? 3 : 4)

    this.group.visible = false
    scene.add(this.group)
  }

  /** Sample the loop at param u (0..1): writes world position into `pos` and the
   *  normalized travel tangent into `tan`. Pure math, no allocation. */
  private sample(u: number) {
    const a = u * Math.PI * 2
    const c = Math.cos(a), s = Math.sin(a)
    this.pos.set(c * this.rx, this.y, s * this.rz)
    // d/da of (cos*rx, sin*rz) = (-sin*rx, cos*rz); normalize in-place.
    let tx = -s * this.rx, tz = c * this.rz
    const tl = Math.hypot(tx, tz) || 1
    tx /= tl; tz /= tl
    this.tan.set(tx, 0, tz)
  }

  /** Build the glowing rail ring plus a handful of support pylons. Built once. */
  private buildTrack(low: boolean) {
    // The rail: a thin glowing tube swept along the loop curve.
    const segs = low ? 96 : 160
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2
      pts.push(new THREE.Vector3(Math.cos(a) * this.rx, this.y - 1.1, Math.sin(a) * this.rz))
    }
    const curve = new THREE.CatmullRomCurve3(pts, true)
    const railGeo = this.ownG(new THREE.TubeGeometry(curve, segs, 0.35, 6, true))
    const railMat = this.own(new THREE.MeshBasicMaterial({
      color: 0x35e0ff, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }))
    this.group.add(new THREE.Mesh(railGeo, railMat))

    // Support pylons from the rail down to the ground at intervals. These are
    // identical static structures, so they collapse to a single InstancedMesh:
    // one draw call for all pylons, with per-instance matrices baked once here
    // (they never move). Visuals are identical to per-mesh placement.
    const pylonCount = low ? 8 : 14
    const pylonH = this.y - 1.1
    const pylonGeo = this.ownG(new THREE.CylinderGeometry(0.5, 0.9, pylonH, 6))
    const pylonMat = this.own(new THREE.MeshStandardMaterial({
      color: 0x14181f, metalness: 0.6, roughness: 0.6,
      emissive: 0x0a2030, emissiveIntensity: 0.5,
    }))
    const pylons = new THREE.InstancedMesh(pylonGeo, pylonMat, pylonCount)
    const m = new THREE.Matrix4()
    for (let i = 0; i < pylonCount; i++) {
      const a = (i / pylonCount) * Math.PI * 2
      const px = Math.cos(a) * this.rx, pz = Math.sin(a) * this.rz
      m.makeTranslation(px, pylonH / 2, pz)
      pylons.setMatrixAt(i, m)
    }
    pylons.instanceMatrix.needsUpdate = true
    // Static infrastructure never moves; skip per-frame matrix recompute.
    pylons.matrixAutoUpdate = false
    this.instanced.push(pylons)
    this.group.add(pylons)
  }

  /** Build `n` cars sharing geometry/materials and add them to the group. */
  private buildTrain(n: number) {
    // Shared geometries.
    const bodyGeo = this.ownG(new THREE.BoxGeometry(2.4, 2.2, 6.4))
    const winGeo = this.ownG(new THREE.PlaneGeometry(0.7, 0.7))
    const lightGeo = this.ownG(new THREE.SphereGeometry(0.45, 10, 8))

    // Shared materials.
    const bodyMat = this.own(new THREE.MeshStandardMaterial({
      color: 0x202a3c, metalness: 0.75, roughness: 0.35,
      emissive: 0x081628, emissiveIntensity: 0.6,
    }))
    const winMat = this.own(new THREE.MeshBasicMaterial({
      color: 0xffe39a, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }))
    const headMat = this.own(new THREE.MeshBasicMaterial({
      color: 0xfff4d6, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }))

    // Car spacing as a fraction of the loop (so cars sit nose-to-tail).
    const spacing = 0.018

    for (let i = 0; i < n; i++) {
      const car = new THREE.Group()
      const body = new THREE.Mesh(bodyGeo, bodyMat)
      car.add(body)

      // A row of lit windows down each side.
      for (const sx of [-1.21, 1.21]) {
        for (let w = 0; w < 4; w++) {
          const win = new THREE.Mesh(winGeo, winMat)
          win.position.set(sx, 0.25, -2.2 + w * 1.5)
          win.rotation.y = sx < 0 ? -Math.PI / 2 : Math.PI / 2
          car.add(win)
        }
      }

      // The lead car gets a glowing headlight up front.
      if (i === 0) {
        const head = new THREE.Mesh(lightGeo, headMat)
        head.position.set(0, 0, 3.3)
        car.add(head)
      }

      this.group.add(car)
      this.cars.push({ group: car, offset: i * spacing })
    }
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    // Drive visibility from the zone each frame so it's correct at startup too
    // (setZone only fires on a zone *change*, and you begin on Earth).
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return

    this.progress = (this.progress + this.speed * dt) % 1

    for (const car of this.cars) {
      let u = this.progress - car.offset
      u -= Math.floor(u) // wrap into 0..1 without allocation
      this.sample(u)
      car.group.position.copy(this.pos)
      // Face along the travel tangent; a slight bank into the curve adds life.
      const yaw = Math.atan2(this.tan.x, this.tan.z)
      car.group.rotation.set(0, yaw, -0.06)
    }
  }

  dispose() {
    // InstancedMesh owns a GPU instance buffer beyond its geometry/material.
    for (const im of this.instanced) im.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    this.instanced = []
    this.geos = []
    this.mats = []
    this.cars = []
  }
}
