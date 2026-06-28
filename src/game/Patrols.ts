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
}

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

  constructor(scene: THREE.Scene, physics: Physics, densityScale: number) {
    this.scene = scene
    this.physics = physics
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
    this.list.push({ model, pos, yaw: 0, waypoints, wp: (seed + 1) % 4, speed, big: kind !== 'quad' })
  }

  setVisible(v: boolean) {
    this.visible = v
    for (const p of this.list) p.model.group.visible = v
  }

  update(dt: number) {
    if (!this.visible) return
    this.frame++
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
      p.model.group.position.copy(p.pos)
      p.model.group.rotation.y = p.yaw
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
