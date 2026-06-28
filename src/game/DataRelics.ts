import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position. */
  focus: () => THREE.Vector3
  /** Sampled ground height at an XZ, so relics float a fixed height above it. */
  groundY: (x: number, z: number) => number
  /** Per-relic scan: small reward + progress popup at the relic. */
  onScan: (got: number, total: number, x: number, y: number, z: number) => void
  /** Big bonus once the whole set is found. */
  onComplete: (credits: number, xp: number) => void
  /** Show a HUD banner line. */
  banner: (text: string) => void
}

interface Relic {
  /** Per-relic cage (LineSegments cannot be instanced, so it stays a real object). */
  cage: THREE.LineSegments
  x: number
  y: number
  z: number
  /** RGB tint (kept so the core flash + per-instance colors can restore it). */
  tint: THREE.Color
  /** Beam height (constant) so its instance matrix never needs rebuilding. */
  beamH: number
  /** Independent local rotations per part, advanced each frame. */
  coreRotX: number
  coreRotY: number
  cageRotX: number
  cageRotY: number
  ringRotZ: number
  /** Current core colour (white-flashes on pickup, otherwise == tint). */
  coreColor: THREE.Color
  phase: number
  spin: number
  collected: boolean
  vanish: number // 0..1 collect animation progress (scale-up + fade)
}

/** Deterministic PRNG so the relic layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Data-relics: a curated "collect-them-all" set of glowing holographic artifacts
 * perched in interesting spots across the neon city (high ledges, rooftops). Get
 * close and a relic auto-scans for a small reward + progress banner; finishing the
 * whole set pays a big completion bonus. Earth-gated, pooled geometry, disposed
 * together. Payouts run through Game callbacks; a fresh set spawns each load.
 *
 * Draw-call budget: every repeated part (core / ring / halo / beam) is a single
 * InstancedMesh shared across all relics, so the whole set is ~4 instanced draws
 * plus one LineSegments per relic for the wireframe cage (lines can't be instanced).
 */
export class DataRelics implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private instanced: THREE.InstancedMesh[] = []
  private relics: Relic[] = []
  private zone: Zone = 'earth'
  private t = 0
  private collected = 0
  private total = 0
  private done = false
  private readonly reach = 3.5 // scan radius
  private readonly scratch = new THREE.Color()

  // Instanced part meshes (one draw each, across all relics).
  private coreMesh!: THREE.InstancedMesh
  private ringMesh!: THREE.InstancedMesh
  private haloMesh!: THREE.InstancedMesh
  private beamMesh!: THREE.InstancedMesh

  // Per-frame scratch (no heap allocation in update()).
  private readonly mPos = new THREE.Vector3()
  private readonly mQuat = new THREE.Quaternion()
  private readonly mScale = new THREE.Vector3()
  private readonly mEuler = new THREE.Euler()
  private readonly mMat = new THREE.Matrix4()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 8 : 12
    this.total = n
    const rnd = mulberry32(31337)
    const reach = config.world.half * 0.8

    // Shared geometry across all relics (pooled, disposed once).
    const coreGeo = this.ownG(new THREE.IcosahedronGeometry(0.55, 0))
    const cageGeo = this.ownG(new THREE.WireframeGeometry(new THREE.OctahedronGeometry(1.05, 0)))
    const ringGeo = this.ownG(new THREE.TorusGeometry(1.25, 0.05, 6, 24))
    const haloGeo = this.ownG(new THREE.SphereGeometry(1.4, 12, 10))
    const beamGeo = this.ownG(new THREE.CylinderGeometry(0.06, 0.06, 1, 6, 1, true))
    // Cyan/violet palette.
    const tints = [0x49e0ff, 0x9bd4ff, 0x8a6bff, 0xb07cff]

    // One material per part, shared by every instance. Per-relic colour rides on
    // the instanceColor attribute (setColorAt). Halo/ring opacity that used to be
    // per-relic is folded into the instance colour (additive blending makes a
    // dimmer colour read the same as lower opacity), so each relic keeps its own
    // pulse.
    const coreMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }))
    const ringMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const haloMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const beamMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true }))

    this.coreMesh = new THREE.InstancedMesh(coreGeo, coreMat, n)
    this.ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, n)
    this.haloMesh = new THREE.InstancedMesh(haloGeo, haloMat, n)
    this.beamMesh = new THREE.InstancedMesh(beamGeo, beamMat, n)
    this.instanced = [this.coreMesh, this.ringMesh, this.haloMesh, this.beamMesh]
    for (const im of this.instanced) {
      // Bounded set placed across the whole map; skip per-frame frustum tests.
      im.frustumCulled = false
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.group.add(im)
    }

    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      // Vary height: some easy, some perched high (reward jetpack/lifts).
      const gy = this.deps.groundY(x, z)
      const y = gy + 3 + rnd() * 15
      const tint = new THREE.Color(tints[(rnd() * tints.length) | 0])

      const cageMat = this.own(new THREE.LineBasicMaterial({ color: tint.getHex(), transparent: true, opacity: 0.7, fog: false }))
      const cage = new THREE.LineSegments(cageGeo, cageMat)
      cage.position.set(x, y, z)
      cage.frustumCulled = false
      this.group.add(cage)

      const beamH = y - gy

      this.relics.push({
        cage, x, y, z, tint, beamH,
        coreRotX: 0, coreRotY: 0, cageRotX: 0, cageRotY: 0, ringRotZ: 0,
        coreColor: tint.clone(),
        phase: rnd() * 6.28, spin: 0.4 + rnd() * 0.6, collected: false, vanish: 0,
      })
    }

    // Seed matrices + colours once so the set is correct on the first frame.
    for (let i = 0; i < n; i++) this.writeInstances(i, this.relics[i], 0)
    this.flushInstances()

    this.group.visible = false
    scene.add(this.group)
  }

  /** Build and store this relic's per-instance matrices + colours for index i. */
  private writeInstances(i: number, r: Relic, bob: number) {
    const px = r.x, pz = r.z

    if (r.collected && r.vanish >= 1) {
      // Fully gone: collapse to zero scale (InstancedMesh draws every instance).
      this.mMat.makeScale(0, 0, 0)
      this.coreMesh.setMatrixAt(i, this.mMat)
      this.ringMesh.setMatrixAt(i, this.mMat)
      this.haloMesh.setMatrixAt(i, this.mMat)
      this.beamMesh.setMatrixAt(i, this.mMat)
      return
    }

    // Collect animation: uniform scale-up + fade. Otherwise scale 1.
    const grow = r.collected ? 1 + r.vanish * 1.2 : 1
    const py = (r.collected ? r.y : r.y + bob)

    // Core: spins on two axes, scaled by grow, coloured by coreColor.
    this.mEuler.set(r.coreRotX, r.coreRotY, 0)
    this.mQuat.setFromEuler(this.mEuler)
    this.mPos.set(px, py, pz)
    this.mScale.set(grow, grow, grow)
    this.mMat.compose(this.mPos, this.mQuat, this.mScale)
    this.coreMesh.setMatrixAt(i, this.mMat)
    this.coreMesh.setColorAt(i, r.coreColor)

    // Ring: tilted flat (x = PI/2) then spun about local z, scaled by grow.
    this.mEuler.set(Math.PI / 2, 0, r.ringRotZ)
    this.mQuat.setFromEuler(this.mEuler)
    this.mScale.set(grow, grow, grow)
    this.mMat.compose(this.mPos, this.mQuat, this.mScale)
    this.ringMesh.setMatrixAt(i, this.mMat)

    // Ring colour: original opacity 0.6 baked into the tint.
    this.scratch.copy(r.tint).multiplyScalar(0.6)
    this.ringMesh.setColorAt(i, this.scratch)

    // Halo: no rotation. Pulse + collect fade ride on the instance colour, since
    // additive blending makes a dimmer colour read the same as a lower opacity.
    this.mEuler.set(0, 0, 0)
    this.mQuat.setFromEuler(this.mEuler)
    this.mScale.set(grow, grow, grow)
    this.mMat.compose(this.mPos, this.mQuat, this.mScale)
    this.haloMesh.setMatrixAt(i, this.mMat)

    let haloOpacity: number
    if (r.collected) {
      haloOpacity = 0.3 * (1 - r.vanish)
    } else {
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 2.6 + r.phase)
      haloOpacity = 0.22 + pulse * 0.16
    }
    this.scratch.copy(r.tint).multiplyScalar(haloOpacity)
    this.haloMesh.setColorAt(i, this.scratch)

    // Beam: static vertical locator, anchored at ground level under the relic.
    // It does not bob/scale with the relic (matches the original child offset).
    this.mEuler.set(0, 0, 0)
    this.mQuat.setFromEuler(this.mEuler)
    this.mScale.set(grow, r.beamH * grow, grow)
    this.mPos.set(px, r.y - r.beamH * 0.5, pz)
    this.mMat.compose(this.mPos, this.mQuat, this.mScale)
    this.beamMesh.setMatrixAt(i, this.mMat)
    this.scratch.copy(r.tint).multiplyScalar(0.12)
    this.beamMesh.setColorAt(i, this.scratch)
  }

  /** Mark all instance buffers dirty after a batch of writes. */
  private flushInstances() {
    for (const im of this.instanced) {
      im.instanceMatrix.needsUpdate = true
      if (im.instanceColor) im.instanceColor.needsUpdate = true
    }
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt
    const f = this.deps.focus()

    for (let i = 0; i < this.relics.length; i++) {
      const r = this.relics[i]

      if (r.collected) {
        // Quick scale-up + fade-out, then hide (zero-scale matrix).
        if (r.vanish < 1) {
          r.vanish = Math.min(1, r.vanish + dt * 2.5)
          // Cage mirrors the collect grow/fade; it's a real object, not instanced.
          const s = 1 + r.vanish * 1.2
          r.cage.scale.setScalar(s)
          const cm = r.cage.material as THREE.LineBasicMaterial
          cm.opacity = 0.7 * (1 - r.vanish)
          r.cage.visible = (1 - r.vanish) > 0.01
          this.writeInstances(i, r, 0)
        }
        continue
      }

      // Spin core (one axis), counter-rotate cage, bob, pulse halo, spin ring.
      const bob = Math.sin(this.t * 1.2 + r.phase) * 0.4
      r.coreRotY += r.spin * dt
      r.coreRotX += r.spin * 0.45 * dt
      r.cageRotY -= r.spin * 0.6 * dt
      r.cageRotX += r.spin * 0.25 * dt
      r.ringRotZ += r.spin * 0.5 * dt

      // Cage is a real object: drive its transform directly.
      r.cage.position.y = r.y + bob
      r.cage.rotation.set(r.cageRotX, r.cageRotY, 0)

      this.writeInstances(i, r, bob)

      // Scan when the player is close in 3D (you must reach it).
      const dx = r.x - f.x, dy = (r.y + bob) - f.y, dz = r.z - f.z
      if (dx * dx + dy * dy + dz * dz < this.reach * this.reach) {
        r.collected = true
        this.collected++
        this.deps.onScan(this.collected, this.total, r.x, r.y + bob, r.z)
        // Flash white at the moment of pickup for a crisp pop.
        r.coreColor.set(0xffffff)
        if (this.collected >= this.total && !this.done) {
          this.done = true
          this.deps.onComplete(800, 500)
          this.deps.banner('ALL DATA RELICS FOUND!')
        }
      }
    }

    this.flushInstances()
  }

  dispose() {
    for (const im of this.instanced) im.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
