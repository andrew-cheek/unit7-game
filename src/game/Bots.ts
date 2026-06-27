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
  huntTarget: THREE.Vector3 | null // an alien this bot is chasing down
  huntCd: number // cooldown before it hunts again
  style: 'runner' | 'flyer' | 'hunter' // behaviour bias so they don't all act alike
  idleT: number // >0 while pausing to "look around"
}

export interface BotsOpts {
  /** Nearest live alien to a point (read-only) so bots can hunt convincingly. */
  nearestAlien?: (x: number, z: number) => THREE.Vector3 | null
  /** Fired when a bot "captures" — a purely cosmetic net-pop where it stands. */
  onHunt?: (x: number, y: number, z: number) => void
}

export class Bots implements GameSystem {
  private scene: THREE.Scene
  private physics: Physics
  private opts: BotsOpts
  private bots: Bot[] = []
  private visible = true
  private frame = 0
  // Cached leaderboard rows (reused objects), rebuilt only when a bot's score
  // changes - the HUD polls this 20x/sec, so rebuilding every poll was pure
  // garbage. `lbVersion` lets the consumer skip work when nothing changed.
  private lbRows: { name: string; score: number }[] = []
  private lbDirty = true
  private lbVersion = 0

  constructor(scene: THREE.Scene, physics: Physics, opts: BotsOpts = {}, count = 8) {
    this.scene = scene
    this.physics = physics
    this.opts = opts
    // Pick distinct names.
    const pool = [...NAMES]
    const n = Math.min(count, pool.length)
    const styles: Bot['style'][] = ['runner', 'flyer', 'hunter']
    for (let i = 0; i < n; i++) {
      const ni = Math.floor(Math.random() * pool.length)
      const name = pool.splice(ni, 1)[0]
      const style = styles[i % styles.length]
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
        runSpeed: (style === 'runner' ? 14 : 10) + Math.random() * 4, flying: false, flyT: 0, cruiseH: 24, lastGround: pos.y,
        rayPhase: i % 2, score: 40 + Math.floor(Math.random() * 220), nextScore: 4 + Math.random() * 10, t: 0,
        huntTarget: null, huntCd: Math.random() * 8, style, idleT: 0,
      })
    }
  }

  get count(): number {
    return this.visible ? this.bots.length : 0
  }

  /** Total bots regardless of zone visibility — for a stable "online" count + the
   *  leaderboard, so the presence illusion doesn't crash to 1 when you go off-world. */
  get rosterSize(): number {
    return this.bots.length
  }

  /** Bumps whenever the cached leaderboard rows change (for skip-if-unchanged). */
  get leaderboardVersion(): number {
    return this.lbVersion
  }

  /** Fake leaderboard rows (name + score) for the HUD, highest first. Returns a
   *  cached, reused array - do not mutate it; it's rebuilt only when a bot scores. */
  leaderboard(): { name: string; score: number }[] {
    if (this.lbDirty) {
      const rows = this.lbRows
      for (let i = 0; i < this.bots.length; i++) {
        const b = this.bots[i]
        if (rows[i]) { rows[i].name = b.name; rows[i].score = b.score }
        else rows[i] = { name: b.name, score: b.score }
      }
      rows.length = this.bots.length
      rows.sort((a, b) => b.score - a.score)
      this.lbDirty = false
      this.lbVersion++
    }
    return this.lbRows
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
      b.huntCd = Math.max(0, b.huntCd - dt)
      if (b.t > b.nextScore) { b.score += 1 + Math.floor(Math.random() * 3); b.nextScore = b.t + 6 + Math.random() * 16; this.lbDirty = true }

      // Idle: occasionally stop and look around (only when grounded + free), which
      // reads as a real player pausing. Holds the bot in place + slowly turns.
      if (b.idleT > 0) {
        b.idleT -= dt
        b.target.copy(b.pos)
        b.yaw += dt * 0.7
      } else if (!b.flying && !b.huntTarget && Math.random() < 0.0025) {
        b.idleT = 1.2 + Math.random() * 2.5
      }

      // Hunt: lock onto a nearby alien and chase it, then pop a cosmetic net where
      // it stands (the real alien is never touched). Hunters do it far more.
      const huntChance = b.style === 'hunter' ? 0.03 : 0.008
      if (b.idleT <= 0 && !b.flying && !b.huntTarget && b.huntCd <= 0 && this.opts.nearestAlien && Math.random() < huntChance) {
        const a = this.opts.nearestAlien(b.pos.x, b.pos.z)
        if (a && (a.x - b.pos.x) ** 2 + (a.z - b.pos.z) ** 2 < 50 * 50) { b.huntTarget = a; b.target.copy(a) } // `a` is already a fresh clone from nearestAlien - no need to clone again
      }
      if (b.huntTarget) {
        const hd = Math.hypot(b.huntTarget.x - b.pos.x, b.huntTarget.z - b.pos.z)
        if (hd < 5) {
          this.opts.onHunt?.(b.pos.x, b.pos.y + 1, b.pos.z)
          b.score += 2 + Math.floor(Math.random() * 4); this.lbDirty = true
          b.huntTarget = null
          b.huntCd = 6 + Math.random() * 12
          b.target.copy(this.randomPoint())
        } else {
          b.target.copy(b.huntTarget)
        }
      }

      // Re-target on arrival; flyers break into flight far more often.
      const flyChance = b.style === 'flyer' ? 0.012 : 0.0035
      const tx = b.target.x - b.pos.x, tz = b.target.z - b.pos.z
      if (b.idleT <= 0 && !b.huntTarget && tx * tx + tz * tz < 18) { b.target.copy(this.randomPoint()); if (Math.random() < (b.style === 'flyer' ? 0.6 : 0.3)) this.startFly(b) }
      else if (b.idleT <= 0 && !b.flying && !b.huntTarget && Math.random() < flyChance) this.startFly(b)

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
