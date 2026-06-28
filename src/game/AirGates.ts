import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

/**
 * AirGates: an aerial slalom skill challenge over the neon city. A flowing chain
 * of glowing ring gates floats high in the sky; the next gate to clear glows
 * bright, the rest dim. Fly through the bright one (jetpack / gravity-lifts) and
 * it advances, pulses, and pays a growing combo. Clear the whole chain inside a
 * timer for an escalating credit + XP payout; time out and it resets to gate one.
 * Earth only; repeatable after a short cooldown. Shared bright/dim mats, disposed.
 */

interface Deps {
  /** Player world position. */
  focus: () => THREE.Vector3
  /** Sampled ground height at an XZ, so each gate floats a fixed height above it. */
  groundY: (x: number, z: number) => number
  /** Award (credits, xp) and pop a floating label at a world point. */
  onScore: (credits: number, xp: number, x: number, y: number, z: number, label: string) => void
}

interface Gate {
  mesh: THREE.Mesh
  glow: THREE.Mesh
  pos: THREE.Vector3
}

const RING_R = 4 // ring radius (m)
const HIT = RING_R + 1 // clear radius (3D distance to gate centre)
const BRIGHT = 0x9bff4d // active/next gate
const DIM = 0x27e7ff // upcoming gates
const TIME_BASE = 7 // seconds granted at the start of an attempt
const TIME_BONUS = 4 // extra seconds added each time a gate is cleared
const COOLDOWN = 3 // pause after a full clear before the course re-arms

// Hand-authored slalom path as fractions of world.half, laid as a flowing
// arc/figure-eight across the city, with a rising-then-cresting height profile so
// the run climbs into the skyline. Final length is trimmed per tier.
const PATH: Array<[number, number, number]> = [
  [-0.62, 0.40, 22],
  [-0.30, -0.10, 30],
  [0.04, 0.34, 38],
  [0.40, -0.04, 46],
  [0.66, 0.40, 40],
  [0.34, 0.66, 32],
  [-0.06, 0.30, 44],
  [-0.46, -0.30, 26],
]

export class AirGates implements GameSystem {
  private group = new THREE.Group()
  private gates: Gate[] = []
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private brightMat: THREE.MeshBasicMaterial
  private dimMat: THREE.MeshBasicMaterial
  private zone: Zone = 'earth'

  private current = 0 // next gate to clear
  private chain = 0 // gates cleared this attempt (the combo)
  private timer = 0 // seconds left in the active attempt (<=0 when idle)
  private started = false // an attempt is live (gate 0 has been cleared)
  private cooldown = 0 // post-completion pause before re-arming
  private t = 0

  // Scratch reused every frame, never allocated in update().
  private readonly tmp = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 6 : 8
    const reach = config.world.half

    this.brightMat = this.own(new THREE.MeshBasicMaterial({ color: BRIGHT, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.dimMat = this.own(new THREE.MeshBasicMaterial({ color: DIM, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))

    const ringGeo = this.ownG(new THREE.TorusGeometry(RING_R, 0.4, 10, 28))
    const discGeo = this.ownG(new THREE.CircleGeometry(RING_R - 0.4, 24))
    const glowMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))

    const path = PATH.slice(0, n)
    for (let i = 0; i < path.length; i++) {
      const [fx, fz, h] = path[i]
      const x = fx * reach
      const z = fz * reach
      const y = this.deps.groundY(x, z) + h
      const pos = new THREE.Vector3(x, y, z)

      const mesh = new THREE.Mesh(ringGeo, this.dimMat)
      mesh.position.copy(pos)
      // Face roughly along the flight direction to the next gate so the ring
      // reads as a doorway on the course; the last gate inherits the prior aim.
      const next = path[i + 1]
      if (next) mesh.lookAt(next[0] * reach, this.deps.groundY(next[0] * reach, next[1] * reach) + next[2], next[1] * reach)
      else if (i > 0) mesh.quaternion.copy(this.gates[i - 1].mesh.quaternion)

      const glow = new THREE.Mesh(discGeo, glowMat)
      glow.quaternion.copy(mesh.quaternion)
      glow.position.copy(pos)

      this.group.add(mesh)
      this.group.add(glow)
      this.gates.push({ mesh, glow, pos })
    }

    this.refreshGlow()
    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  /** Brighten the current target gate, dim the rest. */
  private refreshGlow() {
    for (let i = 0; i < this.gates.length; i++) {
      this.gates[i].mesh.material = i === this.current ? this.brightMat : this.dimMat
    }
  }

  private resetChain() {
    this.current = 0
    this.chain = 0
    this.timer = 0
    this.started = false
    this.refreshGlow()
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt

    if (this.cooldown > 0) {
      this.cooldown -= dt
      // Keep the bright target pulsing through the pause so the course still reads.
      this.brightMat.opacity = 0.5 + 0.5 * Math.abs(Math.sin(this.t * 3))
      if (this.cooldown <= 0) this.resetChain()
      return
    }

    // The timer only runs once the player has committed by clearing gate 0.
    if (this.started) {
      this.timer -= dt
      if (this.timer <= 0) {
        // Window missed: drop the chain back to the start.
        const g = this.gates[0]
        this.deps.onScore(0, 0, g.pos.x, g.pos.y + 2, g.pos.z, 'TIME!')
        this.resetChain()
        return
      }
    }

    // Pulse the active gate so the route is obvious at a glance.
    const pulse = 0.6 + 0.4 * Math.abs(Math.sin(this.t * 3.4))
    this.brightMat.opacity = pulse
    const target = this.gates[this.current]
    if (target) target.mesh.scale.setScalar(1.04 + 0.04 * Math.sin(this.t * 3.4))

    const f = this.deps.focus()
    if (target) {
      this.tmp.copy(target.pos).sub(f)
      if (this.tmp.lengthSq() < HIT * HIT) {
        // Cleared the active gate: advance, grow the combo, pay out, extend time.
        this.current++
        this.chain++
        // First leg gets the full base window; later legs roll over leftover time
        // (capped at the base) plus a per-gate bonus, so speed is rewarded.
        const firstLeg = !this.started
        this.started = true
        this.timer = (firstLeg ? TIME_BASE : Math.min(this.timer, TIME_BASE)) + TIME_BONUS
        const credits = 25 * this.chain
        this.deps.onScore(credits, Math.round(credits * 0.5), target.pos.x, target.pos.y + 1.5, target.pos.z, `+${credits}c`)
        target.mesh.scale.setScalar(1.6) // a brief pop, eased back below

        if (this.current >= this.gates.length) {
          // Whole chain cleared inside the window: escalating completion bonus.
          const bonus = 200 * this.chain
          this.deps.onScore(bonus, Math.round(bonus * 0.5), f.x, f.y + 2, f.z, `COURSE CLEAR x${this.chain}!`)
          this.current = this.gates.length // hold (no bright target) during the pause
          this.cooldown = COOLDOWN
        }
        this.refreshGlow()
      }
    }

    // Ease any per-clear pop back toward rest so rings settle between hits.
    for (let i = 0; i < this.gates.length; i++) {
      const s = this.gates[i].mesh.scale.x
      if (i !== this.current && s > 1.001) this.gates[i].mesh.scale.setScalar(Math.max(1, s - dt * 3))
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
