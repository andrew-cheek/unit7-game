import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js'
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
 *
 * Draw-call budget: the whole field is GPU-instanced. Static bases share two
 * InstancedMeshes (pylon, collar); the aiming head shares two more (the
 * yoke+barrel+dome shell, and the telegraph core), driven per frame via
 * setMatrixAt with reused scratch — no per-frame heap alloc. Bolts are one
 * pooled InstancedMesh. ~6 draws total for the field, not one per mesh.
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
  index: number // instance slot across every InstancedMesh
  cap: Capturable
  headPos: THREE.Vector3 // shared with cap.position (fixed barrel-pivot point)
  barrelLen: number // muzzle offset along the head's forward (+Z)
  yaw: number // current head yaw
  tilt: number // head pitch (0 live, droops when destroyed)
  scan: number // idle scan phase
  charge: number // eased 0..1 telegraph brightness
  fireCd: number // >0 between shots
  destroyed: boolean
  rebuild: number // >0 while down, counting toward relight
}

interface Bolt {
  index: number // instance slot in the bolt InstancedMesh
  pos: THREE.Vector3 // current world position
  quat: THREE.Quaternion // travel orientation (stretch along motion)
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

  // Instanced parts: bases (static) + head shell/core (driven per frame).
  private pylons!: THREE.InstancedMesh
  private collars!: THREE.InstancedMesh
  private headShells!: THREE.InstancedMesh // yoke + barrel + dome, baked into one geo
  private cores!: THREE.InstancedMesh // telegraph emitter, per-turret colour via instanceColor
  private boltsMesh!: THREE.InstancedMesh

  // scratch - reused every frame, no per-frame allocation
  private toPlayer = new THREE.Vector3()
  private muzzle = new THREE.Vector3()
  private toTarget = new THREE.Vector3()
  private mat4 = new THREE.Matrix4()
  private qScratch = new THREE.Quaternion()
  private vScratch = new THREE.Vector3()
  private sScratch = new THREE.Vector3(1, 1, 1)
  private cScratch = new THREE.Color()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, capturables: Capturable[], private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 4 : 7
    const rnd = mulberry32(91733)
    const reach = config.world.half * 0.82

    // --- base geometry (local to each nest's ground origin) ---
    // Pylon and collar keep distinct materials, so each is its own InstancedMesh.
    const pylonGeo = this.ownG(new THREE.CylinderGeometry(0.45, 0.62, BASE_H, 8))
    pylonGeo.translate(0, BASE_H / 2, 0)
    const collarGeo = this.ownG(new THREE.CylinderGeometry(0.7, 0.7, 0.28, 10))
    collarGeo.translate(0, BASE_H + HEAD_RISE - 0.5, 0)

    // --- head shell: yoke + barrel + dome merged, baked relative to the head
    // pivot (which sits at y = BASE_H + HEAD_RISE in nest-local space). The
    // shell shares two source materials; merge by material group so a single
    // InstancedMesh draws both with the original colours. ---
    const yokeGeo = new THREE.BoxGeometry(1.1, 0.5, 0.7)
    yokeGeo.translate(0, -0.15, 0)
    const barrelGeo = new THREE.CylinderGeometry(0.12, 0.16, 1.3, 8)
    barrelGeo.rotateX(Math.PI / 2) // local +Y -> +Z (forward)
    barrelGeo.translate(0, 0, 0.55)
    const domeGeo = new THREE.SphereGeometry(0.5, 12, 10)
    // yoke + barrel use barrelMat; dome uses headMat (one group per input).
    const shellGeo = this.ownG(
      BufferGeometryUtils.mergeGeometries([yokeGeo, barrelGeo, domeGeo], true),
    )
    yokeGeo.dispose(); barrelGeo.dispose(); domeGeo.dispose()

    const coreGeo = this.ownG(new THREE.SphereGeometry(0.2, 10, 8))
    coreGeo.translate(0, 0.05, 0.18)

    const pylonMat = this.own(new THREE.MeshStandardMaterial({ color: 0x191c23, metalness: 0.8, roughness: 0.4 }))
    const collarMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2c313c, metalness: 0.7, roughness: 0.45 }))
    const headMat = this.own(new THREE.MeshStandardMaterial({ color: 0x23272f, metalness: 0.85, roughness: 0.35, emissive: 0x140404, emissiveIntensity: 0.4 }))
    const barrelMat = this.own(new THREE.MeshStandardMaterial({ color: 0x3a3f4a, metalness: 0.75, roughness: 0.4 }))
    // White base so per-instance instanceColor carries the full telegraph RGB.
    const coreMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }))

    this.pylons = new THREE.InstancedMesh(pylonGeo, pylonMat, n)
    this.collars = new THREE.InstancedMesh(collarGeo, collarMat, n)
    // mergeGeometries(useGroups) emits one group per input in order:
    // 0 yoke, 1 barrel, 2 dome -> [barrelMat, barrelMat, headMat].
    this.headShells = new THREE.InstancedMesh(shellGeo, [barrelMat, barrelMat, headMat], n)
    this.cores = new THREE.InstancedMesh(coreGeo, coreMat, n)
    this.cores.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
    for (const im of [this.pylons, this.collars, this.headShells, this.cores]) {
      im.frustumCulled = false // bounded field; head matrices change every frame
      this.group.add(im)
    }

    const barrelLen = 1.05
    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const gy = this.deps.groundY(x, z)

      // Static bases: placed once at the nest ground origin.
      this.mat4.makeTranslation(x, gy, z)
      this.pylons.setMatrixAt(i, this.mat4)
      this.collars.setMatrixAt(i, this.mat4)

      const headPos = new THREE.Vector3(x, gy + BASE_H + HEAD_RISE, z)
      const turret: Turret = {
        index: i,
        headPos,
        barrelLen,
        yaw: rnd() * Math.PI * 2,
        tilt: 0,
        scan: rnd() * Math.PI * 2,
        charge: 0,
        fireCd: 0,
        destroyed: false,
        rebuild: 0,
        cap: { position: headPos, alive: true, capture: () => this.onCaptured(turret) },
      }
      this.writeHead(turret)
      this.cores.setColorAt(i, this.cScratch.setHex(config.palette.orange))
      this.turrets.push(turret)
      capturables.push(turret.cap)
    }
    this.pylons.instanceMatrix.needsUpdate = true
    this.collars.instanceMatrix.needsUpdate = true
    this.headShells.instanceMatrix.needsUpdate = true
    this.cores.instanceMatrix.needsUpdate = true
    if (this.cores.instanceColor) this.cores.instanceColor.needsUpdate = true

    // --- pooled cosmetic bolts: one InstancedMesh, zero per-shot allocation ---
    const boltGeo = this.ownG(new THREE.SphereGeometry(0.22, 8, 6))
    boltGeo.scale(0.7, 0.7, 2.0) // stretched tracer look (baked, was mesh.scale)
    const boltMat = this.own(new THREE.MeshBasicMaterial({ color: config.palette.orange, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const poolN = low ? 8 : 14
    this.boltsMesh = new THREE.InstancedMesh(boltGeo, boltMat, poolN)
    this.boltsMesh.frustumCulled = false
    this.group.add(this.boltsMesh)
    for (let i = 0; i < poolN; i++) {
      // Park inactive instances at zero scale so they never draw a visible bolt.
      this.mat4.makeScale(0, 0, 0)
      this.boltsMesh.setMatrixAt(i, this.mat4)
      this.bolts.push({
        index: i,
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        vel: new THREE.Vector3(),
        life: 0,
        knocked: false,
        active: false,
      })
    }
    this.boltsMesh.instanceMatrix.needsUpdate = true

    this.group.visible = false
    scene.add(this.group)
  }

  /** Write a turret's current head pose (yaw + tilt at its fixed position). */
  private writeHead(t: Turret) {
    this.qScratch.setFromEuler(EULER_SCRATCH.set(t.tilt, t.yaw, 0, 'YXZ'))
    this.vScratch.copy(t.headPos)
    this.mat4.compose(this.vScratch, this.qScratch, this.sScratch)
    this.headShells.setMatrixAt(t.index, this.mat4)
    this.cores.setMatrixAt(t.index, this.mat4)
  }

  /** Netted/blasted: go dark, stop firing, schedule a rebuild, pay the bounty. */
  private onCaptured(t: Turret): number {
    if (t.destroyed) return 0
    t.destroyed = true
    t.cap.alive = false
    t.charge = 0
    t.fireCd = 0
    t.tilt = -0.5 // barrel droops dead
    this.writeHead(t)
    this.headShells.instanceMatrix.needsUpdate = true
    this.cores.instanceMatrix.needsUpdate = true
    this.cores.setColorAt(t.index, this.cScratch.setRGB(0.12, 0.05, 0.02)) // core goes cold
    if (this.cores.instanceColor) this.cores.instanceColor.needsUpdate = true
    t.rebuild = 8 + Math.random() * 4
    return 45
  }

  /** Relight a rebuilt turret back to working order. */
  private restore(t: Turret) {
    t.destroyed = false
    t.tilt = 0
    t.charge = 0
    t.fireCd = 0
    t.cap.alive = this.zone === 'earth'
    this.writeHead(t)
    this.headShells.instanceMatrix.needsUpdate = true
    this.cores.instanceMatrix.needsUpdate = true
    this.cores.setColorAt(t.index, this.cScratch.setHex(config.palette.orange))
    if (this.cores.instanceColor) this.cores.instanceColor.needsUpdate = true
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
      let dirty = false
      for (const b of this.bolts) {
        if (b.active) {
          b.active = false
          this.mat4.makeScale(0, 0, 0)
          this.boltsMesh.setMatrixAt(b.index, this.mat4)
          dirty = true
        }
      }
      if (dirty) this.boltsMesh.instanceMatrix.needsUpdate = true
      return
    }

    const focus = this.deps.focus()

    let headDirty = false
    let colorDirty = false
    for (const t of this.turrets) {
      if (t.destroyed) {
        t.rebuild -= dt
        if (t.rebuild <= 0) { this.restore(t); headDirty = true; colorDirty = true }
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
      this.writeHead(t)
      headDirty = true

      // Telegraph: brighten + pulse the core while locked, ease back otherwise.
      t.charge += ((locked ? 1 : 0) - t.charge) * Math.min(1, dt * 4)
      const pulse = locked ? 0.5 + 0.5 * Math.sin(performance.now() * 0.012) : 0
      const glow = 0.25 + t.charge * (0.9 + pulse * 0.6)
      this.cores.setColorAt(t.index, this.cScratch.setRGB(Math.min(1, glow), Math.min(0.55, glow * 0.5), 0.08))
      colorDirty = true

      // Fire a pooled bolt on cadence once locked + warmed up.
      if (locked && t.charge > 0.7 && t.fireCd <= 0) {
        this.fire(t, focus)
        t.fireCd = FIRE_CD
      }
    }
    if (headDirty) {
      this.headShells.instanceMatrix.needsUpdate = true
      this.cores.instanceMatrix.needsUpdate = true
    }
    if (colorDirty && this.cores.instanceColor) this.cores.instanceColor.needsUpdate = true

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
    b.pos.copy(this.muzzle)
    b.quat.setFromUnitVectors(FORWARD, this.toTarget) // stretch along travel
    this.writeBolt(b)
    this.boltsMesh.instanceMatrix.needsUpdate = true
  }

  /** Push a bolt's current pose into its instance slot. */
  private writeBolt(b: Bolt) {
    this.mat4.compose(b.pos, b.quat, this.sScratch)
    this.boltsMesh.setMatrixAt(b.index, this.mat4)
  }

  /** Advance live bolts; nudge the player on a near-miss, then retire. */
  private stepBolts(dt: number, focus: THREE.Vector3) {
    let dirty = false
    for (const b of this.bolts) {
      if (!b.active) continue
      b.life -= dt
      b.pos.addScaledVector(b.vel, dt)

      if (!b.knocked) {
        const dx = b.pos.x - focus.x
        const dy = b.pos.y - (focus.y + 1)
        const dz = b.pos.z - focus.z
        if (dx * dx + dy * dy + dz * dz < HIT_R * HIT_R) {
          // Knock the player AWAY from the turret along the bolt's travel.
          const vl = b.vel.length()
          const inv = vl > 0.001 ? 1 / vl : 0
          this.deps.onZap(b.vel.x * inv * 5, b.vel.z * inv * 5, 4)
          b.knocked = true
          b.life = Math.min(b.life, 0.06) // wink out just after the hit
        }
      }

      if (b.life <= 0) {
        b.active = false
        this.mat4.makeScale(0, 0, 0) // park: zero-scale instances never draw
        this.boltsMesh.setMatrixAt(b.index, this.mat4)
      } else {
        this.writeBolt(b)
      }
      dirty = true
    }
    if (dirty) this.boltsMesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    this.pylons.dispose()
    this.collars.dispose()
    this.headShells.dispose()
    this.cores.dispose()
    this.boltsMesh.dispose()
  }
}

/** Module-level constant unit forward (bolt mesh local +Z), no per-shot alloc. */
const FORWARD = new THREE.Vector3(0, 0, 1)
/** Reused Euler for head pose composition (YXZ: yaw then droop), no per-frame alloc. */
const EULER_SCRATCH = new THREE.Euler()
