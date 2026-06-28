import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so colonists keep milling about wherever you wander off-world. */
  focus: () => THREE.Vector3
  /** Ground height under a point in the current zone, so figures stay on terrain. */
  groundY: (x: number, z: number) => number
}

interface Colonist {
  pos: THREE.Vector3
  target: THREE.Vector3
  heading: number // current facing yaw (eased toward travel direction)
  speed: number
  phase: number // bob/waddle walk-cycle phase
  dwell: number // >0 = pausing at a waypoint, counting down
  suit: number // index into the suit tint palette
}

const NEAR = 110 // colonists wander within this radius of the player
const FAR = 130 // beyond this, respawn closer in

// Per-colonist local part layout, matched 1:1 to the original per-mesh transforms.
// Each entry is the part's resting local position; limbs additionally swing in X.
const ARM_L = new THREE.Vector3(-0.52, 1.0, 0)
const ARM_R = new THREE.Vector3(0.52, 1.0, 0)
const LEG_L = new THREE.Vector3(-0.22, 0.35, 0)
const LEG_R = new THREE.Vector3(0.22, 0.35, 0)

/**
 * Spacesuited colonists wandering the Moon and Mars surface near you, so the
 * off-world zones feel inhabited rather than empty. Pure character: chunky
 * low-poly figures with glowing additive visors that slow-walk between random
 * waypoints, waddling and turning toward travel. No colliders, no gameplay.
 *
 * Instanced: every figure shares one InstancedMesh per part (body/helmet/visor/
 * pack + four limbs), so the whole off-world crowd is 8 draw calls regardless of
 * count. Per-colonist suit tint rides on instanceColor; limbs swing via per-
 * instance matrices written each frame from reused scratch (no per-frame alloc).
 * Zone-gated to off-world (hidden on Earth's crowd).
 */
export class ColonistNPCs implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private colonists: Colonist[] = []
  private zone: Zone = 'earth'
  // Suit tint palette (white/orange variations); re-themed per world in setZone.
  private suitColors: THREE.Color[] = []
  private count = 0

  // Instanced part meshes. Static parts only need their colonist transform; the
  // four limbs additionally fold the swing rotation into their instance matrix.
  private bodyIM!: THREE.InstancedMesh
  private helmetIM!: THREE.InstancedMesh
  private visorIM!: THREE.InstancedMesh
  private packIM!: THREE.InstancedMesh
  private armLIM!: THREE.InstancedMesh
  private armRIM!: THREE.InstancedMesh
  private legLIM!: THREE.InstancedMesh
  private legRIM!: THREE.InstancedMesh
  // Limbs that take the suit tint (so their instanceColor tracks the body).
  private suitLimbs!: THREE.InstancedMesh[]

  // Pre-allocated scratch reused every frame (no per-frame heap allocation).
  private dir = new THREE.Vector3()
  private fp = new THREE.Vector3()
  private mBase = new THREE.Matrix4() // colonist root (pos + yaw)
  private mPart = new THREE.Matrix4() // root * part-local
  private mLocal = new THREE.Matrix4() // part-local (pos [* swing])
  private mSwing = new THREE.Matrix4() // limb swing rotation
  private qScratch = new THREE.Quaternion()
  private vPos = new THREE.Vector3()
  private vBody = new THREE.Vector3(0, 0.95, 0)
  private vHelmet = new THREE.Vector3(0, 1.7, 0)
  private vVisor = new THREE.Vector3(0, 1.7, 0.06)
  private vPack = new THREE.Vector3(0, 1.0, -0.42)
  private vOne = new THREE.Vector3(1, 1, 1)
  private cScratch = new THREE.Color()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  private makeIM(geo: THREE.BufferGeometry, mat: THREE.Material, count: number): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(geo, mat, count)
    im.frustumCulled = false // figures roam around the player; cull manually via zero-scale
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.group.add(im)
    return im
  }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const count = low ? 5 : 9
    this.count = count

    // Shared geometry reused across every instance.
    const bodyGeo = this.ownG(new THREE.CapsuleGeometry(0.42, 0.7, 4, 10))
    const helmetGeo = this.ownG(new THREE.SphereGeometry(0.4, 12, 10))
    const visorGeo = this.ownG(new THREE.SphereGeometry(0.31, 12, 8, -Math.PI * 0.55, Math.PI * 1.1, Math.PI * 0.32, Math.PI * 0.42))
    const packGeo = this.ownG(new THREE.BoxGeometry(0.5, 0.6, 0.28))
    const limbGeo = this.ownG(new THREE.CapsuleGeometry(0.14, 0.42, 3, 6))

    // Suit tint variations (white/orange suits). With instancing the per-figure
    // tint lives in instanceColor, so the shared material stays white and the
    // colors are written per instance below + re-themed in setZone.
    this.suitColors = [
      new THREE.Color(0xf2f4f8),
      new THREE.Color(0xe9eef4),
      new THREE.Color(0xff8a3c),
    ]
    const suitMat = this.own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.66, metalness: 0.1 }))
    // Helmet shell + glowing additive visor (kept bright on both worlds).
    const helmetMat = this.own(new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.4, metalness: 0.2 }))
    const visorMat = this.own(new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const packMat = this.own(new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.6, metalness: 0.4 }))

    this.bodyIM = this.makeIM(bodyGeo, suitMat, count)
    this.helmetIM = this.makeIM(helmetGeo, helmetMat, count)
    this.visorIM = this.makeIM(visorGeo, visorMat, count)
    this.packIM = this.makeIM(packGeo, packMat, count)
    this.armLIM = this.makeIM(limbGeo, suitMat, count)
    this.armRIM = this.makeIM(limbGeo, suitMat, count)
    this.legLIM = this.makeIM(limbGeo, suitMat, count)
    this.legRIM = this.makeIM(limbGeo, suitMat, count)
    this.suitLimbs = [this.armLIM, this.armRIM, this.legLIM, this.legRIM]

    for (let i = 0; i < count; i++) {
      const pos = new THREE.Vector3()
      const target = new THREE.Vector3()
      const c: Colonist = {
        pos, target,
        heading: Math.random() * Math.PI * 2,
        speed: 1.4 + Math.random() * 0.9,
        phase: Math.random() * Math.PI * 2,
        dwell: 0,
        suit: i % this.suitColors.length,
      }
      this.scatter(c, true)
      this.colonists.push(c)
    }

    // Seed per-instance suit tints (and lay down an initial matrix set).
    this.applySuitColors()

    this.group.visible = false
    scene.add(this.group)
  }

  /** Push the current suit palette onto every figure's instanceColor (body + limbs). */
  private applySuitColors() {
    for (let i = 0; i < this.count; i++) {
      const col = this.suitColors[this.colonists[i].suit]
      this.bodyIM.setColorAt(i, col)
      for (const im of this.suitLimbs) im.setColorAt(i, col)
    }
    if (this.bodyIM.instanceColor) this.bodyIM.instanceColor.needsUpdate = true
    for (const im of this.suitLimbs) if (im.instanceColor) im.instanceColor.needsUpdate = true
  }

  /** Place a colonist (or just its next target) at a fresh point near the player. */
  private scatter(c: Colonist, placeNow: boolean) {
    const f = this.deps.focus()
    const a = Math.random() * Math.PI * 2
    const r = 18 + Math.random() * (NEAR - 18)
    const x = f.x + Math.cos(a) * r
    const z = f.z + Math.sin(a) * r
    c.target.set(x, this.deps.groundY(x, z), z)
    if (placeNow) {
      c.pos.set(x, c.target.y, z)
      // Steer it toward a second nearby waypoint so it starts walking, not idle.
      this.scatter(c, false)
    }
  }

  /** Theme the shared suit tints per world: cool grey on the Moon, dusty orange on Mars. */
  setZone(zone: Zone) {
    this.zone = zone
    const active = zone === 'moon' || zone === 'mars'
    this.group.visible = active
    if (!active) return
    if (zone === 'moon') {
      this.suitColors[0].setHex(0xf2f4f8)
      this.suitColors[1].setHex(0xcfd8e2)
      this.suitColors[2].setHex(0xeef2f6)
    } else {
      this.suitColors[0].setHex(0xe8d2bf)
      this.suitColors[1].setHex(0xd9a07a)
      this.suitColors[2].setHex(0xff8a3c)
    }
    this.applySuitColors()
  }

  update(dt: number) {
    // Drive visibility from the zone each frame so it's correct at startup too
    // (setZone only fires on a zone *change*, and you begin on Earth).
    const active = this.zone === 'moon' || this.zone === 'mars'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return

    const moon = this.zone === 'moon'
    this.fp.copy(this.deps.focus())

    for (let i = 0; i < this.colonists.length; i++) {
      const c = this.colonists[i]
      // Respawn nearer if the player has wandered far from this colonist.
      this.dir.subVectors(c.pos, this.fp)
      if (Math.hypot(this.dir.x, this.dir.z) > FAR) this.scatter(c, true)

      let moving = false
      if (c.dwell > 0) {
        c.dwell -= dt
        if (c.dwell <= 0) this.scatter(c, false)
      } else {
        this.dir.subVectors(c.target, c.pos)
        this.dir.y = 0
        const dist = Math.hypot(this.dir.x, this.dir.z)
        if (dist < 1.0) {
          c.dwell = 0.6 + Math.random() * 2.2
        } else {
          moving = true
          this.dir.multiplyScalar(1 / dist) // normalize without allocating
          const step = Math.min(dist, c.speed * dt)
          c.pos.x += this.dir.x * step
          c.pos.z += this.dir.z * step
          // Ease facing toward travel direction.
          let turn = Math.atan2(this.dir.x, this.dir.z) - c.heading
          while (turn > Math.PI) turn -= Math.PI * 2
          while (turn < -Math.PI) turn += Math.PI * 2
          c.heading += turn * Math.min(1, dt * 5)
        }
      }

      // Bob/waddle walk cycle; bouncier in the Moon's low gravity.
      if (moving) c.phase += dt * c.speed * 4
      const gy = this.deps.groundY(c.pos.x, c.pos.z)
      const bobAmp = moon ? 0.18 : 0.08
      const bob = moving ? Math.abs(Math.sin(c.phase)) * bobAmp : 0
      c.pos.y = gy

      // Root transform: position (+bob) and yaw, plus the waddle roll about Z.
      // Build root = T(pos) * Ry(heading) * Rz(roll), matching the old group.
      const roll = moving ? Math.sin(c.phase) * 0.05 : 0
      this.vPos.set(c.pos.x, gy + bob, c.pos.z)
      this.qScratch.setFromEuler(EULER_SET(c.heading, roll))
      this.mBase.compose(this.vPos, this.qScratch, this.vOne)

      // Static parts: root * local-offset.
      this.composePart(this.bodyIM, i, this.vBody)
      this.composePart(this.helmetIM, i, this.vHelmet)
      this.composePart(this.visorIM, i, this.vVisor)
      this.composePart(this.packIM, i, this.vPack)

      // Limbs swing in opposition (arms + legs) for a readable stride.
      const swing = moving ? Math.sin(c.phase) * 0.6 : 0
      this.composeLimb(this.armLIM, i, ARM_L, swing)
      this.composeLimb(this.armRIM, i, ARM_R, -swing)
      this.composeLimb(this.legLIM, i, LEG_L, -swing)
      this.composeLimb(this.legRIM, i, LEG_R, swing)
    }

    // One upload per instanced mesh after all figures are written.
    this.bodyIM.instanceMatrix.needsUpdate = true
    this.helmetIM.instanceMatrix.needsUpdate = true
    this.visorIM.instanceMatrix.needsUpdate = true
    this.packIM.instanceMatrix.needsUpdate = true
    this.armLIM.instanceMatrix.needsUpdate = true
    this.armRIM.instanceMatrix.needsUpdate = true
    this.legLIM.instanceMatrix.needsUpdate = true
    this.legRIM.instanceMatrix.needsUpdate = true
  }

  /** Write a static part instance: root * translate(localOffset). */
  private composePart(im: THREE.InstancedMesh, i: number, offset: THREE.Vector3) {
    this.mLocal.makeTranslation(offset.x, offset.y, offset.z)
    this.mPart.multiplyMatrices(this.mBase, this.mLocal)
    im.setMatrixAt(i, this.mPart)
  }

  /** Write a limb instance: root * translate(localOffset) * rotateX(swing). */
  private composeLimb(im: THREE.InstancedMesh, i: number, offset: THREE.Vector3, swing: number) {
    this.mLocal.makeTranslation(offset.x, offset.y, offset.z)
    this.mSwing.makeRotationX(swing)
    this.mLocal.multiply(this.mSwing)
    this.mPart.multiplyMatrices(this.mBase, this.mLocal)
    im.setMatrixAt(i, this.mPart)
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}

// Reused Euler to avoid per-frame allocation when composing the root quaternion.
// Original figure was a plain Object3D (default Euler order 'XYZ'); with x=0 the
// matrix reduces to Ry * Rz, which we reproduce here exactly.
const _euler = new THREE.Euler(0, 0, 0, 'XYZ')
function EULER_SET(yaw: number, roll: number): THREE.Euler {
  _euler.set(0, yaw, roll)
  return _euler
}
