import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'
import type { Capturable } from './Game'

/**
 * A giant airborne BOSS: a slow neon battleship that drifts high over the city.
 * Like RogueTitan it carries HP via a single Capturable — each net/missile hit on
 * its exposed glowing weak-point core chips 1 HP, flashes it red and pays a small
 * chip score; the killing blow returns 0 and fires a big bounty via onDefeated, then
 * the ship explodes and sinks. You must FLY up to reach it. One alive at a time, Earth only.
 */

interface Deps {
  /** Player position (drift target so a flying player can engage). */
  focus: () => THREE.Vector3
  /** Small chip-hit feedback (popup/sfx) at the ship's core. */
  onHit: (pos: THREE.Vector3) => void
  /** Big payout + popup on the killing blow. */
  onDefeated: (credits: number, xp: number, x: number, y: number, z: number) => void
  /** Banner announce (arrival / down). */
  banner: (text: string) => void
}

type State = 'dormant' | 'patrol' | 'defeat'

const HP_HIGH = 24
const HP_LOW = 16
const CHIP_SCORE = 8
const DEFEAT_CREDITS = 1200
const DEFEAT_XP = 600
const ARRIVE_DIST = 120 // drifts in from this far out
const ORBIT_R = 70 // radius of the patrol arc around the player area
const ORBIT_SPEED = 0.12 // rad/s — slow cruise
const ALT_MIN = 55
const ALT_MAX = 75

export class SkyDreadnought implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private zone: Zone = 'earth'

  private state: State = 'dormant'
  private cooldown = 30 + Math.random() * 30 // first appearance after a wait
  private hp = HP_HIGH
  private maxHp = HP_HIGH
  private flash = 0 // red hit-flash, decays
  private t = 0 // animation clock
  private orbit = Math.random() * Math.PI * 2 // patrol angle
  private centerX = 0 // arc center (player area, sampled on arrival)
  private centerZ = 0
  private alt = ALT_MIN // current cruise altitude
  private defeatT = 0 // death sink/fade timer

  private pos = new THREE.Vector3() // live core position, shared with cap.position
  private cap: Capturable

  // animated parts
  private hull = new THREE.Group()
  private coreMat: THREE.MeshBasicMaterial
  private bodyMat: THREE.MeshStandardMaterial

  // scratch — reused every frame, no per-frame allocation
  private toPlayer = new THREE.Vector3()
  private corePos = new THREE.Vector3() // ship-space core offset (under the hull)

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, capturables: Capturable[], private deps: Deps) {
    const low = config.tier.name === 'low'
    const cyl = low ? 8 : 16 // radial segments
    const seg = low ? 0 : 1 // core detail

    this.maxHp = low ? HP_LOW : HP_HIGH
    this.hp = this.maxHp

    this.cap = { position: this.pos, alive: false, capture: () => this.capture() }
    capturables.push(this.cap)

    // --- shared materials (only the core gets its own for flash/pulse) ---
    this.bodyMat = this.own(new THREE.MeshStandardMaterial({
      color: 0x10141c, metalness: 0.9, roughness: 0.38,
      emissive: 0x200404, emissiveIntensity: 0.0,
    }))
    const trimMat = this.own(new THREE.MeshStandardMaterial({
      color: 0x202a38, metalness: 0.85, roughness: 0.4,
      emissive: 0x0a2236, emissiveIntensity: 0.7,
    }))
    const neonMat = this.own(new THREE.MeshBasicMaterial({ color: 0x2ad0ff, fog: false }))
    const engineMat = this.own(new THREE.MeshBasicMaterial({
      color: 0x4fb0ff, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }))
    this.coreMat = this.own(new THREE.MeshBasicMaterial({
      color: 0xff8a3a, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }))

    // --- geometry (built once, shared) ---
    const hullGeo = this.ownG(new THREE.CylinderGeometry(2.2, 5.0, 34, cyl, 1))
    const noseGeo = this.ownG(new THREE.ConeGeometry(2.2, 8, cyl))
    const deckGeo = this.ownG(new THREE.BoxGeometry(7, 2.4, 20))
    const bridgeGeo = this.ownG(new THREE.BoxGeometry(4, 3.2, 6))
    const finGeo = this.ownG(new THREE.BoxGeometry(0.6, 6, 9))
    const trimGeo = this.ownG(new THREE.BoxGeometry(8.4, 0.4, 26))
    const eyeGeo = this.ownG(new THREE.BoxGeometry(3.2, 0.4, 0.2))
    const engineGeo = this.ownG(new THREE.CircleGeometry(2.4, cyl))
    const ringGeo = this.ownG(new THREE.TorusGeometry(2.6, 0.4, low ? 6 : 10, low ? 12 : 24))
    const coreGeo = this.ownG(new THREE.IcosahedronGeometry(1.6, seg))

    // --- hull: a long battleship lying along Z, nose forward (+Z) ---
    const hull = new THREE.Mesh(hullGeo, this.bodyMat)
    hull.rotation.x = Math.PI / 2 // lay the cylinder along Z
    this.hull.add(hull)

    const nose = new THREE.Mesh(noseGeo, trimMat)
    nose.rotation.x = -Math.PI / 2
    nose.position.z = 21
    this.hull.add(nose)

    const tail = new THREE.Mesh(noseGeo, this.bodyMat)
    tail.rotation.x = Math.PI / 2
    tail.position.z = -19
    this.hull.add(tail)

    // upper deck + command bridge
    const deck = new THREE.Mesh(deckGeo, this.bodyMat)
    deck.position.y = 3
    this.hull.add(deck)
    const bridge = new THREE.Mesh(bridgeGeo, trimMat)
    bridge.position.set(0, 5.4, -6)
    this.hull.add(bridge)
    const eye = new THREE.Mesh(eyeGeo, neonMat)
    eye.position.set(0, 5.4, -3.0)
    this.hull.add(eye)

    // neon trim strips down both flanks
    for (const sy of [1, -1]) {
      const trim = new THREE.Mesh(trimGeo, neonMat)
      trim.position.set(0, sy * 2.4, 0)
      this.hull.add(trim)
    }

    // side fins
    for (const sx of [-1, 1]) {
      const fin = new THREE.Mesh(finGeo, trimMat)
      fin.position.set(sx * 4.4, -1.5, -10)
      fin.rotation.z = sx * 0.4
      this.hull.add(fin)
    }

    // additive engine glow discs at the stern
    for (const ex of [-1.6, 1.6]) {
      const eng = new THREE.Mesh(engineGeo, engineMat)
      eng.position.set(ex, 0, -19.2)
      eng.rotation.y = Math.PI
      this.hull.add(eng)
    }

    // --- weak-point: bright pulsing core + halo ring on the underside ---
    const core = new THREE.Mesh(coreGeo, this.coreMat)
    core.position.set(0, -4.2, 2)
    this.hull.add(core)
    const ring = new THREE.Mesh(ringGeo, this.coreMat)
    ring.position.set(0, -4.2, 2)
    ring.rotation.x = Math.PI / 2
    this.hull.add(ring)
    // ship-space offset of the core, so cap.position tracks the glowing point
    this.corePos.set(0, -4.2, 2)

    this.group.add(this.hull)
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
    this.deps.banner('DREADNOUGHT DOWN')
    this.deps.onDefeated(DEFEAT_CREDITS, DEFEAT_XP, this.pos.x, this.pos.y, this.pos.z)
    this.cooldown = 75 + Math.random() * 30
  }

  /** Drift in over the player's area at altitude and wake up. */
  private spawn() {
    const focus = this.deps.focus()
    this.centerX = focus.x
    this.centerZ = focus.z
    this.alt = ALT_MIN + Math.random() * (ALT_MAX - ALT_MIN)
    this.orbit = Math.random() * Math.PI * 2
    // start the arc out at ARRIVE_DIST so it visibly drifts in
    const r = ARRIVE_DIST
    this.group.position.set(
      this.centerX + Math.cos(this.orbit) * r,
      this.alt,
      this.centerZ + Math.sin(this.orbit) * r,
    )
    this.hp = this.maxHp
    this.flash = 0
    this.t = 0
    this.state = 'patrol'
    this.cap.alive = true
    this.group.visible = true
    this.group.scale.setScalar(1)
    this.group.rotation.set(0, 0, 0)
    this.deps.banner('⚠ SKY DREADNOUGHT')
  }

  /** Off-Earth or teardown: hide and go dormant. */
  private retire() {
    this.cap.alive = false
    this.group.visible = false
    this.state = 'dormant'
    if (this.cooldown < 10) this.cooldown = 10
  }

  setZone(zone: Zone) {
    this.zone = zone
    if (zone !== 'earth' && this.state !== 'dormant') this.retire()
  }

  update(dt: number) {
    if (this.zone !== 'earth') {
      if (this.state !== 'dormant') this.retire()
      return
    }

    if (this.state === 'dormant') {
      this.cooldown -= dt
      if (this.cooldown <= 0) this.spawn()
      return
    }

    this.t += dt

    if (this.state === 'defeat') {
      this.defeatT += dt
      // dramatic sink + fade + a few burst flashes
      this.group.position.y -= dt * 6
      this.hull.rotation.z += dt * 0.5
      const f = Math.max(0, 1 - this.defeatT / 2.2)
      // Defeat burst: normally a 22 rad/s binary strobe. Under reduced motion, replace
      // with a steady glow + slow (<=2 rad/s) breathe so the wreck still flares calmly.
      const burst = config.reducedMotion
        ? 0.6 + 0.2 * Math.sin(this.defeatT * 2)
        : (Math.sin(this.defeatT * 22) > 0.4 ? 1 : 0)
      this.bodyMat.emissiveIntensity = burst * 1.8 * f
      this.coreMat.opacity = (0.5 + 0.5 * burst) * f
      this.group.scale.setScalar(Math.max(0.001, f))
      // keep cap.position with the wreck while it sinks
      this.corePos.set(0, -4.2, 2).applyEuler(this.group.rotation)
      this.pos.set(
        this.group.position.x + this.corePos.x,
        this.group.position.y + this.corePos.y,
        this.group.position.z + this.corePos.z,
      )
      if (this.defeatT >= 2.2) {
        this.group.visible = false
        this.group.scale.setScalar(1)
        this.group.rotation.set(0, 0, 0)
        this.hull.rotation.set(0, 0, 0)
        this.coreMat.opacity = 0.95
        this.bodyMat.emissiveIntensity = 0
        this.state = 'dormant'
      }
      return
    }

    // --- PATROL: slow arc around the player's area, sliding the center to follow ---
    const focus = this.deps.focus()
    this.centerX += (focus.x - this.centerX) * Math.min(1, dt * 0.2)
    this.centerZ += (focus.z - this.centerZ) * Math.min(1, dt * 0.2)
    this.orbit += ORBIT_SPEED * dt

    const tx = this.centerX + Math.cos(this.orbit) * ORBIT_R
    const tz = this.centerZ + Math.sin(this.orbit) * ORBIT_R
    const ty = this.alt + Math.sin(this.t * 0.4) * 2.5 // slow bob

    // ease the hull toward the patrol target (lets the arrival drift-in read)
    const k = Math.min(1, dt * 0.6)
    this.group.position.x += (tx - this.group.position.x) * k
    this.group.position.y += (ty - this.group.position.y) * k
    this.group.position.z += (tz - this.group.position.z) * k

    // face along the tangent of the arc (nose forward), with a slight bank/roll
    this.group.rotation.y = -this.orbit + Math.PI / 2
    this.hull.rotation.z = Math.sin(this.t * 0.5) * 0.06

    // place the cap at the live weak-point core so the player aims at the glow
    this.corePos.set(0, -4.2, 2).applyEuler(this.group.rotation)
    this.pos.set(
      this.group.position.x + this.corePos.x,
      this.group.position.y + this.corePos.y,
      this.group.position.z + this.corePos.z,
    )

    // core pulse: brightens to telegraph it's hittable
    const pulse = 0.7 + 0.3 * Math.sin(this.t * 3)
    this.coreMat.opacity = pulse
    this.coreMat.color.setRGB(1, 0.5 + 0.2 * pulse, 0.2 * pulse)

    // hit flash: drive emissive red, decay
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt)
      const fk = this.flash / 0.25
      this.bodyMat.emissiveIntensity = fk * 1.6
      this.coreMat.color.setRGB(1, 0.3 * (1 - fk), 0.15 * (1 - fk))
      this.coreMat.opacity = Math.max(pulse, fk)
    } else {
      this.bodyMat.emissiveIntensity = 0
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
