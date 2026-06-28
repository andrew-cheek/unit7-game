import * as THREE from 'three'
import { config } from './config'
import { createMassiveWalker, createMech, createQuadruped, type CharacterModel } from './procedural'
import { dampAngle, randRange } from './utils'
import type { Physics } from './Physics'

type PatrolKind = 'quad' | 'mech' | 'giant'

interface Patroller {
  model: CharacterModel
  pos: THREE.Vector3
  yaw: number
  waypoints: THREE.Vector3[]
  wp: number
  speed: number
  big: boolean // mech/giant vs quadruped (affects radar size)
  glance: number // cosmetic yaw offset added on top of `yaw` to lean toward a world event
}

// A patroller only reacts to events within this radius; beyond it, the glance
// target is 0 (face normal patrol direction) and it eases back.
const GLANCE_RANGE = 150
const GLANCE_RANGE_SQ = GLANCE_RANGE * GLANCE_RANGE
// How far the rendered facing leans toward the epicenter (fraction of the full
// angular delta) - a subtle head/body turn, not a lock-on.
const GLANCE_PULL = 0.35
// Events older than this no longer warrant a reaction.
const GLANCE_MAX_AGE = 2.5

/**
 * Slow ground patrols that give the city scale and motion: four-legged robot
 * walkers trotting short beats, plus a couple of big mech walkers stomping
 * longer loops. Pure ambient life (not catchable, no physics bodies) - each just
 * follows a waypoint loop and ground-samples its height, so it's cheap. Earth
 * only; hidden off-world like the rest of the crowd. Counts come from
 * `config.city` (scaled by the quality tier) so density is tunable in one place.
 */
export class Patrols {
  private scene: THREE.Scene
  private physics: Physics
  private list: Patroller[] = []
  private visible = true
  private frame = 0 // ticks once per update(); used to stagger ground sampling
  // Optional "latest world event" lookup. When provided, patrols within range of
  // a recent event briefly lean their rendered facing toward it (cosmetic only).
  private latestEvent?: () => { x: number; z: number; age: number } | null

  constructor(
    scene: THREE.Scene,
    physics: Physics,
    densityScale: number,
    latestEvent?: () => { x: number; z: number; age: number } | null,
  ) {
    this.scene = scene
    this.physics = physics
    this.latestEvent = latestEvent
    const quad = Math.round(config.city.quadrupeds * densityScale)
    const mech = Math.round(config.city.mechs * densityScale)
    const giant = Math.round(config.city.giants * densityScale)
    for (let i = 0; i < quad; i++) this.spawn('quad', i)
    for (let i = 0; i < mech; i++) this.spawn('mech', i + 100)
    for (let i = 0; i < giant; i++) this.spawn('giant', i + 200)
  }

  private spawn(kind: PatrolKind, seed: number) {
    const model = kind === 'giant' ? createMassiveWalker() : kind === 'mech' ? createMech() : createQuadruped()
    this.scene.add(model.group)
    // A rectangular beat; giants roam the far outskirts, quads stay central.
    const range = kind === 'giant' ? 150 : 110
    const cx = randRange(-range, range)
    const cz = randRange(-range, range)
    const r = kind === 'giant' ? randRange(80, 130) : kind === 'mech' ? randRange(40, 80) : randRange(20, 50)
    const waypoints = [
      new THREE.Vector3(cx + r, 0, cz + r),
      new THREE.Vector3(cx + r, 0, cz - r),
      new THREE.Vector3(cx - r, 0, cz - r),
      new THREE.Vector3(cx - r, 0, cz + r),
    ]
    const pos = waypoints[seed % 4].clone()
    pos.y = this.physics.sampleGround(pos.x, pos.z, 60)?.y ?? 0
    model.group.position.copy(pos)
    const speed = kind === 'giant' ? 2 : kind === 'mech' ? 4.5 : 7
    this.list.push({ model, pos, yaw: 0, waypoints, wp: (seed + 1) % 4, speed, big: kind !== 'quad', glance: 0 })
  }

  setVisible(v: boolean) {
    this.visible = v
    for (const p of this.list) p.model.group.visible = v
  }

  update(dt: number) {
    if (!this.visible) return
    this.frame++
    // One event lookup per frame, shared by every patroller. Pull the scalar
    // fields out so the inner loop allocates nothing. A stale/absent event leaves
    // `evActive` false and every patroller eases its glance back to 0.
    let evActive = false
    let evX = 0
    let evZ = 0
    if (this.latestEvent) {
      const ev = this.latestEvent()
      if (ev && ev.age < GLANCE_MAX_AGE) {
        evActive = true
        evX = ev.x
        evZ = ev.z
      }
    }
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i]
      const tgt = p.waypoints[p.wp]
      const dx = tgt.x - p.pos.x
      const dz = tgt.z - p.pos.z
      const d = Math.hypot(dx, dz)
      let moving = 0
      if (d < 3) {
        p.wp = (p.wp + 1) % p.waypoints.length
      } else {
        p.pos.x += (dx / d) * p.speed * dt
        p.pos.z += (dz / d) * p.speed * dt
        p.yaw = dampAngle(p.yaw, Math.atan2(dx, dz), 4, dt)
        moving = 1
      }
      // Ground barely shifts frame-to-frame, so each patroller raycasts on
      // alternating frames (staggered by index) and reuses its last y otherwise.
      if ((this.frame + i) % 2 === 0) {
        p.pos.y = this.physics.sampleGround(p.pos.x, p.pos.z, p.pos.y + 6)?.y ?? p.pos.y
      }
      // Cosmetic "glance" toward a nearby world event: bias only the RENDERED
      // facing, never `p.yaw` or the waypoint path. Off-range/no-event patrols
      // target a 0 offset and ease back. The angular delta is wrapped to [-pi,pi]
      // so the lean takes the short way round and the offset stays small.
      let glanceTarget = 0
      if (evActive) {
        const ex = evX - p.pos.x
        const ez = evZ - p.pos.z
        if (ex * ex + ez * ez < GLANCE_RANGE_SQ) {
          let delta = (Math.atan2(ex, ez) - p.yaw) % (Math.PI * 2)
          if (delta > Math.PI) delta -= Math.PI * 2
          if (delta < -Math.PI) delta += Math.PI * 2
          glanceTarget = delta * GLANCE_PULL
        }
      }
      p.glance = dampAngle(p.glance, glanceTarget, 6, dt)
      p.model.group.position.copy(p.pos)
      p.model.group.rotation.y = p.yaw + p.glance
      p.model.update(dt, moving, true)
    }
  }

  /** Positions for the radar (kind hint: 'mech' big, else 'walker'). */
  forEach(fn: (x: number, z: number, big: boolean) => void) {
    for (const p of this.list) fn(p.pos.x, p.pos.z, p.big)
  }

  dispose() {
    for (const p of this.list) {
      this.scene.remove(p.model.group)
      p.model.dispose()
    }
    this.list.length = 0
  }
}
