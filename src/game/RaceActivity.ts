// RaceActivity - a time-trial you can run on foot or (better) in any vehicle:
// reach the START gate near spawn, then blast through the glowing checkpoint rings
// in order before the clock stops at the finish. Beat your best time for credits
// + XP. Self-contained and course-driven: one instance per zone (the neon city
// circuit on Earth, low-gravity courses on the Moon/Mars). The next ring always
// glows brightest so the route reads at a glance.

import * as THREE from 'three'
import { config } from './config'
import { loadBestTime, saveBestTime } from './storage'

export interface RaceHud {
  state: 'idle' | 'countdown' | 'racing' | 'done'
  cp: number
  total: number
  time: number
  best: number
  countdown: number
  result: number // finish time on the 'done' frame
  near: boolean // player is at the start gate (idle) - show the "drive through to race" hint
}

/** A self-contained course: which zone it lives in, the start gate, the ordered
 *  checkpoints, persistence key and rewards. Earth's values reproduce the original
 *  city circuit exactly; the off-world courses reuse the same machinery. */
export interface RaceCourse {
  zone: string
  gate: [number, number]
  circuit: Array<[number, number]>
  storageKey: string
  accent: number // ring + gate colour (zone-themed)
  baseCredits: number
  bestBonus: number
  xp: number
}

interface Ring {
  pos: THREE.Vector3
  group: THREE.Group
  mat: THREE.MeshBasicMaterial
}

const DETECT = 8 // xz distance to "hit" a ring / the gate

export class RaceActivity {
  private scene: THREE.Scene
  private group = new THREE.Group()
  private rings: Ring[] = []
  private gateMat: THREE.MeshBasicMaterial
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private sampleGround: (x: number, z: number) => number
  private course: RaceCourse
  private gate: THREE.Vector3
  // Geometry is built lazily on first activation: off-world terrain isn't the
  // active physics surface at boot (it's generated on first travel), so the rings
  // must sample the ground only once their zone is live.
  private built = false

  private state: RaceHud['state'] = 'idle'
  private cp = 0
  private time = 0
  private countdown = 0
  private best: number
  private result = 0
  private cooldown = 0
  private stray = 0

  /** Granted on a finish: (credits, xp, isBest). */
  onFinish?: (credits: number, xp: number, isBest: boolean) => void
  onSfx?: (kind: 'start' | 'cp' | 'finish') => void

  constructor(scene: THREE.Scene, sampleGround: (x: number, z: number) => number, course: RaceCourse) {
    this.scene = scene
    this.sampleGround = sampleGround
    this.course = course
    this.gate = new THREE.Vector3(course.gate[0], 0, course.gate[1])
    this.best = loadBestTime(course.storageKey)
    this.gateMat = this.own(new THREE.MeshBasicMaterial({ color: config.palette.lime, fog: false }))
    this.group.visible = false
    scene.add(this.group)
  }

  /** Which zone this course belongs to (so the orchestrator can pick the active one). */
  get zone(): string { return this.course.zone }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  /** Show/hide for the active zone, building the geometry the first time its zone
   *  becomes active (when the matching terrain is the live physics surface). */
  setActive(zone: string) {
    const on = zone === this.course.zone
    if (on && !this.built) this.build()
    this.group.visible = on
    if (!on && this.state !== 'idle') this.reset()
  }

  private build() {
    this.buildGate()
    for (const [x, z] of this.course.circuit) this.buildRing(x, z)
    this.refreshRingGlow()
    this.built = true
  }

  private buildGate() {
    const y = this.sampleGround(this.gate.x, this.gate.z)
    const g = new THREE.Group()
    g.position.set(this.gate.x, y, this.gate.z)
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x0a1018, emissive: config.palette.lime, emissiveIntensity: 1.6, roughness: 0.5 }))
    for (const sx of [-6, 6]) {
      const post = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.8, 9, 0.8)), postMat)
      post.position.set(sx, 4.5, 0)
      g.add(post)
    }
    const bar = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(13, 1.4, 0.6)), this.gateMat)
    bar.position.set(0, 9, 0)
    g.add(bar)
    this.group.add(g)
  }

  private buildRing(x: number, z: number) {
    const y = this.sampleGround(x, z)
    const group = new THREE.Group()
    group.position.set(x, y + 5, z)
    const mat = this.own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, transparent: true, opacity: 0.9, fog: false }))
    const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(5, 0.45, 10, 28)), mat)
    group.add(ring)
    this.group.add(group)
    this.rings.push({ pos: new THREE.Vector3(x, y, z), group, mat })
  }

  /** Brighten the next ring, dim the rest (or all when idle). */
  private refreshRingGlow() {
    for (let i = 0; i < this.rings.length; i++) {
      const next = this.state === 'racing' && i === this.cp
      const done = this.state === 'racing' && i < this.cp
      this.rings[i].mat.color.setHex(next ? config.palette.lime : done ? 0x294055 : this.course.accent)
      this.rings[i].mat.opacity = next ? 1 : done ? 0.3 : 0.8
      this.rings[i].group.scale.setScalar(next ? 1.08 : 1)
    }
  }

  private reset() {
    this.state = 'idle'
    this.cp = 0
    this.time = 0
    this.countdown = 0
    this.refreshRingGlow()
  }

  /** Drive the race from the player's ground position. Returns HUD state. */
  update(dt: number, px: number, pz: number): RaceHud {
    this.cooldown = Math.max(0, this.cooldown - dt)
    const distGate = Math.hypot(px - this.gate.x, pz - this.gate.z)
    // Spin the rings a little for life.
    for (const r of this.rings) r.group.rotation.z += dt * 0.6

    if (this.state === 'idle') {
      if (this.cooldown <= 0 && distGate < DETECT) {
        this.state = 'countdown'
        this.countdown = 3
        this.onSfx?.('start')
      }
    } else if (this.state === 'countdown') {
      this.countdown -= dt
      if (this.countdown <= 0) {
        this.state = 'racing'
        this.cp = 0
        this.time = 0
        this.refreshRingGlow()
      }
    } else if (this.state === 'racing') {
      this.time += dt
      const ring = this.rings[this.cp]
      if (ring && Math.hypot(px - ring.pos.x, pz - ring.pos.z) < DETECT) {
        this.cp++
        this.onSfx?.('cp')
        this.refreshRingGlow()
      }
      if (this.cp >= this.rings.length) {
        // Final leg: back through the start/finish gate.
        if (distGate < DETECT) this.finish()
      }
      // Abandon if the player strays far from the next target for a while (left
      // the race) instead of leaving the clock running forever.
      const tgt = this.cp >= this.rings.length ? this.gate : this.rings[this.cp].pos
      const off = Math.hypot(px - tgt.x, pz - tgt.z) > 120
      this.stray = off ? this.stray + dt : 0
      if (this.stray > 8 || this.time > 240) { this.stray = 0; this.reset() }
    } else if (this.state === 'done') {
      this.countdown -= dt
      if (this.countdown <= 0) this.reset()
    }

    return { state: this.state, cp: this.cp, total: this.rings.length, time: this.time, best: this.best, countdown: Math.max(0, this.countdown), result: this.result, near: this.state === 'idle' && this.cooldown <= 0 && distGate < 16 }
  }

  private finish() {
    this.result = this.time
    const isBest = this.best === 0 || this.time < this.best
    if (isBest) { this.best = Math.round(this.time * 10) / 10; saveBestTime(this.course.storageKey, this.time) }
    // A best run pays a bonus on top of the base finish reward.
    const credits = this.course.baseCredits + (isBest ? this.course.bestBonus : 0)
    this.onFinish?.(credits, this.course.xp, isBest)
    this.onSfx?.('finish')
    this.state = 'done'
    this.countdown = 4 // show the result banner a moment
    this.cooldown = 5 // don't immediately re-trigger at the gate
    this.refreshRingGlow()
  }

  dispose() {
    this.scene.remove(this.group)
    this.mats.forEach((m) => m.dispose())
    this.geos.forEach((g) => g.dispose())
  }
}
