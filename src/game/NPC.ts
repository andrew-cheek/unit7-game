import * as THREE from 'three'
import { config } from './config'
import { createAlien, createCitizen, type CharacterModel } from './procedural'
import { clamp, dampAngle, hash01, randRange } from './utils'
import type { Physics } from './Physics'
import type { Capturable } from './Game'

type AgentKind = 'citizen' | 'robot' | 'alien'

const NPC_CULL2 = 135 * 135 // squared distance beyond which NPCs are culled

interface Agent {
  pos: THREE.Vector3
  vel: THREE.Vector3
  yaw: number
  target: THREE.Vector3
  model: CharacterModel
  alive: boolean
  respawn: number
  cap: Capturable
  kind: AgentKind
  flee: boolean // aliens scatter when the player closes in
  value: number // score for catching this one
  // Bubble-gun state: floatT>0 = trapped + rising/floating; then it pops and the
  // agent falls back down before resuming normal wandering.
  floatT: number
  falling: boolean
  fallV: number
  driftX: number
  driftZ: number
  bubble: THREE.Mesh | null
}

const NPC_RADIUS = 0.4
const NPC_HEIGHT = 1.6
const approach = (c: number, t: number, m: number) => (c < t ? Math.min(c + m, t) : Math.max(c - m, t))

/**
 * Crowd of wandering townspeople. Each agent seeks a roaming target, with
 * boids-style separation from its neighbors and hard building collision, so the
 * crowd never clips through itself or walls (a stated problem with the old
 * version). Each registers a Capturable so the net can catch it; caught NPCs
 * respawn elsewhere after a delay to keep the streets populated.
 */
export class NPCManager {
  readonly agents: Agent[] = []
  private scene: THREE.Scene
  private physics: Physics
  private visible = true
  // scratch
  private sep = new THREE.Vector3()
  private desired = new THREE.Vector3()
  // Shared bubble visuals (one geometry/material reused by every bubbled agent).
  private bubbleGeo = new THREE.SphereGeometry(1.15, 16, 12)
  private bubbleMat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.26, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })

  constructor(scene: THREE.Scene, physics: Physics, capturables: Capturable[], count = config.npc.count) {
    this.scene = scene
    this.physics = physics
    for (let i = 0; i < count; i++) {
      const agent = this.makeAgent(i)
      this.agents.push(agent)
      capturables.push(agent.cap)
    }
  }

  private randomPoint(): THREE.Vector3 {
    const r = config.npc.wanderRadius
    for (let attempt = 0; attempt < 12; attempt++) {
      const x = randRange(-r, r)
      const z = randRange(-r, r)
      let inside = false
      for (const b of this.physics.colliders) {
        if (x > b.min.x - 1 && x < b.max.x + 1 && z > b.min.z - 1 && z < b.max.z + 1) {
          inside = true
          break
        }
      }
      if (!inside) return new THREE.Vector3(x, 0, z)
    }
    return new THREE.Vector3(randRange(-20, 20), 0, randRange(-20, 20))
  }

  private makeAgent(i: number): Agent {
    // Mix of citizens, humanoid robots and (occasionally large) aliens by ratio.
    const roll = hash01(i * 1.7)
    const accent = [config.palette.cyan, config.palette.magenta, config.palette.lime, config.palette.orange][Math.floor(hash01(i * 5.3) * 4)]
    let kind: AgentKind
    let model: CharacterModel
    let value: number
    if (roll < config.city.smallAlienRatio) {
      kind = 'alien'
      const big = hash01(i * 4.2) < config.city.bigAlienChance
      model = createAlien({ big, color: [0x3ba86a, 0x6a3ba8, 0xa83b6a][Math.floor(hash01(i * 8.1) * 3)], eye: accent })
      value = big ? 140 : 90
    } else if (roll < config.city.smallAlienRatio + config.city.robotRatio) {
      kind = 'robot'
      model = createCitizen({ robot: true, accent, outfit: [0x39414f, 0x2f3a4a, 0x444b5a][Math.floor(hash01(i * 7.7) * 3)] })
      value = 70
    } else {
      kind = 'citizen'
      const female = hash01(i * 3.1) > 0.5
      const outfit = [0x2b3a6b, 0x6b2b4a, 0x2b6b58, 0x6b5a2b, 0x3a2b6b, 0x444b5a][Math.floor(hash01(i * 7.7) * 6)]
      const skin = [0xc9a88a, 0xa9805f, 0x8a6646, 0xe0c0a0][Math.floor(hash01(i * 2.9) * 4)]
      model = createCitizen({ female, outfit, accent, skin })
      value = 60
    }
    const pos = this.randomPoint()
    const g = this.physics.sampleGround(pos.x, pos.z, 40)
    pos.y = g ? g.y : 0
    model.group.position.copy(pos)
    this.scene.add(model.group)
    const agent: Agent = {
      pos,
      vel: new THREE.Vector3(),
      yaw: 0,
      target: this.randomPoint(),
      model,
      alive: true,
      respawn: 0,
      kind,
      flee: kind === 'alien',
      value,
      floatT: 0,
      falling: false,
      fallV: 0,
      driftX: 0,
      driftZ: 0,
      bubble: null,
      cap: {
        position: pos,
        alive: true,
        capture: () => {
          agent.alive = false
          agent.cap.alive = false
          agent.respawn = 4 + Math.random() * 4
          model.group.visible = false
          return agent.value
        },
      },
    }
    return agent
  }

  /** Earth-only crowd: hide + freeze when off-world. */
  setVisible(v: boolean) {
    this.visible = v
    if (!v) for (const a of this.agents) this.popBubble(a) // clear floats when leaving Earth
    for (const a of this.agents) a.model.group.visible = v && a.alive
  }

  /**
   * Bubble gun: trap every live crowd agent within `radius` of `center` in a
   * bubble. They rise, float, then the bubble pops and they fall back down.
   * Returns true if anyone was caught.
   */
  bubbleArea(center: THREE.Vector3, radius: number): boolean {
    let any = false
    const r2 = radius * radius
    for (const a of this.agents) {
      if (!a.alive || a.floatT > 0 || a.falling) continue
      const dx = a.pos.x - center.x
      const dz = a.pos.z - center.z
      if (dx * dx + dz * dz > r2) continue
      a.floatT = 5
      a.driftX = randRange(-1.2, 1.2)
      a.driftZ = randRange(-1.2, 1.2)
      const b = new THREE.Mesh(this.bubbleGeo, this.bubbleMat)
      b.position.set(a.pos.x, a.pos.y + 0.9, a.pos.z)
      this.scene.add(b)
      a.bubble = b
      any = true
    }
    return any
  }

  private popBubble(a: Agent) {
    if (a.bubble) { this.scene.remove(a.bubble); a.bubble = null }
    a.floatT = 0
    a.falling = false
    a.fallV = 0
  }

  private updateBubbled(a: Agent, dt: number) {
    const g = this.physics.sampleGround(a.pos.x, a.pos.z, a.pos.y + 4)
    const groundY = g ? g.y : 0
    if (a.floatT > 0) {
      a.floatT -= dt
      a.pos.x += a.driftX * dt
      a.pos.z += a.driftZ * dt
      const targetY = groundY + 6
      a.pos.y += (targetY - a.pos.y) * Math.min(1, dt * 3) // ease upward
      a.yaw += dt * 1.5
      a.model.group.rotation.y = a.yaw
      if (a.floatT <= 0) {
        if (a.bubble) { this.scene.remove(a.bubble); a.bubble = null }
        a.falling = true
        a.fallV = 0
      }
    } else {
      a.fallV -= 20 * dt
      a.pos.y += a.fallV * dt
      if (a.pos.y <= groundY) {
        a.pos.y = groundY
        a.falling = false
        a.fallV = 0
        a.vel.set(0, 0, 0)
      }
    }
    a.model.group.position.copy(a.pos)
    a.model.group.visible = this.visible
    if (a.bubble) a.bubble.position.set(a.pos.x, a.pos.y + 0.9, a.pos.z)
    a.model.update(dt, 0, true)
  }

  update(dt: number, playerPos?: THREE.Vector3) {
    if (!this.visible) return
    const speed = config.npc.walkSpeed
    const sepR = config.npc.separationRadius
    const fleeR = config.city.fleeRadius
    for (const a of this.agents) {
      if (!a.alive) {
        a.respawn -= dt
        if (a.respawn <= 0) this.respawn(a)
        continue
      }
      // Bubbled agents float/fall under their own handling, skipping normal AI.
      if (a.floatT > 0 || a.falling) {
        this.updateBubbled(a, dt)
        continue
      }

      // Flee: if this agent panics and the player is close, sprint directly away.
      let fled = false
      if (a.flee && playerPos) {
        const fx = a.pos.x - playerPos.x
        const fz = a.pos.z - playerPos.z
        const fd = Math.hypot(fx, fz)
        if (fd < fleeR && fd > 0.01) {
          this.desired.set((fx / fd) * speed * 1.7, 0, (fz / fd) * speed * 1.7)
          fled = true
        }
      }

      // Otherwise seek the wander target; pick a new one when close.
      if (!fled) {
        const tx = a.target.x - a.pos.x
        const tz = a.target.z - a.pos.z
        const td = Math.hypot(tx, tz)
        if (td < 3) a.target = this.randomPoint()
        this.desired.set(td > 0.01 ? (tx / td) * speed : 0, 0, td > 0.01 ? (tz / td) * speed : 0)
      }

      // Boids separation from neighbors.
      this.sep.set(0, 0, 0)
      for (const o of this.agents) {
        if (o === a || !o.alive) continue
        const dx = a.pos.x - o.pos.x
        const dz = a.pos.z - o.pos.z
        const dd = Math.hypot(dx, dz)
        if (dd > 0.001 && dd < sepR) {
          const w = (sepR - dd) / sepR
          this.sep.x += (dx / dd) * w
          this.sep.z += (dz / dd) * w
        }
      }
      this.desired.x += this.sep.x * config.npc.separationForce
      this.desired.z += this.sep.z * config.npc.separationForce

      a.vel.x = approach(a.vel.x, this.desired.x, 6 * dt)
      a.vel.z = approach(a.vel.z, this.desired.z, 6 * dt)

      a.pos.x += a.vel.x * dt
      a.pos.z += a.vel.z * dt
      this.physics.resolveHorizontal(a.pos, a.vel, NPC_RADIUS, NPC_HEIGHT)
      const g = this.physics.sampleGround(a.pos.x, a.pos.z, a.pos.y + 2)
      if (g) a.pos.y = g.y

      const sp = Math.hypot(a.vel.x, a.vel.z)
      if (sp > 0.1) {
        a.yaw = dampAngle(a.yaw, Math.atan2(a.vel.x, a.vel.z), 8, dt)
        a.model.group.rotation.y = a.yaw
      }
      a.model.group.position.copy(a.pos)
      // Distance culling: skip rendering + animating far NPCs (mobile perf).
      const far = playerPos ? (a.pos.x - playerPos.x) ** 2 + (a.pos.z - playerPos.z) ** 2 > NPC_CULL2 : false
      a.model.group.visible = !far
      if (!far) a.model.update(dt, sp / speed, true)
    }
  }

  private respawn(a: Agent) {
    const p = this.randomPoint()
    const g = this.physics.sampleGround(p.x, p.z, 40)
    a.pos.set(p.x, g ? g.y : 0, p.z)
    a.vel.set(0, 0, 0)
    a.target = this.randomPoint()
    a.alive = true
    a.cap.alive = true
    a.model.group.visible = this.visible
    a.model.group.position.copy(a.pos)
  }

  /** Live agent positions, for the radar. */
  forEachAlive(fn: (x: number, z: number) => void) {
    for (const a of this.agents) if (a.alive) fn(a.pos.x, a.pos.z)
  }

  dispose() {
    for (const a of this.agents) {
      this.popBubble(a)
      this.scene.remove(a.model.group)
      a.model.dispose()
    }
    this.bubbleGeo.dispose()
    this.bubbleMat.dispose()
    this.agents.length = 0
  }
}
