import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so strikes always land in view around wherever you are. */
  focus: () => THREE.Vector3
  /** Ground height under a point in the current zone. */
  groundY: (x: number, z: number) => number
  /** Expanding ground ring FX via Game (missiles.shockwave). */
  shockwave: (x: number, y: number, z: number) => void
}

/**
 * Off-world spectacle (Moon + Mars only): on a random timer a meteor streaks down
 * and slams the airless surface near you. A pulsing target ring telegraphs the
 * impact, then a glowing rock falls fast and hits - shockwave ring, additive
 * flash, a burst of pooled debris, and a scorch decal that fades over ~2s. Pure
 * atmosphere, no damage. Everything is pooled and disposed together; zone-gated
 * so Earth (which has its own sky meteor shower) never sees it.
 */

// Strike phases.
const IDLE = 0
const TELEGRAPH = 1
const FALL = 2
const AFTER = 3

const TELEGRAPH_TIME = 1.2 // pulsing ring before the rock falls
const FALL_HEIGHT = 120 // spawn height of the meteor
const FALL_SPEED = 220 // units/sec straight down (Earth-gravity baseline; scaled by zone)
const SCORCH_TIME = 2.0 // scorch fade window
const DEBRIS_LIFE = 1.1 // seconds debris flies + falls
const EARTH_G = Math.abs(config.zones.earth.gravity) // reference for scaling off-world fall feel

interface Strike {
  phase: number
  timer: number // phase countdown
  x: number
  z: number
  gy: number // ground height at impact
  // visuals
  target: THREE.Mesh // telegraph ring on the ground
  targetMat: THREE.MeshBasicMaterial
  meteor: THREE.Mesh // falling rock
  trail: THREE.Mesh // additive trail behind the rock
  flash: THREE.Sprite // impact flash
  scorch: THREE.Mesh // ground scorch decal
  scorchMat: THREE.MeshBasicMaterial
  debris: THREE.Mesh[]
  debrisVel: Float32Array // 3 per debris bit
  scorchLife: number // counts down through AFTER
  flashLife: number
}

export class MeteorStrikes implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private tex: THREE.Texture[] = []
  private strikes: Strike[] = []
  private zone: Zone = 'earth'
  // Cached per-zone gravity (magnitude) and the matching fall-speed scale, both
  // refreshed on setZone so the per-frame loop stays O(1). Off-world meteors and
  // debris fall under the local zone's lighter gravity instead of Earth speed.
  private gravity = EARTH_G
  private fallScale = 1
  private timer = 3 // countdown to the next strike
  private debrisN: number
  // Scratch reused each impact so we never allocate per strike.
  private scratchPos = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const pool = low ? 1 : 2
    this.debrisN = low ? 4 : 7

    // --- shared geometry (instanced per-strike meshes share these) ---
    const ringGeo = this.ownG(new THREE.RingGeometry(1.4, 2.0, 28))
    const scorchGeo = this.ownG(new THREE.CircleGeometry(2.4, 24))
    const rockGeo = this.ownG(new THREE.IcosahedronGeometry(0.8, 0))
    const trailGeo = this.ownG(new THREE.ConeGeometry(0.7, 6, 8))
    const debrisGeo = this.ownG(new THREE.IcosahedronGeometry(0.28, 0))
    const flashTex = this.glowTexture()

    for (let i = 0; i < pool; i++) {
      const targetMat = this.own(new THREE.MeshBasicMaterial({
        color: 0xffb84a, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide,
      }))
      const target = new THREE.Mesh(ringGeo, targetMat)
      target.rotation.x = -Math.PI / 2
      target.visible = false

      const rockMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffd6a0, fog: false }))
      const meteor = new THREE.Mesh(rockGeo, rockMat)
      meteor.visible = false

      const trailMat = this.own(new THREE.MeshBasicMaterial({
        color: 0xff9a3a, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }))
      const trail = new THREE.Mesh(trailGeo, trailMat) // points up; sits above the rock
      trail.position.y = 3
      meteor.add(trail)

      const flashMat = new THREE.SpriteMaterial({
        map: flashTex, color: 0xfff0d0, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      })
      this.mats.push(flashMat)
      const flash = new THREE.Sprite(flashMat)
      flash.visible = false

      const scorchMat = this.own(new THREE.MeshBasicMaterial({
        color: 0xff5a1e, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide,
      }))
      const scorch = new THREE.Mesh(scorchGeo, scorchMat)
      scorch.rotation.x = -Math.PI / 2
      scorch.visible = false

      const debris: THREE.Mesh[] = []
      const debrisMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffb066, fog: false }))
      for (let d = 0; d < this.debrisN; d++) {
        const bit = new THREE.Mesh(debrisGeo, debrisMat)
        bit.visible = false
        debris.push(bit)
        this.group.add(bit)
      }

      this.group.add(target, meteor, flash, scorch)

      this.strikes.push({
        phase: IDLE, timer: 0, x: 0, z: 0, gy: 0,
        target, targetMat, meteor, trail, flash, scorch, scorchMat,
        debris, debrisVel: new Float32Array(this.debrisN * 3),
        scorchLife: 0, flashLife: 0,
      })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  /** Soft radial glow sprite texture for the impact flash. */
  private glowTexture(): THREE.Texture {
    const s = 64
    const c = document.createElement('canvas')
    c.width = c.height = s
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.3, 'rgba(255,230,180,0.8)')
    g.addColorStop(1, 'rgba(255,200,120,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, s, s)
    const t = new THREE.CanvasTexture(c)
    this.tex.push(t)
    return t
  }

  setZone(zone: Zone) {
    this.zone = zone
    // Read the zone's gravity (config stores it negative; we want magnitude) the
    // same way MeteorShower does, and derive a sqrt fall-speed scale so a 1/6-G
    // body makes meteors drift down ~40% as fast rather than 1/6 as fast (sqrt
    // keeps the slow-motion drift readable instead of glacial).
    this.gravity = Math.abs(config.zones[zone].gravity)
    this.fallScale = Math.sqrt(this.gravity / EARTH_G)
    const active = zone === 'moon' || zone === 'mars'
    this.group.visible = active
    if (!active) this.resetAll()
  }

  /** Send every strike back to idle and hide its visuals. */
  private resetAll() {
    for (const s of this.strikes) this.reset(s)
    this.timer = 3
  }

  private reset(s: Strike) {
    s.phase = IDLE
    s.target.visible = false
    s.meteor.visible = false
    s.flash.visible = false
    s.scorch.visible = false
    for (const b of s.debris) b.visible = false
  }

  /** Arm a free strike: pick an impact point near the player and telegraph it. */
  private begin() {
    const s = this.strikes.find((x) => x.phase === IDLE)
    if (!s) return
    const f = this.deps.focus()

    const ang = Math.random() * Math.PI * 2
    const dist = 30 + Math.random() * 40
    const x = f.x + Math.cos(ang) * dist
    const z = f.z + Math.sin(ang) * dist
    const gy = this.deps.groundY(x, z)

    s.x = x
    s.z = z
    s.gy = gy
    s.phase = TELEGRAPH
    s.timer = TELEGRAPH_TIME

    s.target.position.set(x, gy + 0.06, z)
    s.target.scale.setScalar(1)
    s.targetMat.opacity = 0
    s.target.visible = true
  }

  /** Impact: shockwave, flash, debris burst, and an arming scorch decal. */
  private impact(s: Strike) {
    const { x, z, gy } = s
    s.meteor.visible = false
    s.phase = AFTER

    this.deps.shockwave(x, gy + 0.2, z)

    s.flash.position.set(x, gy + 1.2, z)
    // reducedMotion: soften the bright impact pop - smaller, dimmer flash so it
    // doesn't hard-flash. Live-read the flag (player can toggle at runtime).
    const flashPeak = config.reducedMotion ? 0.35 : 1
    const flashScale = config.reducedMotion ? 7 : 10
    s.flash.scale.setScalar(flashScale)
    s.flash.material.opacity = flashPeak
    s.flashLife = 0.35
    s.flash.visible = true

    s.scorch.position.set(x, gy + 0.05, z)
    // reducedMotion: dim the additive scorch glow (it blooms bright on impact).
    s.scorchMat.opacity = config.reducedMotion ? 0.9 * 0.35 : 0.9
    s.scorch.visible = true
    s.scorchLife = SCORCH_TIME

    for (let d = 0; d < this.debrisN; d++) {
      const bit = s.debris[d]
      const a = Math.random() * Math.PI * 2
      const up = 9 + Math.random() * 8
      const out = 4 + Math.random() * 6
      const d3 = d * 3
      s.debrisVel[d3] = Math.cos(a) * out
      s.debrisVel[d3 + 1] = up
      s.debrisVel[d3 + 2] = Math.sin(a) * out
      bit.position.set(x, gy + 0.4, z)
      bit.scale.setScalar(0.6 + Math.random() * 0.7)
      bit.visible = true
    }
  }

  update(dt: number) {
    // Drive group visibility from the zone each frame (setZone only fires on a
    // change, and you start on Earth). Off-world only; abort everything on Earth.
    const active = this.zone === 'moon' || this.zone === 'mars'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) {
      for (const s of this.strikes) if (s.phase !== IDLE) this.reset(s)
      return
    }

    // Schedule a new strike when one is free.
    this.timer -= dt
    if (this.timer <= 0) {
      this.begin()
      this.timer = 6 + Math.random() * 6
    }

    for (const s of this.strikes) {
      if (s.phase === IDLE) continue

      if (s.phase === TELEGRAPH) {
        s.timer -= dt
        // Pulse the target ring so it reads as "incoming".
        const t = 1 - s.timer / TELEGRAPH_TIME
        const pulse = 0.4 + 0.6 * Math.abs(Math.sin(t * Math.PI * 5))
        s.targetMat.opacity = pulse
        s.target.scale.setScalar(1.3 - 0.3 * t)
        if (s.timer <= 0) {
          // Launch the rock from straight overhead.
          s.phase = FALL
          s.target.visible = false
          s.meteor.position.set(s.x, s.gy + FALL_HEIGHT, s.z)
          s.meteor.rotation.set(Math.random() * 3, Math.random() * 3, 0)
          s.meteor.visible = true
        }
        continue
      }

      if (s.phase === FALL) {
        // Scale the scripted descent by the zone's gravity so off-world meteors drift slower.
        s.meteor.position.y -= FALL_SPEED * this.fallScale * dt
        s.meteor.rotation.x += dt * 8
        s.meteor.rotation.z += dt * 6
        if (s.meteor.position.y <= s.gy + 0.5) this.impact(s)
        continue
      }

      // AFTER: fade flash, animate debris, fade scorch, then idle.
      if (s.flashLife > 0) {
        s.flashLife -= dt
        // reducedMotion: dim the fading flash to the same ~35% peak and start the
        // expansion from the smaller base so there's no bright additive pop.
        const flashPeak = config.reducedMotion ? 0.35 : 1
        const flashBase = config.reducedMotion ? 7 : 10
        s.flash.material.opacity = Math.max(0, (s.flashLife / 0.35) * flashPeak)
        s.flash.scale.setScalar(flashBase + (0.35 - s.flashLife) * 30)
        if (s.flashLife <= 0) s.flash.visible = false
      }

      let debrisDone = true
      const age = SCORCH_TIME - s.scorchLife
      for (let d = 0; d < this.debrisN; d++) {
        const bit = s.debris[d]
        if (!bit.visible) continue
        if (age >= DEBRIS_LIFE) { bit.visible = false; continue }
        debrisDone = false
        const d3 = d * 3
        // Pull debris down under the current zone's gravity (cached), so Moon/Mars chunks hang.
        s.debrisVel[d3 + 1] -= this.gravity * dt
        bit.position.x += s.debrisVel[d3] * dt
        bit.position.y += s.debrisVel[d3 + 1] * dt
        bit.position.z += s.debrisVel[d3 + 2] * dt
        bit.rotation.x += dt * 9
        bit.rotation.y += dt * 7
        if (bit.position.y <= s.gy) { bit.position.y = s.gy; bit.visible = false }
      }

      s.scorchLife -= dt
      // reducedMotion: keep the fading scorch glow dimmed to match the impact init.
      const scorchPeak = config.reducedMotion ? 0.9 * 0.35 : 0.9
      s.scorchMat.opacity = Math.max(0, (s.scorchLife / SCORCH_TIME) * scorchPeak)
      if (s.scorchLife <= 0) {
        s.scorch.visible = false
        if (debrisDone && s.flashLife <= 0) this.reset(s)
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.tex) t.dispose()
  }
}
