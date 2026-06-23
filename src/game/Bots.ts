// Bots — believable "other players" for the shared-world illusion. A handful of
// tinted robots with made-up callsigns that roam the city and fly between
// rooftops with purpose, so a solo session feels populated. They are purely
// local cosmetic presence: they never touch the real alien/capture/net state,
// and real remote players don't see them. They also feed the online count + a
// fake leaderboard so the HUD reads "busy".

import * as THREE from 'three'
import { createRobot, type RobotModel } from './procedural'
import { config } from './config'
import { clamp, dampAngle, randRange } from './utils'
import type { Physics } from './Physics'
import type { GameSystem } from './System'
import type { Zone } from './types'

const NAMES = [
  'NeonViper', 'QuasarJet', 'R0boHax', 'VoltRunner', 'PixelGhost', 'MechaKid',
  'Cyb3rWolf', 'AceNova', 'GridLock', 'SkyForge', 'Z3roCool', 'HoloKnight', 'DriftKing', 'ByteReaper',
]
const TRIMS = [0x27e7ff, 0xff2bd0, 0x8a5cff, 0xff8a1e, 0x9bff4d, 0xffd24a, 0xff5c5c, 0x4affc1]
const approach = (c: number, t: number, m: number) => (c < t ? Math.min(c + m, t) : Math.max(c - m, t))

interface Bot {
  name: string
  model: RobotModel
  group: THREE.Group
  tagMat: THREE.SpriteMaterial
  tagTex: THREE.CanvasTexture
  pos: THREE.Vector3
  vel: THREE.Vector3
  yaw: number
  target: THREE.Vector3
  runSpeed: number
  flying: boolean
  flyT: number
  cruiseH: number
  lastGround: number
  rayPhase: number
  score: number
  nextScore: number
  t: number
}

export class Bots implements GameSystem {
  private scene: THREE.Scene
  private physics: Physics
  private bots: Bot[] = []
  private visible = true
  private frame = 0

  constructor(scene: THREE.Scene, physics: Physics, count = 8) {
    this.scene = scene
    this.physics = physics
    // Pick distinct names.
    const pool = [...NAMES]
    const n = Math.min(count, pool.length)
    for (let i = 0; i < n; i++) {
      const ni = Math.floor(Math.random() * pool.length)
      const name = pool.splice(ni, 1)[0]
      const trim = TRIMS[i % TRIMS.length]
      const model = createRobot({ trim, accent: trim })
      const group = new THREE.Group()
      group.add(model.group)
      const level = 12 + Math.floor(Math.random() * 30) // they read as skilled veterans
      const { sprite, mat, tex } = this.makeTag(`${name}  LV${level}`, trim)
      group.add(sprite)
      const pos = this.randomPoint()
      pos.y = this.physics.sampleGround(pos.x, pos.z, 60)?.y ?? 0
      group.position.copy(pos)
      this.scene.add(group)
      this.bots.push({
        name, model, group, tagMat: mat, tagTex: tex,
        pos, vel: new THREE.Vector3(), yaw: Math.random() * 6.28, target: this.randomPoint(),
        runSpeed: 10 + Math.random() * 4, flying: false, flyT: 0, cruiseH: 24, lastGround: pos.y,
        rayPhase: i % 2, score: 40 + Math.floor(Math.random() * 220), nextScore: 4 + Math.random() * 10, t: 0,
      })
    }
  }

  get count(): number {
    return this.visible ? this.bots.length : 0
  }

  /** Fake leaderboard rows (name + score) for the HUD, highest first. */
  leaderboard(): { name: string; score: number }[] {
    return this.bots.map((b) => ({ name: b.name, score: b.score })).sort((a, b) => b.score - a.score)
  }

  setZone(zone: Zone) {
    this.visible = zone === 'earth'
    for (const b of this.bots) b.group.visible = this.visible
  }

  private randomPoint(): THREE.Vector3 {
    const r = config.world.half * 0.7
    for (let attempt = 0; attempt < 12; attempt++) {
      const x = randRange(-r, r)
      const z = randRange(-r, r)
      let inside = false
      for (const b of this.physics.colliders) {
        if (x > b.min.x - 1 && x < b.max.x + 1 && z > b.min.z - 1 && z < b.max.z + 1) { inside = true; break }
      }
      if (!inside) return new THREE.Vector3(x, 0, z)
    }
    return new THREE.Vector3(randRange(-30, 30), 0, randRange(-30, 30))
  }

  private startFly(b: Bot) {
    b.flying = true
    b.flyT = 2 + Math.random() * 3.5
    b.cruiseH = 18 + Math.random() * 34
  }

  update(dt: number) {
    if (!this.visible) return
    this.frame++
    for (const b of this.bots) {
      b.t += dt
      if (b.t > b.nextScore) { b.score += 1 + Math.floor(Math.random() * 3); b.nextScore = b.t + 6 + Math.random() * 16 }

      // Re-target on arrival; sometimes break into a flight (skilled traversal).
      const tx = b.target.x - b.pos.x, tz = b.target.z - b.pos.z
      if (tx * tx + tz * tz < 18) { b.target.copy(this.randomPoint()); if (Math.random() < 0.4) this.startFly(b) }
      else if (!b.flying && Math.random() < 0.004) this.startFly(b)

      const d = Math.hypot(tx, tz) || 1
      const sp = b.flying ? 18 : b.runSpeed
      b.vel.x = approach(b.vel.x, (tx / d) * sp, 30 * dt)
      b.vel.z = approach(b.vel.z, (tz / d) * sp, 30 * dt)

      // Ground height (staggered raycast like the NPCs).
      let groundY = b.lastGround
      if ((this.frame + b.rayPhase) % 2 === 0) {
        groundY = this.physics.sampleGround(b.pos.x, b.pos.z, b.pos.y + 4)?.y ?? b.lastGround
        b.lastGround = groundY
      }

      if (b.flying) {
        b.flyT -= dt
        const targetY = b.flyT > 0 ? groundY + b.cruiseH : groundY
        b.vel.y = clamp((targetY - b.pos.y) * 2.2, -14, 12)
        if (b.flyT <= 0 && b.pos.y <= groundY + 0.4) b.flying = false
        b.model.setThrust(1); b.model.setFlyPose(0.7)
      } else {
        b.vel.y = 0
        b.model.setThrust(0); b.model.setFlyPose(0)
      }

      b.pos.x += b.vel.x * dt
      b.pos.y += b.vel.y * dt
      b.pos.z += b.vel.z * dt
      this.physics.resolveHorizontal(b.pos, b.vel, 0.5, 1.7)
      if (!b.flying) b.pos.y = groundY

      const speed = Math.hypot(b.vel.x, b.vel.z)
      if (speed > 0.3) b.yaw = dampAngle(b.yaw, Math.atan2(b.vel.x, b.vel.z), 8, dt)
      b.group.position.copy(b.pos)
      b.model.group.rotation.y = b.yaw
      b.model.update(dt, clamp(speed / 12, 0, 1), !b.flying)
    }
  }

  private makeTag(label: string, accent: number): { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; tex: THREE.CanvasTexture } {
    const cv = document.createElement('canvas')
    cv.width = 256
    cv.height = 64
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = 'rgba(6,10,20,0.7)'
    roundRect(ctx, 5, 12, cv.width - 10, 40, 14)
    ctx.fill()
    ctx.strokeStyle = '#' + (accent & 0xffffff).toString(16).padStart(6, '0')
    ctx.lineWidth = 2.5
    ctx.stroke()
    ctx.font = '700 22px ui-monospace, Menlo, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#eaf4ff'
    ctx.fillText(label, cv.width / 2, 33, cv.width - 20)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false })
    const sprite = new THREE.Sprite(mat)
    sprite.position.set(0, 3.0, 0)
    sprite.scale.set(3.6, 0.9, 1)
    sprite.renderOrder = 10
    return { sprite, mat, tex }
  }

  dispose() {
    for (const b of this.bots) {
      this.scene.remove(b.group)
      b.model.dispose()
      b.tagMat.dispose()
      b.tagTex.dispose()
    }
    this.bots = []
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
