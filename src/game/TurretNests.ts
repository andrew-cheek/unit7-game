import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'
import type { Capturable } from './Game'

/**
 * Stationary hostile defense turrets bolted to pylons at fixed, deterministic
 * city spots: they idle-scan, lock + telegraph when the player strays near, then
 * fire pooled cosmetic energy bolts that nudge the player back (onZap). They
 * register as Capturables, so net/missiles destroy them for a bounty; downed
 * turrets go dark and rebuild after a delay. Earth only; pooled + disposed.
 */

interface Deps {
  /** Player position (lock + aim + bolt target). */
  focus: () => THREE.Vector3
  /** Ground height under a point (turret base placement). */
  groundY: (x: number, z: number) => number
  /** Small knockback applied to the player when a bolt connects (away from turret). */
  onZap: (kx: number, kz: number, ky: number) => void
}

interface Turret {
  group: THREE.Group
  head: THREE.Group // yaws to aim; tilts dark when destroyed
  cap: Capturable
  coreMat: THREE.MeshBasicMaterial // brightened to telegraph
  headPos: THREE.Vector3 // shared with cap.position (fixed barrel-pivot point)
  barrelLen: number // muzzle offset along the head's forward (+Z)
  yaw: number // current head yaw
  scan: number // idle scan phase
  charge: number // eased 0..1 telegraph brightness
  fireCd: number // >0 between shots
  destroyed: boolean
  rebuild: number // >0 while down, counting toward relight
}

interface Bolt {
  mesh: THREE.Mesh
  vel: THREE.Vector3 // unit travel direction * speed
  life: number // seconds left before it fizzles
  knocked: boolean // onZap already applied for this bolt
  active: boolean
}

const DETECT = 30 // lock range
const FIRE_CD = 1.2 // seconds between shots while locked
const BOLT_SPEED = 36
const BOLT_LIFE = 1.6
const HIT_R = 2.2 // bolt "connects" within this of the player
const BASE_H = 1.4 // pylon height
const HEAD_RISE = 3.6 // head sits this far above the pylon top (~5 up from ground)

/** Deterministic PRNG so the turret layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

export class TurretNests implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private turrets: Turret[] = []
  private bolts: Bolt[] = []
  private zone: Zone = 'earth'

  // scratch - reused every frame, no per-frame allocation
  private toPlayer = new THREE.Vector3()
  private muzzle = new THREE.Vector3()
  private toTarget = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, capturables: Capturable[], private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 4 : 7
    const rnd = mulberry32(91733)
    const reach = config.world.half * 0.82

    // --- shared geometry/materials (built once, reused across turrets) ---
    const pylonGeo = this.ownG(new THREE.CylinderGeometry(0.45, 0.62, BASE_H, 8))
    const collarGeo = this.ownG(new THREE.CylinderGeometry(0.7, 0.7, 0.28, 10))
    const yokeGeo = this.ownG(new THREE.BoxGeometry(1.1, 0.5, 0.7))
    const headGeo = this.ownG(new THREE.SphereGeometry(0.5, 12, 10))
    const barrelGeo = this.ownG(new THREE.CylinderGeometry(0.12, 0.16, 1.3, 8))
    const coreGeo = this.ownG(new THREE.SphereGeometry(0.2, 10, 8))

    const pylonMat = this.own(new THREE.MeshStandardMaterial({ color: 0x191c23, metalness: 0.8, roughness: 0.4 }))
    const collarMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2c313c, metalness: 0.7, roughness: 0.45 }))
    const headMat = this.own(new THREE.MeshStandardMaterial({ color: 0x23272f, metalness: 0.85, roughness: 0.35, emissive: 0x140404, emissiveIntensity: 0.4 }))
    const barrelMat = this.own(new THREE.MeshStandardMaterial({ color: 0x3a3f4a, metalness: 0.75, roughness: 0.4 }))

    const barrelLen = 1.05
    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const gy = this.deps.groundY(x, z)

      const grp = new THREE.Group()
      grp.position.set(x, gy, z)

      const pylon = new THREE.Mesh(pylonGeo, pylonMat); pylon.position.y = BASE_H / 2; grp.add(pylon)
      const collar = new THREE.Mesh(collarGeo, collarMat); collar.position.y = BASE_H + HEAD_RISE - 0.5; grp.add(collar)

      // The head yaws as one unit; barrel + core ride it pointing along +Z.
      const head = new THREE.Group()
      head.position.y = BASE_H + HEAD_RISE
      const yoke = new THREE.Mesh(yokeGeo, barrelMat); yoke.position.y = -0.15; head.add(yoke)
      const dome = new THREE.Mesh(headGeo, headMat); head.add(dome)
      const barrel = new THREE.Mesh(barrelGeo, barrelMat)
      barrel.rotation.x = Math.PI / 2 // local +Y -> +Z (forward)
      barrel.position.set(0, 0, 0.55)
      head.add(barrel)
      // Per-turret core material so each can pulse its telegraph independently.
      const coreMat = this.own(new THREE.MeshBasicMaterial({ color: config.palette.orange, fog: false }))
      const core = new THREE.Mesh(coreGeo, coreMat); core.position.set(0, 0.05, 0.18); head.add(core)
      grp.add(head)

      grp.visible = true
      this.group.add(grp)

      const headPos = new THREE.Vector3(x, gy + BASE_H + HEAD_RISE, z)
      const turret: Turret = {
        group: grp,
        head,
        coreMat,
        headPos,
        barrelLen,
        yaw: rnd() * Math.PI * 2,
        scan: rnd() * Math.PI * 2,
        charge: 0,
        fireCd: 0,
        destroyed: false,
        rebuild: 0,
        cap: { position: headPos, alive: true, capture: () => this.onCaptured(turret) },
      }
      head.rotation.y = turret.yaw
      this.turrets.push(turret)
      capturables.push(turret.cap)
    }

    // --- pooled cosmetic bolts (reused; no per-shot allocation) ---
    const boltGeo = this.ownG(new THREE.SphereGeometry(0.22, 8, 6))
    const boltMat = this.own(new THREE.MeshBasicMaterial({ color: config.palette.orange, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const poolN = low ? 8 : 14
    for (let i = 0; i < poolN; i++) {
      const mesh = new THREE.Mesh(boltGeo, boltMat)
      mesh.scale.set(0.7, 0.7, 2.0) // stretched tracer look
      mesh.visible = false
      this.group.add(mesh)
      this.bolts.push({ mesh, vel: new THREE.Vector3(), life: 0, knocked: false, active: false })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  /** Netted/blasted: go dark, stop firing, schedule a rebuild, pay the bounty. */
  private onCaptured(t: Turret): number {
    if (t.destroyed) return 0
    t.destroyed = true
    t.cap.alive = false
    t.charge = 0
    t.fireCd = 0
    t.head.rotation.x = -0.5 // barrel droops dead
    t.coreMat.color.setRGB(0.12, 0.05, 0.02) // core goes cold
    t.rebuild = 8 + Math.random() * 4
    return 45
  }

  /** Relight a rebuilt turret back to working order. */
  private restore(t: Turret) {
    t.destroyed = false
    t.head.rotation.x = 0
    t.charge = 0
    t.fireCd = 0
    t.cap.alive = this.zone === 'earth'
    t.coreMat.color.setHex(config.palette.orange)
  }

  setZone(zone: Zone) {
    this.zone = zone
    const on = zone === 'earth'
    this.group.visible = on
    for (const t of this.turrets) t.cap.alive = on && !t.destroyed
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) {
      // Still let any in-flight bolts settle so they don't pop next visit.
      for (const b of this.bolts) { if (b.active) { b.active = false; b.mesh.visible = false } }
      return
    }

    const focus = this.deps.focus()

    for (const t of this.turrets) {
      if (t.destroyed) {
        t.rebuild -= dt
        if (t.rebuild <= 0) this.restore(t)
        continue
      }

      if (t.fireCd > 0) t.fireCd -= dt

      // Horizontal range check against the fixed head position.
      this.toPlayer.copy(focus).sub(t.headPos)
      const distSq = this.toPlayer.x * this.toPlayer.x + this.toPlayer.z * this.toPlayer.z
      const locked = distSq < DETECT * DETECT

      // Aim: yaw the head toward the player when locked, else lazy scan.
      const targetYaw = locked
        ? Math.atan2(this.toPlayer.x, this.toPlayer.z)
        : (t.yaw + Math.sin((t.scan += dt * 0.4)) * 0.012)
      // Shortest-arc ease toward the target yaw (frame-rate-independent).
      let dy = targetYaw - t.yaw
      while (dy > Math.PI) dy -= Math.PI * 2
      while (dy < -Math.PI) dy += Math.PI * 2
      t.yaw += dy * Math.min(1, dt * (locked ? 6 : 2))
      t.head.rotation.y = t.yaw

      // Telegraph: brighten + pulse the core while locked, ease back otherwise.
      t.charge += ((locked ? 1 : 0) - t.charge) * Math.min(1, dt * 4)
      const pulse = locked ? 0.5 + 0.5 * Math.sin(performance.now() * 0.012) : 0
      const glow = 0.25 + t.charge * (0.9 + pulse * 0.6)
      t.coreMat.color.setRGB(Math.min(1, glow), Math.min(0.55, glow * 0.5), 0.08)
      t.coreMat.opacity = Math.min(1, 0.6 + glow * 0.4)

      // Fire a pooled bolt on cadence once locked + warmed up.
      if (locked && t.charge > 0.7 && t.fireCd <= 0) {
        this.fire(t, focus)
        t.fireCd = FIRE_CD
      }
    }

    this.stepBolts(dt, focus)
  }

  /** Launch a pooled bolt from the turret muzzle toward the player's current spot. */
  private fire(t: Turret, focus: THREE.Vector3) {
    const b = this.bolts.find((x) => !x.active)
    if (!b) return // pool exhausted; drop the shot rather than allocate

    // Muzzle = head position pushed along the head's forward (+Z, yawed).
    const sin = Math.sin(t.yaw), cos = Math.cos(t.yaw)
    this.muzzle.set(
      t.headPos.x + sin * t.barrelLen,
      t.headPos.y,
      t.headPos.z + cos * t.barrelLen,
    )
    // Aim slightly toward the player's chest height for a believable shot.
    this.toTarget.set(focus.x, focus.y + 1, focus.z).sub(this.muzzle)
    const len = this.toTarget.length()
    if (len > 0.001) this.toTarget.multiplyScalar(1 / len)
    else this.toTarget.set(sin, 0, cos)

    b.active = true
    b.knocked = false
    b.life = BOLT_LIFE
    b.vel.copy(this.toTarget).multiplyScalar(BOLT_SPEED)
    b.mesh.position.copy(this.muzzle)
    b.mesh.quaternion.setFromUnitVectors(FORWARD, this.toTarget) // stretch along travel
    b.mesh.visible = true
  }

  /** Advance live bolts; nudge the player on a near-miss, then retire. */
  private stepBolts(dt: number, focus: THREE.Vector3) {
    for (const b of this.bolts) {
      if (!b.active) continue
      b.life -= dt
      b.mesh.position.addScaledVector(b.vel, dt)

      if (!b.knocked) {
        const dx = b.mesh.position.x - focus.x
        const dy = b.mesh.position.y - (focus.y + 1)
        const dz = b.mesh.position.z - focus.z
        if (dx * dx + dy * dy + dz * dz < HIT_R * HIT_R) {
          // Knock the player AWAY from the turret along the bolt's travel.
          const vl = b.vel.length()
          const inv = vl > 0.001 ? 1 / vl : 0
          this.deps.onZap(b.vel.x * inv * 5, b.vel.z * inv * 5, 4)
          b.knocked = true
          b.life = Math.min(b.life, 0.06) // wink out just after the hit
        }
      }

      if (b.life <= 0) { b.active = false; b.mesh.visible = false }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}

/** Module-level constant unit forward (bolt mesh local +Z), no per-shot alloc. */
const FORWARD = new THREE.Vector3(0, 0, 1)
