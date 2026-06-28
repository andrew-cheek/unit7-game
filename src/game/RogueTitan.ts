import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'
import type { Capturable } from './Game'

/**
 * A large roaming BOSS mech that periodically stomps through the city. Unlike the
 * one-shot aliens/drones it has HP: each net/missile hit (via its single
 * Capturable) chips 1 HP, flashes it red and pays a small chip score; the killing
 * blow returns 0 and fires a big bounty via onDefeated. Stalks the player slowly
 * with stomp shockwaves and a glowing weak-point core. One alive at a time, Earth only.
 */

interface Deps {
  /** Player position (stalk target + spawn placement). */
  focus: () => THREE.Vector3
  /** Ground height under a point (foot planting + spawn). */
  groundY: (x: number, z: number) => number
  /** Small chip-hit feedback (popup/sfx) at the titan's core. */
  onHit: (pos: THREE.Vector3) => void
  /** Big payout + popup on the killing blow. */
  onDefeated: (credits: number, xp: number, x: number, y: number, z: number) => void
  /** Banner announce (spawn warning / down). */
  banner: (text: string) => void
  /** Stomp ring fx at a foot position. */
  shockwave: (x: number, y: number, z: number) => void
}

type State = 'dormant' | 'stalk' | 'defeat'

const HP_HIGH = 18
const HP_LOW = 12
const CHIP_SCORE = 6
const DEFEAT_CREDITS = 750
const DEFEAT_XP = 400
const STALK_SPEED = 3.4 // u/s toward the player
const SPAWN_DIST = 60 // placed this far from the player
const AREA = 150 // soft bound around origin
const STRIDE = 1.05 // seconds per footfall (gait period)

export class RogueTitan implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private zone: Zone = 'earth'

  private state: State = 'dormant'
  private cooldown = 22 + Math.random() * 18 // first appearance after a short wait
  private hp = HP_HIGH
  private maxHp = HP_HIGH
  private flash = 0 // red hit-flash, decays
  private gait = 0 // walk-cycle phase
  private lastFoot = 1 // which foot last planted (-1 / 1), drives shockwave side
  private defeatT = 0 // death sink/fade timer

  private pos = new THREE.Vector3() // live position, shared with cap.position
  private cap: Capturable

  // animated parts
  private torso = new THREE.Group()
  private legL = new THREE.Group()
  private legR = new THREE.Group()
  private head = new THREE.Mesh()
  private coreMat: THREE.MeshBasicMaterial
  private bodyMat: THREE.MeshStandardMaterial

  // scratch - reused every frame, no per-frame allocation
  private toPlayer = new THREE.Vector3()
  private footScratch = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, capturables: Capturable[], private deps: Deps) {
    const low = config.tier.name === 'low'
    const seg = low ? 0 : 1 // icosahedron detail
    const cyl = low ? 8 : 14 // radial segments

    this.maxHp = low ? HP_LOW : HP_HIGH
    this.hp = this.maxHp

    this.cap = { position: this.pos, alive: false, capture: () => this.capture() }
    capturables.push(this.cap)

    // --- shared materials ---
    this.bodyMat = this.own(new THREE.MeshStandardMaterial({
      color: 0x14171d, metalness: 0.9, roughness: 0.4,
      emissive: 0x200404, emissiveIntensity: 0.0,
    }))
    const trimMat = this.own(new THREE.MeshStandardMaterial({
      color: 0x2a3340, metalness: 0.8, roughness: 0.45,
      emissive: 0x0a2a3a, emissiveIntensity: 0.6,
    }))
    const neonMat = this.own(new THREE.MeshBasicMaterial({ color: 0x2ad0ff, fog: false }))
    this.coreMat = this.own(new THREE.MeshBasicMaterial({
      color: 0xff8a3a, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }))

    // --- geometry (built once) ---
    const torsoGeo = this.ownG(new THREE.BoxGeometry(4.6, 4.2, 2.8))
    const chestGeo = this.ownG(new THREE.BoxGeometry(3.2, 1.6, 0.5))
    const headGeo = this.ownG(new THREE.IcosahedronGeometry(1.1, seg))
    const eyeGeo = this.ownG(new THREE.BoxGeometry(0.9, 0.18, 0.12))
    const shoulderGeo = this.ownG(new THREE.BoxGeometry(1.4, 1.4, 1.4))
    const armGeo = this.ownG(new THREE.CylinderGeometry(0.42, 0.34, 3.4, cyl))
    const thighGeo = this.ownG(new THREE.CylinderGeometry(0.7, 0.55, 3.0, cyl))
    const shinGeo = this.ownG(new THREE.CylinderGeometry(0.55, 0.42, 3.0, cyl))
    const footGeo = this.ownG(new THREE.BoxGeometry(1.6, 0.7, 2.4))
    const coreGeo = this.ownG(new THREE.IcosahedronGeometry(0.9, low ? 0 : 1))

    // --- torso assembly (bobs) ---
    const torso = new THREE.Mesh(torsoGeo, this.bodyMat)
    this.torso.add(torso)

    const chest = new THREE.Mesh(chestGeo, trimMat)
    chest.position.set(0, 0.6, 1.45)
    this.torso.add(chest)

    // weak-point core on the chest (telegraphs when hittable)
    const core = new THREE.Mesh(coreGeo, this.coreMat)
    core.position.set(0, -0.4, 1.55)
    this.torso.add(core)

    // head + visor
    this.head = new THREE.Mesh(headGeo, this.bodyMat)
    this.head.position.set(0, 3.0, 0.3)
    this.torso.add(this.head)
    const eye = new THREE.Mesh(eyeGeo, neonMat)
    eye.position.set(0, 0.1, 1.0)
    this.head.add(eye)

    // shoulders + arms (static, just bulk)
    for (const sx of [-1, 1]) {
      const sh = new THREE.Mesh(shoulderGeo, trimMat)
      sh.position.set(sx * 3.0, 1.4, 0)
      this.torso.add(sh)
      const arm = new THREE.Mesh(armGeo, this.bodyMat)
      arm.position.set(sx * 3.2, -0.6, 0)
      arm.rotation.z = sx * 0.12
      this.torso.add(arm)
    }
    this.torso.position.y = 7.4 // hips height; torso sits above the legs
    this.group.add(this.torso)

    // --- legs (alternate in the walk cycle) ---
    const buildLeg = (leg: THREE.Group) => {
      const thigh = new THREE.Mesh(thighGeo, this.bodyMat)
      thigh.position.y = -1.5
      leg.add(thigh)
      const shin = new THREE.Mesh(shinGeo, trimMat)
      shin.position.y = -4.4
      leg.add(shin)
      const foot = new THREE.Mesh(footGeo, this.bodyMat)
      foot.position.set(0, -6.1, 0.3)
      leg.add(foot)
    }
    this.legL.position.set(-1.2, 7.4, 0)
    this.legR.position.set(1.2, 7.4, 0)
    buildLeg(this.legL)
    buildLeg(this.legR)
    this.group.add(this.legL)
    this.group.add(this.legR)

    this.group.visible = false
    scene.add(this.group)
  }

  /** Multi-hit boss hook: 1 HP per weapon call; killing blow pays via onDefeated. */
  private capture(): number {
    if (!this.cap.alive) return 0
    this.hp -= 1
    // Hit-flash peak: full 0.25 normally; cut to a calmer 0.1 under reduced motion (read live at hit time).
    this.flash = config.reducedMotion ? 0.1 : 0.25
    this.deps.onHit(this.cap.position)
    if (this.hp <= 0) {
      this.cap.alive = false
      this.onDefeated()
      return 0 // payout handled by onDefeated, avoid double-pay
    }
    return CHIP_SCORE
  }

  /** Killing blow: big bounty, banner, begin the death sink, start cooldown. */
  private onDefeated() {
    this.state = 'defeat'
    this.defeatT = 0
    this.deps.banner('TITAN DOWN')
    this.deps.onDefeated(DEFEAT_CREDITS, DEFEAT_XP, this.pos.x, this.pos.y + 6, this.pos.z)
    this.cooldown = 40 + Math.random() * 20
  }

  /** Place far from the player at ground level and wake up. */
  private spawn() {
    const focus = this.deps.focus()
    const ang = Math.random() * Math.PI * 2
    let x = focus.x + Math.cos(ang) * SPAWN_DIST
    let z = focus.z + Math.sin(ang) * SPAWN_DIST
    x = Math.max(-AREA, Math.min(AREA, x))
    z = Math.max(-AREA, Math.min(AREA, z))
    this.pos.set(x, this.deps.groundY(x, z), z)
    this.hp = this.maxHp
    this.flash = 0
    this.gait = 0
    this.state = 'stalk'
    this.cap.alive = true
    this.group.visible = true
    this.group.position.copy(this.pos)
    this.deps.banner('⚠ ROGUE TITAN')
  }

  /** Off-Earth or teardown: hide and go dormant. */
  private retire() {
    this.cap.alive = false
    this.group.visible = false
    this.state = 'dormant'
    if (this.cooldown < 8) this.cooldown = 8
  }

  setZone(zone: Zone) {
    this.zone = zone
    if (zone !== 'earth' && this.state !== 'dormant') this.retire()
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (!onEarth) {
      if (this.state !== 'dormant') this.retire()
      return
    }

    if (this.state === 'dormant') {
      this.cooldown -= dt
      if (this.cooldown <= 0) this.spawn()
      return
    }

    if (this.state === 'defeat') {
      this.defeatT += dt
      // brief death sink + fade, then go dormant
      this.pos.y -= dt * 2.2
      this.group.position.y = this.pos.y
      const f = Math.max(0, 1 - this.defeatT / 1.4)
      // Defeat emissive flare: full 1.2 pop normally; calm it to a gentler 0.4 under reduced motion.
      this.bodyMat.emissiveIntensity = this.flash > 0 ? (config.reducedMotion ? 0.4 : 1.2) : 0
      this.coreMat.opacity = 0.95 * f
      this.group.rotation.z += dt * 0.6
      if (this.defeatT >= 1.4) {
        this.group.visible = false
        this.group.rotation.set(0, 0, 0)
        this.coreMat.opacity = 0.95
        this.state = 'dormant'
      }
      if (this.flash > 0) this.flash = Math.max(0, this.flash - dt)
      return
    }

    // --- STALK ---
    const focus = this.deps.focus()
    this.toPlayer.copy(focus).sub(this.pos)
    this.toPlayer.y = 0
    const dist = this.toPlayer.length()

    // walk slowly toward the player (keep a little standoff so it doesn't overlap)
    if (dist > 6) {
      const step = STALK_SPEED * dt / dist
      this.pos.x += this.toPlayer.x * step
      this.pos.z += this.toPlayer.z * step
    }
    this.pos.x = Math.max(-AREA, Math.min(AREA, this.pos.x))
    this.pos.z = Math.max(-AREA, Math.min(AREA, this.pos.z))

    // plant on the ground beneath the hips
    const gy = this.deps.groundY(this.pos.x, this.pos.z)
    this.pos.y += (gy - this.pos.y) * Math.min(1, dt * 5)
    this.group.position.copy(this.pos)
    if (dist > 0.001) this.group.rotation.y = Math.atan2(this.toPlayer.x, this.toPlayer.z)

    // walk cycle: advance gait, swing legs, bob torso, footfall shockwaves
    const moving = dist > 6
    this.gait += moving ? dt * (Math.PI * 2 / STRIDE) : 0
    const swing = Math.sin(this.gait) * 0.5
    this.legL.rotation.x = swing
    this.legR.rotation.x = -swing
    this.torso.rotation.x = Math.sin(this.gait * 2) * 0.04
    this.torso.position.y = 7.4 + Math.abs(Math.cos(this.gait)) * 0.25

    // a footfall happens each time a leg reaches the bottom of its swing
    const foot = Math.sin(this.gait) >= 0 ? 1 : -1
    if (moving && foot !== this.lastFoot) {
      this.lastFoot = foot
      // foot offset relative to facing (x is lateral in local space)
      const fy = this.group.rotation.y
      const lateral = foot * 1.2
      this.footScratch.set(
        this.pos.x + Math.cos(fy) * lateral,
        gy,
        this.pos.z - Math.sin(fy) * lateral,
      )
      this.deps.shockwave(this.footScratch.x, this.footScratch.y, this.footScratch.z)
    }

    // core pulse: brightens to telegraph it's hittable
    const pulse = 0.7 + 0.3 * Math.sin(this.gait * 1.6)
    this.coreMat.opacity = pulse
    this.coreMat.color.setRGB(1, 0.5 + 0.2 * pulse, 0.2 * pulse)

    // hit flash: drive emissive red, decay
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt)
      const k = this.flash / 0.25
      this.bodyMat.emissiveIntensity = k * 1.4
      this.coreMat.color.setRGB(1, 0.3 * (1 - k), 0.15 * (1 - k))
      this.coreMat.opacity = Math.max(pulse, k)
    } else {
      this.bodyMat.emissiveIntensity = 0
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
