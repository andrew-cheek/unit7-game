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
  /** Fractional offset behind the lead car along the loop (0..1). */
  offset: number
}

/** Local (car-space) transforms of the 8 lit windows, baked once. */
interface WinLocal {
  x: number
  y: number
  z: number
  yaw: number
}

export class Monorail implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private instanced: THREE.InstancedMesh[] = []
  private cars: Car[] = []
  private zone: Zone = 'earth'
  private progress = 0

  // Instanced car bodies + windows (filled in buildTrain). The headlight stays a
  // single mesh on the lead car. winLocal holds each window's car-space transform
  // (same for every car), so window world matrices = carMatrix * localMatrix.
  private bodyInst: THREE.InstancedMesh | null = null
  private winInst: THREE.InstancedMesh | null = null
  private head: THREE.Mesh | null = null
  private winLocal: WinLocal[] = []

  // Ellipse params (x/z radii), height, and travel speed in loop-fractions/sec.
  private readonly rx: number
  private readonly rz: number
  private readonly y: number
  private readonly speed: number

  // Pre-allocated scratch reused every frame (no per-frame heap allocation).
  private pos = new THREE.Vector3()
  private tan = new THREE.Vector3()
  // Scratch for building per-instance matrices each frame.
  private carMat = new THREE.Matrix4()   // a car's world transform
  private winMat = new THREE.Matrix4()    // a window's world transform (car * local)
  private localMat = new THREE.Matrix4()  // a window's car-space transform
  private quat = new THREE.Quaternion()
  private euler = new THREE.Euler()
  private one = new THREE.Vector3(1, 1, 1)

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

  /** Build `n` cars as two InstancedMeshes (bodies + windows) plus the lead-car
   *  headlight. Identical geometry/materials as before — purely a draw-call win
   *  (~5 draws/car -> 2 shared draws + 1 headlight). Per-car/window world
   *  matrices are written each frame in update() from the shared motion path. */
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

    // Bake the per-car-space window layout once (same for every car): a row of
    // lit windows down each side, matching the original per-mesh placement.
    for (const sx of [-1.21, 1.21]) {
      for (let w = 0; w < 4; w++) {
        this.winLocal.push({
          x: sx, y: 0.25, z: -2.2 + w * 1.5,
          yaw: sx < 0 ? -Math.PI / 2 : Math.PI / 2,
        })
      }
    }
    const winsPerCar = this.winLocal.length

    // Car spacing as a fraction of the loop (so cars sit nose-to-tail).
    const spacing = 0.018

    for (let i = 0; i < n; i++) {
      this.cars.push({ offset: i * spacing })
    }

    // One InstancedMesh for all car bodies, one for all windows. Matrices are
    // filled per frame in update(); frustumCulled off since the train spans the
    // whole ring and instances move independently of the shared bounding box.
    this.bodyInst = new THREE.InstancedMesh(bodyGeo, bodyMat, n)
    this.bodyInst.frustumCulled = false
    this.winInst = new THREE.InstancedMesh(winGeo, winMat, n * winsPerCar)
    this.winInst.frustumCulled = false
    this.instanced.push(this.bodyInst, this.winInst)
    this.group.add(this.bodyInst, this.winInst)

    // The lead car gets a glowing headlight up front (kept a single mesh).
    this.head = new THREE.Mesh(lightGeo, headMat)
    this.head.position.set(0, 0, 3.3)
    this.group.add(this.head)
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

    const winsPerCar = this.winLocal.length
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i]
      let u = this.progress - car.offset
      u -= Math.floor(u) // wrap into 0..1 without allocation
      this.sample(u)
      // Build the car's world transform: position + yaw along the tangent + a
      // slight bank into the curve (matches the old Group rotation order XYZ).
      const yaw = Math.atan2(this.tan.x, this.tan.z)
      this.euler.set(0, yaw, -0.06)
      this.quat.setFromEuler(this.euler)
      this.carMat.compose(this.pos, this.quat, this.one)
      this.bodyInst!.setMatrixAt(i, this.carMat)

      // Each window = carMatrix * its baked car-space transform.
      for (let w = 0; w < winsPerCar; w++) {
        const wl = this.winLocal[w]
        this.pos.set(wl.x, wl.y, wl.z)
        this.euler.set(0, wl.yaw, 0)
        this.quat.setFromEuler(this.euler)
        this.localMat.compose(this.pos, this.quat, this.one)
        this.winMat.multiplyMatrices(this.carMat, this.localMat)
        this.winInst!.setMatrixAt(i * winsPerCar + w, this.winMat)
      }

      // Lead car carries the headlight at car-space (0,0,3.3). The sphere is
      // rotationally symmetric, so only its world position needs the car transform.
      if (i === 0 && this.head) {
        this.localMat.makeTranslation(0, 0, 3.3)
        this.winMat.multiplyMatrices(this.carMat, this.localMat)
        this.head.position.setFromMatrixPosition(this.winMat)
      }
    }
    this.bodyInst!.instanceMatrix.needsUpdate = true
    this.winInst!.instanceMatrix.needsUpdate = true
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
    this.bodyInst = null
    this.winInst = null
    this.head = null
    this.winLocal = []
  }
}
