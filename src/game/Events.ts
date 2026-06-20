import * as THREE from 'three'
import { config } from './config'
import { createAlien, createBus, createCitizen, createDrone, createHovercar, createPoliceCar, createSpaceship, type CharacterModel, type VehicleModel } from './procedural'
import { dampAngle, randRange } from './utils'
import { OFFICE_ANCHORS } from './World'
import type { Physics } from './Physics'
import type { Capturable } from './Game'
import type { PowerupKind } from './types'

interface Powerup {
  kind: PowerupKind
  group: THREE.Group
  mat: THREE.MeshStandardMaterial
  pos: THREE.Vector3
  active: boolean
  respawn: number
}
interface Alien {
  pos: THREE.Vector3
  vel: THREE.Vector3
  yaw: number
  target: THREE.Vector3
  model: CharacterModel
  alive: boolean
  cap: Capturable
  boarding: boolean // walking back to a departing ship to "board" and vanish
}
interface Drone {
  model: VehicleModel
  center: THREE.Vector3
  radius: number
  angle: number
  speed: number
  height: number
}
interface Traffic {
  model: VehicleModel
  pos: THREE.Vector3
  dir: THREE.Vector3
  speed: number
}
interface Police {
  model: VehicleModel
  pos: THREE.Vector3
  yaw: number
  waypoints: THREE.Vector3[]
  wp: number
  speed: number
}
interface BusWaypoint {
  p: THREE.Vector3
  stopIdx: number // office anchor index if this is a bus stop, else -1
}
interface Bus {
  model: VehicleModel
  pos: THREE.Vector3
  yaw: number
  wp: number
  speed: number
  state: 'driving' | 'boarding'
  timer: number
}
interface Commuter {
  pos: THREE.Vector3
  vel: THREE.Vector3
  yaw: number
  target: THREE.Vector3
  model: CharacterModel
  fade: number // 1 -> 0 as they "enter" the building
  arriving: boolean
}

const POWERUP_COLOR: Record<PowerupKind, number> = { speed: 0x27e7ff, shield: 0x8a5cff, fuel: 0x9bff4d, score: 0xff8a1e }
const POWERUP_KINDS: PowerupKind[] = ['speed', 'shield', 'fuel', 'score']
const approach = (c: number, t: number, m: number) => (c < t ? Math.min(c + m, t) : Math.max(c - m, t))

/**
 * Ambient + scripted city life (Earth only): collectible powerups, a periodic
 * spaceship that flies in, lands and releases wandering (net-catchable) aliens,
 * plus hovering drones and hovercar traffic. Everything lives under one group
 * that's hidden off-world.
 */
export class Events {
  private scene: THREE.Scene
  private physics: Physics
  private capturables: Capturable[]
  private onPowerup: (kind: PowerupKind) => void

  private root = new THREE.Group()
  private powerups: Powerup[] = []
  private aliens: Alien[] = []
  private drones: Drone[] = []
  private traffic: Traffic[] = []
  private police: Police | null = null
  private buses: Bus[] = []
  private commuters: Commuter[] = []
  private busRoute: BusWaypoint[] = []
  private ownedMats: THREE.Material[] = []

  private shipModel: VehicleModel
  private ship = {
    phase: 'idle' as 'idle' | 'incoming' | 'landed' | 'leaving',
    timer: 8,
    pos: new THREE.Vector3(),
    groundY: 0,
  }
  private t = 0

  constructor(scene: THREE.Scene, physics: Physics, capturables: Capturable[], onPowerup: (kind: PowerupKind) => void) {
    this.scene = scene
    this.physics = physics
    this.capturables = capturables
    this.onPowerup = onPowerup
    scene.add(this.root)

    const q = config.tier.densityScale
    for (let i = 0; i < config.events.powerupCount; i++) this.spawnPowerup(POWERUP_KINDS[i % 4])
    for (let i = 0; i < Math.round(config.events.droneCount * q); i++) this.spawnDrone(i)
    for (let i = 0; i < Math.round(config.events.trafficCount * q); i++) this.spawnTraffic(i)
    this.spawnPolice()
    this.spawnBuses()

    this.shipModel = createSpaceship()
    this.shipModel.group.visible = false
    this.shipModel.group.scale.setScalar(1.6)
    this.root.add(this.shipModel.group)
  }

  setVisible(v: boolean) {
    this.root.visible = v
  }

  // --- spawn helpers -------------------------------------------------------

  private clearPoint(maxR: number): THREE.Vector3 {
    for (let a = 0; a < 16; a++) {
      const x = randRange(-maxR, maxR)
      const z = randRange(-maxR, maxR)
      let inside = false
      for (const b of this.physics.colliders) {
        if (x > b.min.x - 2 && x < b.max.x + 2 && z > b.min.z - 2 && z < b.max.z + 2) {
          inside = true
          break
        }
      }
      if (!inside) return new THREE.Vector3(x, 0, z)
    }
    return new THREE.Vector3(randRange(-20, 20), 0, randRange(-20, 20))
  }

  private spawnPowerup(kind: PowerupKind) {
    const color = POWERUP_COLOR[kind]
    const mat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: 2.6, roughness: 0.3, metalness: 0.4 })
    this.ownedMats.push(mat)
    const geo =
      kind === 'speed'
        ? new THREE.ConeGeometry(0.4, 0.8, 6)
        : kind === 'shield'
          ? new THREE.IcosahedronGeometry(0.45, 0)
          : kind === 'fuel'
            ? new THREE.CylinderGeometry(0.3, 0.3, 0.7, 10)
            : new THREE.OctahedronGeometry(0.46, 0)
    const icon = new THREE.Mesh(geo, mat)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.04, 8, 28), mat)
    ring.rotation.x = Math.PI / 2
    const group = new THREE.Group()
    group.add(icon, ring)
    const p = this.clearPoint(config.npc.wanderRadius)
    p.y = (this.physics.sampleGround(p.x, p.z, 40)?.y ?? 0) + 1.4
    group.position.copy(p)
    this.root.add(group)
    this.powerups.push({ kind, group, mat, pos: p, active: true, respawn: 0 })
  }

  private spawnDrone(i: number) {
    const model = createDrone()
    this.root.add(model.group)
    const c = this.clearPoint(config.npc.wanderRadius)
    this.drones.push({
      model,
      center: new THREE.Vector3(c.x, 0, c.z),
      radius: randRange(6, 18),
      angle: randRange(0, 6.28),
      speed: randRange(0.2, 0.6) * (i % 2 ? 1 : -1),
      height: randRange(10, 34),
    })
  }

  private spawnTraffic(i: number) {
    const model = createHovercar()
    this.root.add(model.group)
    const axis = i % 2 === 0
    const lane = randRange(-150, 150)
    const dir = new THREE.Vector3(axis ? 1 : 0, 0, axis ? 0 : 1).multiplyScalar(i % 4 < 2 ? 1 : -1)
    const pos = new THREE.Vector3(axis ? -180 : lane, randRange(5, 12), axis ? lane : -180)
    if (dir.x < 0 || dir.z < 0) pos.set(axis ? 180 : lane, pos.y, axis ? lane : 180)
    this.traffic.push({ model, pos, dir, speed: randRange(14, 26) })
  }

  /**
   * A single police cruiser that loops a rectangular beat through the streets
   * near spawn (so it's visible right after the intro) with its siren strobing.
   * Not a chase - just ambient patrol life.
   */
  private spawnPolice() {
    const model = createPoliceCar()
    this.root.add(model.group)
    // Rectangle of road-level waypoints around the central plaza.
    const waypoints = [
      new THREE.Vector3(38, 0, 38),
      new THREE.Vector3(38, 0, -38),
      new THREE.Vector3(-38, 0, -38),
      new THREE.Vector3(-38, 0, 38),
    ]
    const pos = waypoints[0].clone()
    pos.y = (this.physics.sampleGround(pos.x, pos.z, 40)?.y ?? 0) + 1.0
    model.group.position.copy(pos)
    this.police = { model, pos, yaw: 0, waypoints, wp: 1, speed: 16 }
  }

  /**
   * Commuter buses that loop the avenues, pause at the office stops and let out
   * pedestrians who walk into the buildings for work. The route is a rectangle
   * around the plaza with the three office stops inserted on its edges.
   */
  private spawnBuses() {
    const mk = (x: number, z: number, stopIdx: number): BusWaypoint => ({ p: new THREE.Vector3(x, 0, z), stopIdx })
    this.busRoute = [
      mk(38, 38, -1),
      mk(OFFICE_ANCHORS[1].stop.x, OFFICE_ANCHORS[1].stop.z, 1),
      mk(-38, 38, -1),
      mk(OFFICE_ANCHORS[2].stop.x, OFFICE_ANCHORS[2].stop.z, 2),
      mk(-38, -38, -1),
      mk(38, -38, -1),
      mk(OFFICE_ANCHORS[0].stop.x, OFFICE_ANCHORS[0].stop.z, 0),
    ]
    const n = config.tier.name === 'high' ? 2 : 1
    for (let i = 0; i < n; i++) {
      const model = createBus()
      this.root.add(model.group)
      // Stagger the buses around the loop so they don't overlap.
      const wp = Math.floor((i / n) * this.busRoute.length)
      const start = this.busRoute[wp].p
      const pos = new THREE.Vector3(start.x, 0, start.z)
      pos.y = this.physics.sampleGround(pos.x, pos.z, 40)?.y ?? 0
      model.group.position.copy(pos)
      this.buses.push({ model, pos, yaw: 0, wp: (wp + 1) % this.busRoute.length, speed: 12, state: 'driving', timer: 0 })
    }
  }

  private spawnCommuter(at: THREE.Vector3, door: THREE.Vector3) {
    // Mix of citizens and a few robot workers heading in for the shift.
    const model = createCitizen()
    const pos = new THREE.Vector3(at.x + randRange(-1.5, 1.5), 0, at.z + randRange(-1.5, 1.5))
    pos.y = this.physics.sampleGround(pos.x, pos.z, 40)?.y ?? 0
    model.group.position.copy(pos)
    this.root.add(model.group)
    this.commuters.push({
      pos,
      vel: new THREE.Vector3(),
      yaw: 0,
      target: new THREE.Vector3(door.x + randRange(-1, 1), 0, door.z),
      model,
      fade: 1,
      arriving: false,
    })
  }

  // --- per-frame -----------------------------------------------------------

  update(dt: number, playerPos: THREE.Vector3) {
    this.t += dt
    this.updatePowerups(dt, playerPos)
    this.updateDrones(dt)
    this.updateTraffic(dt)
    this.updatePolice(dt)
    this.updateBuses(dt)
    this.updateCommuters(dt)
    this.updateShip(dt)
    this.updateAliens(dt)
  }

  private updateBuses(dt: number) {
    for (const b of this.buses) {
      b.model.update(dt, 1)
      if (b.state === 'boarding') {
        b.timer -= dt
        if (b.timer <= 0) {
          b.wp = (b.wp + 1) % this.busRoute.length
          b.state = 'driving'
        }
      } else {
        const tgt = this.busRoute[b.wp]
        const dx = tgt.p.x - b.pos.x
        const dz = tgt.p.z - b.pos.z
        const d = Math.hypot(dx, dz)
        if (d < 2.5) {
          if (tgt.stopIdx >= 0 && this.commuters.length < 14) {
            // Pull up and let commuters out toward the office door.
            b.state = 'boarding'
            b.timer = 3.5
            const door = OFFICE_ANCHORS[tgt.stopIdx].door
            const count = 2 + Math.floor(Math.random() * 2)
            for (let k = 0; k < count; k++) this.spawnCommuter(b.pos, door)
          } else {
            b.wp = (b.wp + 1) % this.busRoute.length
          }
        } else {
          b.pos.x += (dx / d) * b.speed * dt
          b.pos.z += (dz / d) * b.speed * dt
          b.yaw = dampAngle(b.yaw, Math.atan2(dx, dz), 5, dt)
        }
      }
      const gy = this.physics.sampleGround(b.pos.x, b.pos.z, b.pos.y + 6)?.y ?? 0
      b.pos.y = gy
      b.model.group.position.copy(b.pos)
      b.model.group.rotation.y = b.yaw
    }
  }

  private updateCommuters(dt: number) {
    const speed = config.npc.walkSpeed
    for (let i = this.commuters.length - 1; i >= 0; i--) {
      const c = this.commuters[i]
      if (c.arriving) {
        // Reached the door: shrink + fade as they step inside, then remove.
        c.fade -= dt * 1.5
        const s = Math.max(0.001, c.fade)
        c.model.group.scale.setScalar(s)
        if (c.fade <= 0) {
          this.root.remove(c.model.group)
          c.model.dispose()
          this.commuters.splice(i, 1)
        } else {
          c.model.update(dt, 0.5, true)
        }
        continue
      }
      const tx = c.target.x - c.pos.x
      const tz = c.target.z - c.pos.z
      const td = Math.hypot(tx, tz)
      if (td < 1.2) {
        c.arriving = true
        continue
      }
      c.vel.x = approach(c.vel.x, (tx / td) * speed, 8 * dt)
      c.vel.z = approach(c.vel.z, (tz / td) * speed, 8 * dt)
      c.pos.x += c.vel.x * dt
      c.pos.z += c.vel.z * dt
      this.physics.resolveHorizontal(c.pos, c.vel, 0.4, 1.6)
      const g = this.physics.sampleGround(c.pos.x, c.pos.z, c.pos.y + 2)
      if (g) c.pos.y = g.y
      const sp = Math.hypot(c.vel.x, c.vel.z)
      if (sp > 0.1) {
        c.yaw = dampAngle(c.yaw, Math.atan2(c.vel.x, c.vel.z), 8, dt)
        c.model.group.rotation.y = c.yaw
      }
      c.model.group.position.copy(c.pos)
      c.model.update(dt, sp / speed, true)
    }
  }

  private updatePolice(dt: number) {
    const p = this.police
    if (!p) return
    p.model.update(dt, 1) // strobes the light bar
    const tgt = p.waypoints[p.wp]
    const dx = tgt.x - p.pos.x
    const dz = tgt.z - p.pos.z
    const d = Math.hypot(dx, dz)
    if (d < 2) {
      p.wp = (p.wp + 1) % p.waypoints.length // next leg of the loop
    } else {
      p.pos.x += (dx / d) * p.speed * dt
      p.pos.z += (dz / d) * p.speed * dt
      p.yaw = dampAngle(p.yaw, Math.atan2(dx, dz), 6, dt)
    }
    const gy = this.physics.sampleGround(p.pos.x, p.pos.z, p.pos.y + 6)?.y ?? 0
    p.pos.y = gy + 1.0
    p.model.group.position.copy(p.pos)
    p.model.group.rotation.y = p.yaw
  }

  private updatePowerups(dt: number, playerPos: THREE.Vector3) {
    for (const p of this.powerups) {
      if (p.active) {
        p.group.rotation.y += dt * 1.4
        p.group.children[0].position.y = Math.sin(this.t * 2 + p.pos.x) * 0.12
        p.mat.emissiveIntensity = 2.4 + Math.sin(this.t * 4 + p.pos.z) * 0.6
        const dx = playerPos.x - p.pos.x
        const dz = playerPos.z - p.pos.z
        if (dx * dx + dz * dz < 2.0 * 2.0 && Math.abs(playerPos.y - (p.pos.y - 1.4)) < 3) {
          this.onPowerup(p.kind)
          p.active = false
          p.group.visible = false
          p.respawn = 12
        }
      } else {
        p.respawn -= dt
        if (p.respawn <= 0) {
          const np = this.clearPoint(config.npc.wanderRadius)
          np.y = (this.physics.sampleGround(np.x, np.z, 40)?.y ?? 0) + 1.4
          p.pos.copy(np)
          p.group.position.copy(np)
          p.active = true
          p.group.visible = true
        }
      }
    }
  }

  private updateDrones(dt: number) {
    for (const d of this.drones) {
      d.angle += d.speed * dt
      d.model.group.position.set(
        d.center.x + Math.cos(d.angle) * d.radius,
        d.height + Math.sin(this.t * 1.5 + d.center.x) * 0.6,
        d.center.z + Math.sin(d.angle) * d.radius,
      )
      d.model.group.rotation.y = -d.angle
      d.model.update(dt, 0)
    }
  }

  private updateTraffic(dt: number) {
    const lim = config.world.half + 10
    for (const c of this.traffic) {
      c.pos.addScaledVector(c.dir, c.speed * dt)
      if (c.pos.x > lim) c.pos.x = -lim
      if (c.pos.x < -lim) c.pos.x = lim
      if (c.pos.z > lim) c.pos.z = -lim
      if (c.pos.z < -lim) c.pos.z = lim
      c.model.group.position.copy(c.pos)
      c.model.group.rotation.y = Math.atan2(c.dir.x, c.dir.z)
      c.model.update(dt, 1)
    }
  }

  private updateShip(dt: number) {
    const s = this.ship
    const g = this.shipModel.group
    this.shipModel.update(dt, 0)
    if (s.phase === 'idle') {
      s.timer -= dt
      if (s.timer <= 0 && this.aliveAliens() < 6) {
        const spot = this.clearPoint(70)
        s.groundY = this.physics.sampleGround(spot.x, spot.z, 60)?.y ?? 0
        s.pos.set(spot.x, s.groundY + 90, spot.z)
        g.position.copy(s.pos)
        g.visible = true
        s.phase = 'incoming'
      }
    } else if (s.phase === 'incoming') {
      s.pos.y = approach(s.pos.y, s.groundY + 3.5, 26 * dt)
      g.position.copy(s.pos)
      g.rotation.y += dt * 0.6
      if (s.pos.y <= s.groundY + 3.7) {
        s.phase = 'landed'
        s.timer = 16
        for (let i = 0; i < config.events.aliensPerShip; i++) {
          const a = (i / config.events.aliensPerShip) * Math.PI * 2
          this.spawnAlien(s.pos.x + Math.cos(a) * 5, s.pos.z + Math.sin(a) * 5)
        }
      }
    } else if (s.phase === 'landed') {
      g.rotation.y += dt * 0.3
      s.timer -= dt
      if (s.timer <= 0) {
        s.phase = 'leaving'
        // Call nearby aliens back to board the departing ship.
        for (const a of this.aliens) {
          if (a.alive && Math.hypot(a.pos.x - s.pos.x, a.pos.z - s.pos.z) < 16) {
            a.boarding = true
            a.target.set(s.pos.x, 0, s.pos.z)
          }
        }
      }
    } else if (s.phase === 'leaving') {
      s.pos.y += (10 + (s.pos.y - s.groundY)) * dt
      g.position.copy(s.pos)
      g.rotation.y += dt * 1.2
      if (s.pos.y > s.groundY + 120) {
        g.visible = false
        s.phase = 'idle'
        s.timer = config.events.spaceshipInterval
      }
    }
  }

  private aliveAliens() {
    let n = 0
    for (const a of this.aliens) if (a.alive) n++
    return n
  }

  private spawnAlien(x: number, z: number) {
    const model = createAlien()
    const pos = new THREE.Vector3(x, this.physics.sampleGround(x, z, 40)?.y ?? 0, z)
    model.group.position.copy(pos)
    this.root.add(model.group)
    const alien: Alien = {
      pos,
      vel: new THREE.Vector3(),
      yaw: 0,
      target: this.clearPoint(70),
      model,
      alive: true,
      boarding: false,
      cap: {
        position: pos,
        alive: true,
        capture: () => {
          alien.alive = false
          alien.cap.alive = false
          return 120
        },
      },
    }
    this.aliens.push(alien)
    this.capturables.push(alien.cap)
  }

  private updateAliens(dt: number) {
    const speed = config.npc.walkSpeed * 1.3
    for (let i = this.aliens.length - 1; i >= 0; i--) {
      const a = this.aliens[i]
      if (!a.alive) {
        // Captured: remove from scene + capturables.
        this.root.remove(a.model.group)
        a.model.dispose()
        const ci = this.capturables.indexOf(a.cap)
        if (ci >= 0) this.capturables.splice(ci, 1)
        this.aliens.splice(i, 1)
        continue
      }
      const tx = a.target.x - a.pos.x
      const tz = a.target.z - a.pos.z
      const td = Math.hypot(tx, tz)
      if (a.boarding) {
        // Reached the ship: vanish (boarded). Cleaned up next frame by the
        // dead-alien handling at the top of the loop.
        if (td < 2.5) {
          a.alive = false
          a.cap.alive = false
          continue
        }
      } else if (td < 3) {
        a.target = this.clearPoint(70)
      }
      const mv = a.boarding ? speed * 1.6 : speed // hustle to board
      a.vel.x = approach(a.vel.x, td > 0.01 ? (tx / td) * mv : 0, 8 * dt)
      a.vel.z = approach(a.vel.z, td > 0.01 ? (tz / td) * mv : 0, 8 * dt)
      a.pos.x += a.vel.x * dt
      a.pos.z += a.vel.z * dt
      this.physics.resolveHorizontal(a.pos, a.vel, 0.4, 1.6)
      const g = this.physics.sampleGround(a.pos.x, a.pos.z, a.pos.y + 2)
      if (g) a.pos.y = g.y
      const sp = Math.hypot(a.vel.x, a.vel.z)
      if (sp > 0.1) {
        a.yaw = dampAngle(a.yaw, Math.atan2(a.vel.x, a.vel.z), 8, dt)
        a.model.group.rotation.y = a.yaw
      }
      a.model.group.position.copy(a.pos)
      a.model.update(dt, sp / speed, true)
    }
  }

  /** Live alien positions for the radar. */
  forEachAlien(fn: (x: number, z: number) => void) {
    for (const a of this.aliens) if (a.alive) fn(a.pos.x, a.pos.z)
  }

  /** Police cruiser position for the radar (null if none). */
  get policePos(): THREE.Vector3 | null {
    return this.police?.pos ?? null
  }

  dispose() {
    this.shipModel.dispose()
    for (const p of this.powerups) p.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
    for (const d of this.drones) d.model.dispose()
    for (const c of this.traffic) c.model.dispose()
    this.police?.model.dispose()
    for (const b of this.buses) b.model.dispose()
    for (const c of this.commuters) c.model.dispose()
    for (const a of this.aliens) a.model.dispose()
    this.ownedMats.forEach((m) => m.dispose())
  }
}
