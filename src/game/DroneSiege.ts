import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'
import type { Capturable } from './Game'

/**
 * Opt-in wave-defense challenge. A glowing siege beacon stands in the city; walk
 * into it to trigger escalating waves of hostile attack drones that converge on
 * the player and chase at head height. Each drone is a Capturable, so the existing
 * net/missiles destroy them for a bounty - clear a wave for a breather, survive
 * every wave for a big credit + XP payout. Pooled, repeatable, Earth only.
 */

interface Deps {
  /** Player position (spawn ring center + chase target). */
  focus: () => THREE.Vector3
  /** Ground height under a point (beacon placement + drone hover). */
  groundY: (x: number, z: number) => number
  /** Paid on a full siege clear: (credits, xp). */
  onReward: (credits: number, xp: number) => void
  /** HUD banner for state changes (announce / wave cleared / victory). */
  banner: (text: string) => void
  /** Floating popup at a point (kills, payout). */
  notify: (x: number, y: number, z: number, label: string, color: string) => void
}

type SiegeState = 'idle' | 'announce' | 'wave' | 'lull' | 'victory'

interface SiegeDrone {
  cap: Capturable
  pos: THREE.Vector3 // shared with cap.position
  vel: THREE.Vector3
  bob: number
  spin: number
  active: boolean // part of the current wave's live set
  // Live transform, written each frame; consumed when composing instance matrices.
  rotY: number
  rotZ: number
  eyeColor: THREE.Color // per-drone eye pulse, pushed to the eye InstancedMesh
}

const BEACON = new THREE.Vector3(0, 0, 22) // siege beacon location on Earth
const BEACON_R = 3.5 // walk into this radius to start
const SPAWN_RING = 34 // drones spawn on a ring this far from the player
const CHASE_SPEED = 12
const HOVER = 4 // rest hover above ground
const CONTACT = 2.4 // contact nudge range
const COOLDOWN = 30 // seconds before the beacon re-arms after a clear
const KILL_BOUNTY = 25

export class DroneSiege implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private drones: SiegeDrone[] = []
  private zone: Zone = 'earth'

  // --- lazily-built drone wave pool ---
  // Built on the first siege activation, removed + disposed when the siege ends,
  // so the idle scene holds only the beacon. When live, the whole wave renders as
  // three InstancedMeshes (bodies, eyes, fins) instead of one Group per drone.
  private poolSize: number
  private bodyGeo: THREE.OctahedronGeometry
  private finGeo: THREE.ConeGeometry
  private eyeGeo: THREE.SphereGeometry
  private bodyMat: THREE.MeshStandardMaterial
  private finMat: THREE.MeshStandardMaterial
  private eyeMat: THREE.MeshBasicMaterial
  private bodyInst: THREE.InstancedMesh | null = null
  private eyeInst: THREE.InstancedMesh | null = null
  private finInst: THREE.InstancedMesh | null = null
  // Static local offsets composed under each drone's live transform every frame.
  private eyeLocal = new THREE.Matrix4()
  private finLocals: THREE.Matrix4[] = []
  // scratch for instance-matrix composition - no per-frame allocation
  private mDrone = new THREE.Matrix4()
  private mInst = new THREE.Matrix4()
  private qDrone = new THREE.Quaternion()
  private eDrone = new THREE.Euler()
  private sOne = new THREE.Vector3(1, 1, 1)

  // Beacon visuals.
  private beacon = new THREE.Group()
  private beaconCoreMat: THREE.MeshBasicMaterial
  private beaconRingMat: THREE.MeshBasicMaterial

  // State machine.
  private state: SiegeState = 'idle'
  private waves: number[] // per-wave drone counts
  private wave = 0 // index into waves
  private alive = 0 // live drones remaining in the current wave
  private timer = 0 // generic phase timer (announce / lull / victory hold)
  private cooldown = 0 // >0 while the beacon is re-arming after a clear
  private pulse = 0 // beacon idle pulse phase

  // scratch - reused every frame, no per-frame allocation
  private toPlayer = new THREE.Vector3()
  private desired = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, capturables: Capturable[], private deps: Deps) {
    const low = config.tier.name === 'low'
    // Fewer, smaller waves on mobile; bigger escalation on desktop.
    this.waves = low ? [3, 5, 7] : [3, 5, 7, 9]
    this.poolSize = this.waves[this.waves.length - 1]

    // --- beacon: a pillar + core + ground ring, placed on the city floor ---
    const pillarGeo = this.ownG(new THREE.CylinderGeometry(0.5, 0.7, 4, 10))
    const coreGeo = this.ownG(new THREE.IcosahedronGeometry(0.9, 0))
    const ringGeo = this.ownG(new THREE.RingGeometry(BEACON_R - 0.25, BEACON_R, 32))
    const pillarMat = this.own(new THREE.MeshStandardMaterial({ color: 0x202632, metalness: 0.8, roughness: 0.4, emissive: 0x1a0606, emissiveIntensity: 0.5 }))
    this.beaconCoreMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff4422, fog: false }))
    this.beaconRingMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))

    const pillar = new THREE.Mesh(pillarGeo, pillarMat); pillar.position.y = 2; this.beacon.add(pillar)
    const core = new THREE.Mesh(coreGeo, this.beaconCoreMat); core.position.y = 4.4; this.beacon.add(core)
    const ring = new THREE.Mesh(ringGeo, this.beaconRingMat); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06; this.beacon.add(ring)
    const gy = this.deps.groundY(BEACON.x, BEACON.z)
    this.beacon.position.set(BEACON.x, gy, BEACON.z)
    this.group.add(this.beacon)

    // --- shared drone geometry/materials (built once, reused across activations) ---
    // The geometry + materials persist for the system's lifetime (cheap, reused on
    // every siege). Only the InstancedMeshes that hold them are built and torn down
    // per siege, so the idle scene is just the beacon.
    this.bodyGeo = this.ownG(new THREE.OctahedronGeometry(0.55, 0))
    this.finGeo = this.ownG(new THREE.ConeGeometry(0.16, 0.7, 4))
    this.eyeGeo = this.ownG(new THREE.SphereGeometry(0.2, 10, 8))
    this.bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x14171d, metalness: 0.85, roughness: 0.3, emissive: 0x180404, emissiveIntensity: 0.5 }))
    this.finMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a2f3a, metalness: 0.75, roughness: 0.4 }))
    // White base so each drone's per-instance eye color drives the pulse directly,
    // reproducing the old per-drone eye material exactly.
    this.eyeMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }))

    // Static local transforms for the eye + the four fins (identical to the old per-drone Group layout).
    this.eyeLocal.compose(new THREE.Vector3(0, 0.05, 0.5), new THREE.Quaternion(), this.sOne)
    for (let f = 0; f < 4; f++) {
      const a = (f / 4) * Math.PI * 2
      const m = new THREE.Matrix4()
      m.compose(
        new THREE.Vector3(Math.cos(a) * 0.6, 0, Math.sin(a) * 0.6),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a, Math.PI / 2, 'XYZ')),
        this.sOne,
      )
      this.finLocals.push(m)
    }

    for (let i = 0; i < this.poolSize; i++) {
      const pos = new THREE.Vector3()
      const drone: SiegeDrone = {
        pos,
        vel: new THREE.Vector3(),
        bob: Math.random() * Math.PI * 2,
        spin: Math.random() * Math.PI * 2,
        active: false,
        rotY: 0,
        rotZ: 0,
        eyeColor: new THREE.Color(0xff3322),
        cap: { position: pos, alive: false, capture: () => this.onCaptured(drone) },
      }
      this.drones.push(drone)
      capturables.push(drone.cap)
    }

    this.group.visible = false
    scene.add(this.group)
  }

  /**
   * Lazily build the wave pool: three InstancedMeshes (bodies, eyes, fins) added to
   * the group. Idempotent - a no-op if already built. Called when a siege activates.
   */
  private buildPool() {
    if (this.bodyInst) return
    const n = this.poolSize
    this.bodyInst = new THREE.InstancedMesh(this.bodyGeo, this.bodyMat, n)
    this.eyeInst = new THREE.InstancedMesh(this.eyeGeo, this.eyeMat, n)
    this.finInst = new THREE.InstancedMesh(this.finGeo, this.finMat, n * 4)
    for (const im of [this.bodyInst, this.eyeInst, this.finInst]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false // wave can wrap behind the camera while chasing
      this.group.add(im)
    }
    // Per-instance eye color so each drone pulses independently.
    this.eyeInst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
    this.syncInstances() // place everything before the first render
  }

  /** Remove + dispose the lazily-built InstancedMeshes (shared geo/mat are kept). */
  private destroyPool() {
    for (const im of [this.bodyInst, this.eyeInst, this.finInst]) {
      if (!im) continue
      this.group.remove(im)
      im.dispose() // frees the InstancedMesh's instance buffers, not the shared geo/mat
    }
    this.bodyInst = null
    this.eyeInst = null
    this.finInst = null
  }

  /** Push every active drone's transform + eye color into the instance buffers. */
  private syncInstances() {
    const body = this.bodyInst, eye = this.eyeInst, fin = this.finInst
    if (!body || !eye || !fin) return
    for (let i = 0; i < this.drones.length; i++) {
      const d = this.drones[i]
      if (d.active) {
        this.eDrone.set(0, d.rotY, d.rotZ, 'XYZ')
        this.qDrone.setFromEuler(this.eDrone)
        this.mDrone.compose(d.pos, this.qDrone, this.sOne)
      } else {
        // Park inactive instances at the origin scaled to zero so they vanish.
        this.mDrone.makeScale(0, 0, 0)
      }
      body.setMatrixAt(i, this.mDrone)

      this.mInst.multiplyMatrices(this.mDrone, this.eyeLocal)
      eye.setMatrixAt(i, this.mInst)
      eye.setColorAt(i, d.eyeColor)

      for (let f = 0; f < 4; f++) {
        this.mInst.multiplyMatrices(this.mDrone, this.finLocals[f])
        fin.setMatrixAt(i * 4 + f, this.mInst)
      }
    }
    body.instanceMatrix.needsUpdate = true
    eye.instanceMatrix.needsUpdate = true
    fin.instanceMatrix.needsUpdate = true
    if (eye.instanceColor) eye.instanceColor.needsUpdate = true
  }

  /** Netted/blasted: destroy the drone, decrement the wave count, pay a bounty. */
  private onCaptured(d: SiegeDrone): number {
    if (!d.active) return 0
    d.active = false
    d.cap.alive = false
    d.vel.set(0, 0, 0)
    this.deps.notify(d.pos.x, d.pos.y + 0.6, d.pos.z, `+${KILL_BOUNTY}c`, '#ff7a3a')
    this.alive--
    return KILL_BOUNTY
  }

  /** Spawn `count` drones on a ring around the player and arm the wave. */
  private startWave() {
    this.buildPool() // ensure the instanced pool exists before drones go live
    const focus = this.deps.focus()
    const count = this.waves[this.wave]
    this.alive = 0
    let spawned = 0
    for (const d of this.drones) {
      if (spawned >= count) break
      const a = (spawned / count) * Math.PI * 2 + Math.random() * 0.4
      const x = focus.x + Math.cos(a) * SPAWN_RING
      const z = focus.z + Math.sin(a) * SPAWN_RING
      d.pos.set(x, this.deps.groundY(x, z) + HOVER + 2, z)
      d.vel.set(0, 0, 0)
      d.rotY = 0
      d.rotZ = d.spin
      d.active = true
      d.cap.alive = true
      spawned++
      this.alive++
    }
    this.syncInstances()
    this.state = 'wave'
    this.deps.banner(`WAVE ${this.wave + 1} / ${this.waves.length}`)
  }

  /** Deactivate every drone and clear the live wave (zone exit / reset). */
  private clearDrones() {
    for (const d of this.drones) {
      d.active = false
      d.cap.alive = false
      d.vel.set(0, 0, 0)
    }
    this.alive = 0
  }

  /** Stop any in-progress siege and return to a re-armable idle (pool torn down). */
  private abort() {
    this.clearDrones()
    this.destroyPool()
    this.state = 'idle'
    this.wave = 0
    this.timer = 0
    this.cooldown = 0
  }

  setZone(zone: Zone) {
    this.zone = zone
    const on = zone === 'earth'
    this.group.visible = on
    if (!on) this.abort()
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return

    if (this.cooldown > 0) this.cooldown -= dt
    this.pulse += dt

    // Beacon look: slow cool pulse when idle, hot glow during a siege.
    // reducedMotion (read live): soften the siege strobe from 6 rad/s to a calm
    // 3 rad/s and shrink the pulse amplitude, keeping the beacon bright/findable.
    const sieging = this.state !== 'idle'
    const siegeRate = config.reducedMotion ? 3 : 6
    const heatAmp = config.reducedMotion ? 0.2 : 0.4
    const ringAmp = config.reducedMotion ? 0.12 : 0.25
    const heat = sieging ? 1.5 + heatAmp * Math.sin(this.pulse * siegeRate) : 0.6 + 0.25 * Math.sin(this.pulse * 1.6)
    this.beaconCoreMat.color.setRGB(Math.min(1, heat), Math.min(0.35, heat * 0.16), 0.12)
    this.beaconRingMat.opacity = sieging ? 0.55 + ringAmp * Math.sin(this.pulse * siegeRate) : 0.35 + 0.15 * Math.sin(this.pulse * 1.6)

    const focus = this.deps.focus()

    // --- state machine ---
    switch (this.state) {
      case 'idle': {
        if (this.cooldown <= 0) {
          const dx = focus.x - BEACON.x, dz = focus.z - BEACON.z
          if (dx * dx + dz * dz < BEACON_R * BEACON_R) {
            this.state = 'announce'
            this.timer = 1.8
            this.wave = 0
            this.deps.banner('SIEGE INCOMING')
          }
        }
        break
      }
      case 'announce': {
        this.timer -= dt
        if (this.timer <= 0) this.startWave()
        break
      }
      case 'wave': {
        this.updateDrones(dt, focus)
        if (this.alive <= 0) {
          this.wave++
          if (this.wave >= this.waves.length) {
            // All waves down: pay out, scaled with wave count.
            const credits = 300 + this.waves.length * 120
            const xp = 150 + this.waves.length * 60
            this.deps.onReward(credits, xp)
            this.deps.notify(BEACON.x, this.beacon.position.y + 5.4, BEACON.z, `+${credits}c`, '#ffd24a')
            this.deps.banner(`SIEGE CLEARED  +${credits}c`)
            this.state = 'victory'
            this.timer = 2.6
          } else {
            this.deps.banner(`WAVE ${this.wave} CLEARED`)
            this.state = 'lull'
            this.timer = 3
          }
        }
        break
      }
      case 'lull': {
        this.timer -= dt
        if (this.timer <= 0) this.startWave()
        break
      }
      case 'victory': {
        this.timer -= dt
        if (this.timer <= 0) {
          this.state = 'idle'
          this.wave = 0
          this.cooldown = COOLDOWN
          this.destroyPool() // siege over: drop back to just the beacon
        }
        break
      }
    }
  }

  /** Advance the live wave's drones: fly in, chase, bob/spin, contact nudge. */
  private updateDrones(dt: number, focus: THREE.Vector3) {
    for (const d of this.drones) {
      if (!d.active) continue
      d.bob += dt
      d.spin += dt * 4

      this.toPlayer.copy(focus).sub(d.pos)
      const distSq = this.toPlayer.x * this.toPlayer.x + this.toPlayer.z * this.toPlayer.z
      const dist = Math.sqrt(distSq)

      // Close in on the player.
      this.desired.set(this.toPlayer.x, 0, this.toPlayer.z)
      if (dist > 0.001) this.desired.multiplyScalar(CHASE_SPEED / dist)
      else this.desired.set(0, 0, 0)

      // Contact nudge: a soft repel so they don't all stack on one point.
      if (dist < CONTACT) this.desired.multiplyScalar(-0.4)

      const k = Math.min(1, dt * 3)
      d.vel.x += (this.desired.x - d.vel.x) * k
      d.vel.z += (this.desired.z - d.vel.z) * k
      d.pos.x += d.vel.x * dt
      d.pos.z += d.vel.z * dt

      // Hover at the player's head height (with a little bob).
      const ground = this.deps.groundY(d.pos.x, d.pos.z) + HOVER
      const target = Math.max(ground, focus.y + 1.2)
      d.pos.y += (target + Math.sin(d.bob * 2.4) * 0.2 - d.pos.y) * Math.min(1, dt * 4)

      // Facing + spin, recorded for instance-matrix composition (toPlayer is the
      // pre-move heading, matching the old per-drone group orientation).
      d.rotY = Math.atan2(this.toPlayer.x, this.toPlayer.z)
      d.rotZ = d.spin

      // Eye pulse: hot, hunting red.
      const glow = 1.5 + 0.4 * Math.sin(d.spin * 3)
      d.eyeColor.setRGB(Math.min(1, glow), Math.min(0.35, glow * 0.16), 0.12)
    }

    // Single pass to upload all live transforms + eye colors to the instance buffers.
    this.syncInstances()
  }

  dispose() {
    this.destroyPool()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
