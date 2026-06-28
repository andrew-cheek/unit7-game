import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Zone read each update so the field hard-hides off the Moon. */
  zone: () => Zone
  /** Sampled ground height at an XZ, so rims/boulders sit on the surface. */
  groundY: (x: number, z: number) => number
}

/** Deterministic PRNG so the crater field is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

interface Crater {
  x: number
  z: number
  gy: number
  radius: number
  landmark: boolean // gets a ring of perimeter pylon lights
}

/**
 * Stark lunar crater-rim + boulder-field set dressing for the Moon zone. A few
 * seeded craters get a low-poly rim ring (a flattened torus of dark grey rock
 * with a faint glowing accent stripe), a jumble of grey boulders clustered on the
 * rim, and on a couple of "landmark" craters a perimeter ring of small cyan light
 * pylons so they read as navigation beacons from a distance (matching the Earth
 * portal cyan). Airless, mostly-static look: only the accent stripe + pylon glow
 * slow-pulse.
 *
 * MOON only, pure ambience: no colliders, no rewards, no gameplay. All repeated
 * parts are pooled into InstancedMeshes (rims, accent rings, boulders, pylon
 * posts, pylon caps) so the whole field is a handful of draw calls. Matrices are
 * written once at construction; update() only nudges two shared material
 * opacities. Zero per-frame allocation. Disposed together.
 *
 * Tier counts (config.tier.name):
 *   high   -> 8 craters, full boulders, pylon lights on
 *   medium -> 5 craters, full boulders, pylon lights on
 *   low    -> 3 craters, fewer boulders, pylon lights off
 *
 * Constructor:
 *   new CraterAmbience(scene, {
 *     zone:    () => Zone,                          // current zone (Moon-gate)
 *     groundY: (x: number, z: number) => number,    // surface height sampler
 *   })
 */
export class CraterAmbience implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private instanced: THREE.InstancedMesh[] = []
  private zone: Zone = 'earth'
  private t = 0

  // Shared accent materials whose opacity slow-pulses in update().
  private accentMat!: THREE.MeshBasicMaterial
  private pylonMat: THREE.MeshBasicMaterial | null = null

  // Per-build scratch (matrices written once at construction, not per frame).
  private readonly mPos = new THREE.Vector3()
  private readonly mQuat = new THREE.Quaternion()
  private readonly mScale = new THREE.Vector3()
  private readonly mEuler = new THREE.Euler()
  private readonly mMat = new THREE.Matrix4()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const tier = config.tier.name
    const low = tier === 'low'
    const craterCount = tier === 'high' ? 8 : tier === 'medium' ? 5 : 3
    const pylonsOn = !low
    const boulderMax = low ? 4 : 7 // boulders per crater (upper bound)

    const rnd = mulberry32(74121)
    const reach = config.world.half * 0.8

    // --- lay out the craters on the surface (no overlap test; sparse field) ---
    const craters: Crater[] = []
    for (let i = 0; i < craterCount; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const radius = 6 + rnd() * 10
      // A couple of craters become landmarks (skip when pylons are off on low).
      const landmark = pylonsOn && rnd() < 0.34
      craters.push({ x, z, gy: this.deps.groundY(x, z), radius, landmark })
    }

    // --- shared geometry (pooled, disposed once) ---
    // Rim ring: a fat torus, flattened on Y to read as a raised crater lip.
    const rimGeo = this.ownG(new THREE.TorusGeometry(1, 0.34, 5, 18))
    // Accent stripe: a thin torus just above the rim crest.
    const accentGeo = this.ownG(new THREE.TorusGeometry(1, 0.05, 4, 20))
    // Boulders: a couple of low-poly rock primitives, picked per instance.
    const rockGeoA = this.ownG(new THREE.IcosahedronGeometry(1, 0))
    const rockGeoB = this.ownG(new THREE.DodecahedronGeometry(1, 0))
    // Pylon: a short post + a glowing cap.
    const postGeo = this.ownG(new THREE.CylinderGeometry(0.08, 0.12, 1, 5))
    const capGeo = this.ownG(new THREE.OctahedronGeometry(0.22, 0))

    // --- shared materials ---
    // Dark grey airless rock; flat-shaded for a stark faceted look.
    const rockMat = this.own(new THREE.MeshStandardMaterial({ color: 0x6f747a, roughness: 1, metalness: 0.02, flatShading: true, fog: true }))
    const rimMat = this.own(new THREE.MeshStandardMaterial({ color: 0x565b61, roughness: 1, metalness: 0.02, flatShading: true, fog: true }))
    // Faint cool accent stripe; additive so it glows without lighting.
    this.accentMat = this.own(new THREE.MeshBasicMaterial({ color: 0x49e0ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }))
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.9, metalness: 0.1, flatShading: true, fog: true }))
    if (pylonsOn) {
      this.pylonMat = this.own(new THREE.MeshBasicMaterial({ color: 0x49e0ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }))
    }

    // --- count instances up front so each InstancedMesh is exact-sized ---
    let nBoulder = 0
    let nPylon = 0
    const bouldersPer: number[] = []
    for (const c of craters) {
      const nb = 2 + ((rnd() * (boulderMax - 1)) | 0)
      bouldersPer.push(nb)
      nBoulder += nb
      if (c.landmark) nPylon += 8 // 8 perimeter pylons per landmark crater
    }
    const nRim = craters.length

    // --- instanced meshes (one draw each) ---
    const rimMesh = new THREE.InstancedMesh(rimGeo, rimMat, nRim)
    const accentMesh = new THREE.InstancedMesh(accentGeo, this.accentMat, nRim)
    const boulderMeshA = new THREE.InstancedMesh(rockGeoA, rockMat, Math.max(1, nBoulder))
    const boulderMeshB = new THREE.InstancedMesh(rockGeoB, rockMat, Math.max(1, nBoulder))
    this.instanced.push(rimMesh, accentMesh, boulderMeshA, boulderMeshB)

    let postMesh: THREE.InstancedMesh | null = null
    let capMesh: THREE.InstancedMesh | null = null
    if (pylonsOn && nPylon > 0 && this.pylonMat) {
      postMesh = new THREE.InstancedMesh(postGeo, postMat, nPylon)
      capMesh = new THREE.InstancedMesh(capGeo, this.pylonMat, nPylon)
      this.instanced.push(postMesh, capMesh)
    }

    for (const im of this.instanced) {
      im.frustumCulled = false
      this.group.add(im)
    }

    // Boulder meshes draw every slot; collapse unused slots to zero scale.
    const hideMat = this.mMat.makeScale(0, 0, 0).clone()
    for (let i = 0; i < boulderMeshA.count; i++) boulderMeshA.setMatrixAt(i, hideMat)
    for (let i = 0; i < boulderMeshB.count; i++) boulderMeshB.setMatrixAt(i, hideMat)

    // --- write every transform once ---
    let bi = 0 // boulder cursor (split across A/B by parity)
    let pi = 0 // pylon cursor
    for (let ci = 0; ci < craters.length; ci++) {
      const c = craters[ci]

      // Rim ring: flattened torus laid flat on the ground, slightly sunk so the
      // lip sits proud of the surface. Scale X/Z by radius, Y for lip height.
      this.mEuler.set(Math.PI / 2, rnd() * 6.28, 0)
      this.mQuat.setFromEuler(this.mEuler)
      this.mPos.set(c.x, c.gy + 0.1, c.z)
      this.mScale.set(c.radius, c.radius, c.radius * 0.45)
      this.mMat.compose(this.mPos, this.mQuat, this.mScale)
      rimMesh.setMatrixAt(ci, this.mMat)

      // Accent stripe: same footprint, riding just above the rim crest.
      this.mPos.set(c.x, c.gy + 0.55, c.z)
      this.mScale.set(c.radius * 0.98, c.radius * 0.98, c.radius * 0.45)
      this.mMat.compose(this.mPos, this.mQuat, this.mScale)
      accentMesh.setMatrixAt(ci, this.mMat)

      // Boulder jumble: clustered around the rim, sitting on the ground.
      const nb = bouldersPer[ci]
      for (let b = 0; b < nb; b++) {
        const ang = rnd() * 6.28
        const rr = c.radius * (0.85 + rnd() * 0.5)
        const bx = c.x + Math.cos(ang) * rr
        const bz = c.z + Math.sin(ang) * rr
        const by = this.deps.groundY(bx, bz)
        const s = 0.6 + rnd() * 1.8
        this.mEuler.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28)
        this.mQuat.setFromEuler(this.mEuler)
        // Half-sink the boulder so it reads as embedded, not floating.
        this.mPos.set(bx, by + s * 0.35, bz)
        this.mScale.set(s, s * (0.7 + rnd() * 0.5), s)
        this.mMat.compose(this.mPos, this.mQuat, this.mScale)
        // Alternate the two rock shapes; hide the unused mesh's slot.
        if ((bi & 1) === 0) {
          boulderMeshA.setMatrixAt(bi, this.mMat)
        } else {
          boulderMeshB.setMatrixAt(bi, this.mMat)
        }
        bi++
      }

      // Landmark pylon ring: 8 evenly-spaced posts + glowing caps on the rim.
      if (c.landmark && postMesh && capMesh) {
        const count = 8
        const pr = c.radius * 1.05
        for (let k = 0; k < count; k++) {
          const ang = (k / count) * Math.PI * 2
          const px = c.x + Math.cos(ang) * pr
          const pz = c.z + Math.sin(ang) * pr
          const py = this.deps.groundY(px, pz)
          const h = 1.4 + rnd() * 0.4

          // Post: stands on the ground (cylinder origin is centred -> +h/2).
          this.mEuler.set(0, 0, 0)
          this.mQuat.setFromEuler(this.mEuler)
          this.mPos.set(px, py + h * 0.5, pz)
          this.mScale.set(1, h, 1)
          this.mMat.compose(this.mPos, this.mQuat, this.mScale)
          postMesh.setMatrixAt(pi, this.mMat)

          // Cap: glowing diamond perched on top.
          this.mPos.set(px, py + h + 0.15, pz)
          this.mScale.set(1, 1, 1)
          this.mMat.compose(this.mPos, this.mQuat, this.mScale)
          capMesh.setMatrixAt(pi, this.mMat)
          pi++
        }
      }
    }

    for (const im of this.instanced) im.instanceMatrix.needsUpdate = true

    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'moon'
  }

  update(dt: number) {
    const onMoon = this.zone === 'moon' && this.deps.zone() === 'moon'
    if (this.group.visible !== onMoon) this.group.visible = onMoon
    if (!onMoon) return

    this.t += dt
    // Slow accent-stripe pulse (the only animated thing; field is otherwise static).
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 0.9)
    this.accentMat.opacity = 0.3 + pulse * 0.35
    if (this.pylonMat) {
      // Pylons breathe gently, offset so they don't beat in sync with the rims.
      const p2 = 0.5 + 0.5 * Math.sin(this.t * 0.9 + 1.6)
      this.pylonMat.opacity = 0.65 + p2 * 0.3
    }
  }

  dispose() {
    for (const im of this.instanced) im.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
