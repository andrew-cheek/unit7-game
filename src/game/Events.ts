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
  invader: boolean // part of the sunrise invasion: chases + lobs water balloons
  raid: boolean // part of the scripted city-raid waves you repel after the skydive
  throwTimer: number
}
interface Dropship {
  model: VehicleModel
  pos: THREE.Vector3
  groundY: number
  state: 'descend' | 'hover' | 'leave'
  timer: number
  dropped: boolean
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
const ACTOR_CULL2 = 150 * 150 // squared distance beyond which ambient actors are culled

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
  private police: Police[] = []
  private buses: Bus[] = []
  private busVel = new THREE.Vector3() // scratch for bus wall-collision
  private commuters: Commuter[] = []
  private busRoute: BusWaypoint[] = []
  private ownedMats: THREE.Material[] = []

  // Sunrise alien invasion.
  private invasionActive = false
  private dropships: Dropship[] = []
  private playerPos = new THREE.Vector3()

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
    const n = Math.max(1, Math.round(config.city.police * config.tier.densityScale))
    for (let i = 0; i < n; i++) {
      const model = createPoliceCar()
      this.root.add(model.group)
      // Each cruiser patrols its own concentric rectangular beat and starts on a
      // different corner, so several are visible around the plaza at once.
      const r = 30 + i * 18
      const waypoints = [
        new THREE.Vector3(r, 0, r),
        new THREE.Vector3(r, 0, -r),
        new THREE.Vector3(-r, 0, -r),
        new THREE.Vector3(-r, 0, r),
      ]
      const start = i % waypoints.length
      const pos = waypoints[start].clone()
      pos.y = (this.physics.sampleGround(pos.x, pos.z, 40)?.y ?? 0) + 1.0
      model.group.position.copy(pos)
      this.police.push({ model, pos, yaw: 0, waypoints, wp: (start + 1) % waypoints.length, speed: 15 + i * 2 })
    }
  }

  /**
   * Commuter buses that loop the avenues, pause at the office stops and let out
   * pedestrians who walk into the buildings for work. The route is a rectangle
   * around the plaza with the three office stops inserted on its edges.
   */
  private spawnBuses() {
    const mk = (x: number, z: number, stopIdx: number): BusWaypoint => ({ p: new THREE.Vector3(x, 0, z), stopIdx })
    // Loop the avenues visiting every office stop, ordered around the plaza so
    // the route doesn't criss-cross. Generalizes to however many OFFICE_ANCHORS
    // exist: each stop gets an approach corner just outside it.
    const ordered = OFFICE_ANCHORS.map((a, i) => ({ i, a })).sort(
      (p, q) => Math.atan2(p.a.stop.z, p.a.stop.x) - Math.atan2(q.a.stop.z, q.a.stop.x),
    )
    this.busRoute = []
    for (const { i, a } of ordered) {
      const sx = a.stop.x
      const sz = a.stop.z
      const len = Math.hypot(sx, sz) || 1
      this.busRoute.push(mk((sx / len) * (len + 14), (sz / len) * (len + 14), -1)) // approach corner
      this.busRoute.push(mk(sx, sz, i)) // the office stop
    }
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
    this.playerPos.copy(playerPos)
    this.updatePowerups(dt, playerPos)
    this.updateDrones(dt)
    this.updateTraffic(dt)
    this.updatePolice(dt)
    this.updateBuses(dt)
    this.updateCommuters(dt)
    this.updateShip(dt)
    this.updateInvasion(dt)
    this.updateRaid(dt)
    this.updateAliens(dt)
  }

  /**
   * Kick off the sunrise invasion: a wave of dropships descends around the
   * player, each disgorging "invader" aliens that chase you and lob water
   * balloons. Safe to call repeatedly - it only triggers once.
   */
  startInvasion(playerPos: THREE.Vector3) {
    if (this.invasionActive) return
    this.invasionActive = true
    // Kept deliberately small: the invasion is a flavour beat, not constant spam.
    const n = config.tier.name === 'high' ? 2 : 1
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.4
      const r = 30 + Math.random() * 16
      const x = playerPos.x + Math.cos(a) * r
      const z = playerPos.z + Math.sin(a) * r
      const model = createSpaceship()
      model.group.scale.setScalar(1.5)
      const groundY = this.physics.sampleGround(x, z, 80)?.y ?? 0
      const pos = new THREE.Vector3(x, groundY + 110, z)
      model.group.position.copy(pos)
      this.root.add(model.group)
      this.dropships.push({ model, pos, groundY, state: 'descend', timer: 0, dropped: false })
    }
  }

  private updateInvasion(dt: number) {
    for (let i = this.dropships.length - 1; i >= 0; i--) {
      const s = this.dropships[i]
      s.model.update(dt, 0)
      s.model.group.rotation.y += dt * 0.5
      if (s.state === 'descend') {
        s.pos.y = approach(s.pos.y, s.groundY + 6, 40 * dt)
        if (s.pos.y <= s.groundY + 6.5 && !s.dropped) {
          s.dropped = true
          s.state = 'hover'
          s.timer = 6
          const k = config.tier.name === 'high' ? 2 : 1
          for (let j = 0; j < k; j++) {
            const a = (j / k) * Math.PI * 2
            this.spawnAlien(s.pos.x + Math.cos(a) * 4, s.pos.z + Math.sin(a) * 4, true)
          }
        }
      } else if (s.state === 'hover') {
        s.timer -= dt
        if (s.timer <= 0) s.state = 'leave'
      } else {
        s.pos.y += (12 + (s.pos.y - s.groundY)) * dt
        if (s.pos.y > s.groundY + 120) {
          this.root.remove(s.model.group)
          s.model.dispose()
          this.dropships.splice(i, 1)
        }
      }
      s.model.group.position.copy(s.pos)
    }
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
          const vx = (dx / d) * b.speed
          const vz = (dz / d) * b.speed
          b.pos.x += vx * dt
          b.pos.z += vz * dt
          // Keep buses out of building walls (treat the bus as a fat circle).
          this.busVel.set(vx, 0, vz)
          this.physics.resolveHorizontal(b.pos, this.busVel, 2.4, 3)
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
      const farC = this.farFromPlayer(c.pos.x, c.pos.z)
      c.model.group.visible = !farC
      if (!farC) c.model.update(dt, sp / speed, true)
    }
  }

  private updatePolice(dt: number) {
    for (const p of this.police) {
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

  /** Squared distance test for distance-culling ambient actors (mobile perf). */
  private farFromPlayer(x: number, z: number) {
    const dx = x - this.playerPos.x
    const dz = z - this.playerPos.z
    return dx * dx + dz * dz > ACTOR_CULL2
  }

  private updateDrones(dt: number) {
    for (const d of this.drones) {
      d.angle += d.speed * dt
      const x = d.center.x + Math.cos(d.angle) * d.radius
      const z = d.center.z + Math.sin(d.angle) * d.radius
      d.model.group.position.set(x, d.height + Math.sin(this.t * 1.5 + d.center.x) * 0.6, z)
      d.model.group.rotation.y = -d.angle
      const far = this.farFromPlayer(x, z)
      d.model.group.visible = !far
      if (!far) d.model.update(dt, 0)
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
      const far = this.farFromPlayer(c.pos.x, c.pos.z)
      c.model.group.visible = !far
      if (!far) c.model.update(dt, 1)
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

  private spawnAlien(x: number, z: number, invader = false, raid = false) {
    const model = raid ? createAlien({ color: 0xc8203a, eye: 0xffd24a }) : invader ? createAlien({ color: 0x6a3bd0, eye: 0xff4d4d }) : createAlien()
    if (raid) model.group.scale.setScalar(1.15)
    const pos = new THREE.Vector3(x, this.physics.sampleGround(x, z, 40)?.y ?? 0, z)
    model.group.position.copy(pos)
    this.root.add(model.group)
    if (raid) this.spawnBeam(pos)
    const alien: Alien = {
      pos,
      vel: new THREE.Vector3(),
      yaw: 0,
      target: invader || raid ? this.playerPos.clone() : this.clearPoint(70),
      model,
      alive: true,
      boarding: false,
      invader: invader || raid,
      raid,
      throwTimer: randRange(6, 14),
      cap: {
        position: pos,
        alive: true,
        capture: () => {
          alien.alive = false
          alien.cap.alive = false
          return raid ? 150 : invader ? 200 : 120
        },
      },
    }
    this.aliens.push(alien)
    this.capturables.push(alien.cap)
  }

  // --- City raid: an escalating wave assault you repel after the skydive --------

  private raid: {
    active: boolean; center: THREE.Vector3; wave: number; waves: number
    phase: 'incoming' | 'fight' | 'boss' | 'cleared'; timer: number; toSpawn: number; spawnGap: number
  } | null = null
  private boss: {
    group: THREE.Group; coreMat: THREE.MeshBasicMaterial; hp: number; hpMax: number; t: number
    targetY: number; descended: boolean; addTimer: number; flash: number
    // Telegraphed ground-strike attack: a warning ring tracks to the player, then
    // a beam slams down. Caught inside it drains the shield.
    ring: THREE.Mesh; pillar: THREE.Mesh; strikeMat: THREE.MeshBasicMaterial
    strikeOn: boolean; strikeT: number; strikeStruck: boolean; strikeTimer: number; strikeR: number
  } | null = null
  private bossGeos: THREE.BufferGeometry[] = []
  private readonly bossStrikeR = 7 // radius of the mothership ground-strike
  /** Fires when the mothership is destroyed (big payoff shake at its position). */
  onBossDeath: ((pos: THREE.Vector3) => void) | null = null
  /** Fires when a mothership ground-strike resolves; `hit` is true if it caught the player. */
  onBossStrike: ((pos: THREE.Vector3, hit: boolean) => void) | null = null
  private raidBeams: { mesh: THREE.Mesh; t: number }[] = []
  private beamGeo?: THREE.CylinderGeometry
  private beamMat?: THREE.MeshBasicMaterial
  // Death bursts (explosion flash + shockwave ring) when a raid alien is destroyed.
  private raidBursts: { g: THREE.Group; mat: THREE.MeshBasicMaterial; t: number }[] = []
  private burstGeo?: THREE.SphereGeometry
  private burstRingGeo?: THREE.TorusGeometry
  /** Fires at the spot a raid alien is destroyed, so the game can shake + sfx. */
  onRaidKill: ((pos: THREE.Vector3) => void) | null = null

  /** Kick off the raid: `waves` escalating waves of red invaders that home in on
   *  the player, spawned around `center` (the landing plaza). */
  startRaid(center: THREE.Vector3, waves = 3) {
    if (this.raid) return
    this.raid = { active: true, center: center.clone(), wave: 0, waves, phase: 'incoming', timer: 1.4, toSpawn: 0, spawnGap: 0 }
  }

  /** Live raid state for the HUD, or null when no raid is running. */
  get raidState(): { active: boolean; wave: number; waves: number; alive: number; phase: 'incoming' | 'fight' | 'boss' | 'cleared'; cleared: boolean; boss: { hp: number; hpMax: number } | null } | null {
    const R = this.raid
    if (!R) return null
    return { active: R.active, wave: R.wave, waves: R.waves, alive: this.raidAlive(), phase: R.phase, cleared: R.phase === 'cleared', boss: this.boss ? { hp: this.boss.hp, hpMax: this.boss.hpMax } : null }
  }

  /** Tear down the raid, removing any stragglers. */
  stopRaid() {
    if (!this.raid) return
    for (const a of this.aliens) if (a.raid && a.alive) { a.alive = false; a.cap.alive = false }
    if (this.boss) { this.root.remove(this.boss.group, this.boss.ring, this.boss.pillar); this.boss = null }
    this.raid = null
  }

  private raidAlive() {
    let n = 0
    for (const a of this.aliens) if (a.alive && a.raid) n++
    return n
  }

  /** How many live raid invaders are within `range` (XZ) of a point - the melee
   *  threat used to drain the mech shield. */
  raidContacts(pos: THREE.Vector3, range: number): number {
    const r2 = range * range
    let n = 0
    for (const a of this.aliens) {
      if (!a.alive || !a.raid) continue
      const dx = a.pos.x - pos.x, dz = a.pos.z - pos.z
      if (dx * dx + dz * dz < r2) n++
    }
    return n
  }

  /** Nearest live raid invader to a point (for knockback direction), or null. */
  nearestRaidAlien(pos: THREE.Vector3): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null
    let bd = Infinity
    for (const a of this.aliens) {
      if (!a.alive || !a.raid) continue
      const dx = a.pos.x - pos.x, dz = a.pos.z - pos.z
      const d = dx * dx + dz * dz
      if (d < bd) { bd = d; best = a.pos }
    }
    return best
  }

  private waveSize(wave: number) {
    const base = config.tier.name === 'low' ? 3 : config.tier.name === 'medium' ? 4 : 5
    return base + (wave - 1) * 2
  }

  private updateRaid(dt: number) {
    // fade out spawn beams
    for (let i = this.raidBeams.length - 1; i >= 0; i--) {
      const b = this.raidBeams[i]
      b.t -= dt
      const k = Math.max(0, b.t / 0.5)
      ;(b.mesh.material as THREE.MeshBasicMaterial).opacity = k * 0.8
      b.mesh.scale.x = b.mesh.scale.z = 0.4 + (1 - k) * 1.4
      if (b.t <= 0) { this.root.remove(b.mesh); this.raidBeams.splice(i, 1) }
    }
    // expand + fade death bursts (run even once the raid is cleared)
    for (let i = this.raidBursts.length - 1; i >= 0; i--) {
      const b = this.raidBursts[i]
      b.t += dt
      const k = b.t / 0.42
      b.mat.opacity = Math.max(0, 1 - k)
      ;(b.g.children[0] as THREE.Mesh).scale.setScalar(1 + k * 3)
      ;(b.g.children[1] as THREE.Mesh).scale.setScalar(1 + k * 6)
      if (b.t >= 0.42) { this.root.remove(b.g); this.raidBursts.splice(i, 1) }
    }
    const R = this.raid
    if (!R || !R.active) return
    if (R.phase === 'incoming') {
      R.timer -= dt
      if (R.timer <= 0) { R.wave++; R.phase = 'fight'; R.toSpawn = this.waveSize(R.wave); R.spawnGap = 0 }
      return
    }
    if (R.phase === 'fight') {
      if (R.toSpawn > 0) {
        R.spawnGap -= dt
        if (R.spawnGap <= 0) {
          const a = Math.random() * Math.PI * 2
          const r = 16 + Math.random() * 16
          this.spawnAlien(R.center.x + Math.cos(a) * r, R.center.z + Math.sin(a) * r, true, true)
          R.toSpawn--
          R.spawnGap = 0.45
        }
      } else if (this.raidAlive() === 0) {
        if (R.wave >= R.waves) { R.phase = 'boss'; this.spawnBoss(R.center) } // final wave -> mothership
        else { R.phase = 'incoming'; R.timer = 2.8 }
      }
    } else if (R.phase === 'boss') {
      this.updateBoss(dt)
    }
  }

  // --- Mothership mini-boss: the raid's climax -------------------------------

  private spawnBoss(center: THREE.Vector3) {
    const G = (g: THREE.BufferGeometry) => { this.bossGeos.push(g); return g }
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x1a2236, metalness: 0.7, roughness: 0.4, emissive: 0x3a0d1a, emissiveIntensity: 0.6 }); this.ownedMats.push(hullMat)
    const rimMat = new THREE.MeshBasicMaterial({ color: 0xff3b52, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }); this.ownedMats.push(rimMat)
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }); this.ownedMats.push(coreMat)
    const group = new THREE.Group()
    const hull = new THREE.Mesh(G(new THREE.SphereGeometry(15, 28, 16)), hullMat); hull.scale.y = 0.32; hull.position.y = 0; group.add(hull)
    const dome = new THREE.Mesh(G(new THREE.SphereGeometry(7, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2)), hullMat); dome.position.y = 2.2; group.add(dome)
    const rim = new THREE.Mesh(G(new THREE.TorusGeometry(15, 0.5, 8, 48)), rimMat); rim.rotation.x = Math.PI / 2; group.add(rim)
    // under-lights
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; const l = new THREE.Mesh(G(new THREE.SphereGeometry(0.7, 8, 6)), rimMat); l.position.set(Math.cos(a) * 11, -2.4, Math.sin(a) * 11); group.add(l) }
    // the exposed core (weak point) hanging beneath
    const core = new THREE.Mesh(G(new THREE.SphereGeometry(4, 16, 12)), coreMat); core.position.y = -4.5; group.add(core)
    const cage = new THREE.Mesh(G(new THREE.IcosahedronGeometry(5, 0)), new THREE.MeshBasicMaterial({ color: 0xff8a3c, wireframe: true, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })); cage.position.y = -4.5; group.add(cage)
    this.ownedMats.push(cage.material as THREE.Material)
    const startY = center.y + 90
    group.position.set(center.x, startY, center.z)
    this.root.add(group)
    // Ground-strike telegraph (a warning ring) + the beam pillar that slams down.
    const strikeMat = new THREE.MeshBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }); this.ownedMats.push(strikeMat)
    const ring = new THREE.Mesh(G(new THREE.RingGeometry(this.bossStrikeR - 0.6, this.bossStrikeR, 40)), strikeMat); ring.rotation.x = -Math.PI / 2; ring.visible = false; this.root.add(ring)
    const pillar = new THREE.Mesh(G(new THREE.CylinderGeometry(this.bossStrikeR * 0.7, this.bossStrikeR * 0.4, 40, 20, 1, true)), strikeMat); pillar.visible = false; this.root.add(pillar)
    const hpMax = config.tier.name === 'low' ? 8 : 12
    this.boss = { group, coreMat, hp: hpMax, hpMax, t: 0, targetY: center.y + 26, descended: false, addTimer: 4, flash: 0, ring, pillar, strikeMat, strikeOn: false, strikeT: 0, strikeStruck: false, strikeTimer: 3, strikeR: this.bossStrikeR }
  }

  private updateBoss(dt: number) {
    const b = this.boss, R = this.raid
    if (!b || !R) return
    b.t += dt
    if (b.group.position.y > b.targetY) b.group.position.y = Math.max(b.targetY, b.group.position.y - 22 * dt)
    else b.descended = true
    b.group.rotation.y += dt * 0.35
    b.flash = Math.max(0, b.flash - dt * 3)
    b.coreMat.opacity = 0.55 + Math.sin(b.t * 4) * 0.18 + b.flash
    b.coreMat.color.setHex(b.flash > 0.2 ? 0xffffff : 0xffd24a)
    // Once it's down, it periodically drops reinforcements around the plaza.
    if (b.descended) {
      b.addTimer -= dt
      if (b.addTimer <= 0) { b.addTimer = 3.6; const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 8; this.spawnAlien(R.center.x + Math.cos(a) * r, R.center.z + Math.sin(a) * r, true, true) }
      this.updateBossStrike(b, dt)
    }
  }

  /** The mothership's ground-strike: a warning ring locks onto the player, then a
   *  beam slams down. Standing in it when it lands drains the shield. */
  private updateBossStrike(b: NonNullable<typeof this.boss>, dt: number) {
    const WARN = 1.15, FLASH = 0.3
    if (!b.strikeOn) {
      b.strikeTimer -= dt
      if (b.strikeTimer > 0) return
      // Begin: lock the ring onto the player's current ground position.
      b.strikeOn = true; b.strikeT = 0; b.strikeStruck = false
      const gy = (this.physics.sampleGround(this.playerPos.x, this.playerPos.z, 80)?.y ?? 0) + 0.15
      b.ring.position.set(this.playerPos.x, gy, this.playerPos.z)
      b.pillar.position.set(this.playerPos.x, gy + 20, this.playerPos.z)
      b.ring.visible = true
      return
    }
    b.strikeT += dt
    if (!b.strikeStruck) {
      // Telegraph: ring pulses faster + brighter as the strike nears.
      const k = b.strikeT / WARN
      b.strikeMat.opacity = (0.35 + 0.45 * k) * (0.6 + 0.4 * Math.sin(b.strikeT * (8 + k * 18)))
      b.ring.scale.setScalar(1.25 - 0.25 * k)
      if (b.strikeT >= WARN) {
        // Strike! Flash the pillar, hit-test the player.
        b.strikeStruck = true
        b.pillar.visible = true
        const dx = this.playerPos.x - b.ring.position.x, dz = this.playerPos.z - b.ring.position.z
        const hit = dx * dx + dz * dz < b.strikeR * b.strikeR
        this.onBossStrike?.(b.ring.position.clone(), hit)
      }
    } else {
      // Brief beam flash, then reset and cool down.
      const f = (b.strikeT - WARN) / FLASH
      b.strikeMat.opacity = Math.max(0, 0.9 * (1 - f))
      b.ring.scale.setScalar(1 + f * 0.8)
      if (b.strikeT >= WARN + FLASH) {
        b.strikeOn = false
        b.ring.visible = false
        b.pillar.visible = false
        b.strikeTimer = 2.8 + Math.random() * 1.6
      }
    }
  }

  /** The mothership's map position (XZ), live from spawn (even mid-descent), for
   *  the radar - or null when there's no boss. */
  bossMapPos(): THREE.Vector3 | null {
    return this.boss ? this.boss.group.position.clone() : null
  }

  /** The boss weak-point world position (for the game's missile hit test), or null. */
  bossWeakPoint(): THREE.Vector3 | null {
    if (!this.boss || !this.boss.descended) return null
    return new THREE.Vector3(this.boss.group.position.x, this.boss.group.position.y - 4.5, this.boss.group.position.z)
  }

  /** Damage the mothership core (called when a missile blast reaches it). */
  damageBoss(n = 1) {
    const b = this.boss
    if (!b || !this.raid || this.raid.phase !== 'boss' || !b.descended) return
    b.hp = Math.max(0, b.hp - n)
    b.flash = 0.7
    this.spawnBurst(new THREE.Vector3(b.group.position.x, b.group.position.y - 4.5, b.group.position.z))
    if (b.hp <= 0) this.killBoss()
  }

  private killBoss() {
    const b = this.boss
    if (!b) return
    const p = b.group.position.clone()
    for (let i = 0; i < 6; i++) this.spawnBurst(new THREE.Vector3(p.x + (Math.random() - 0.5) * 18, p.y + (Math.random() - 0.5) * 8, p.z + (Math.random() - 0.5) * 18))
    this.onBossDeath?.(p)
    this.root.remove(b.group, b.ring, b.pillar)
    this.boss = null
    if (this.raid) { this.raid.phase = 'cleared'; this.raid.active = false }
  }

  /** Explosion when a raid alien dies: a flash sphere + an expanding shock ring. */
  private spawnBurst(pos: THREE.Vector3) {
    if (!this.burstGeo) this.burstGeo = new THREE.SphereGeometry(1, 12, 10)
    if (!this.burstRingGeo) this.burstRingGeo = new THREE.TorusGeometry(1, 0.18, 6, 20)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffc23a, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    this.ownedMats.push(mat)
    const g = new THREE.Group(); g.position.set(pos.x, pos.y + 1.4, pos.z)
    g.add(new THREE.Mesh(this.burstGeo, mat))
    const ring = new THREE.Mesh(this.burstRingGeo, mat); ring.rotation.x = Math.PI / 2; g.add(ring)
    this.root.add(g)
    this.raidBursts.push({ g, mat, t: 0 })
  }

  /** A bright red column flashing in where a raid alien teleports onto the deck. */
  private spawnBeam(pos: THREE.Vector3) {
    if (!this.beamGeo) { this.beamGeo = new THREE.CylinderGeometry(0.9, 0.9, 12, 10, 1, true); }
    if (!this.beamMat) { this.beamMat = new THREE.MeshBasicMaterial({ color: 0xff3b52, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }); this.ownedMats.push(this.beamMat) }
    const m = this.beamMat.clone(); this.ownedMats.push(m)
    const mesh = new THREE.Mesh(this.beamGeo, m)
    mesh.position.set(pos.x, pos.y + 6, pos.z)
    this.root.add(mesh)
    this.raidBeams.push({ mesh, t: 0.5 })
  }

  private updateAliens(dt: number) {
    const speed = config.npc.walkSpeed * 1.3
    for (let i = this.aliens.length - 1; i >= 0; i--) {
      const a = this.aliens[i]
      if (!a.alive) {
        // Captured/destroyed: a raid invader goes out with an explosion + a kick.
        if (a.raid) { this.spawnBurst(a.pos); this.onRaidKill?.(a.pos) }
        this.root.remove(a.model.group)
        a.model.dispose()
        const ci = this.capturables.indexOf(a.cap)
        if (ci >= 0) this.capturables.splice(ci, 1)
        this.aliens.splice(i, 1)
        continue
      }
      // Invaders keep a wide stand-off and circle the player (menacing presence;
      // the water-balloon lob was removed).
      if (a.invader && !a.boarding) {
        const pdx = this.playerPos.x - a.pos.x
        const pdz = this.playerPos.z - a.pos.z
        const pd = Math.hypot(pdx, pdz)
        const standoff = 24
        a.target.set(
          this.playerPos.x - (pd > 0.01 ? pdx / pd : 0) * standoff,
          0,
          this.playerPos.z - (pd > 0.01 ? pdz / pd : 0) * standoff,
        )
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
      } else if (td < 3 && !a.invader) {
        a.target = this.clearPoint(70)
      }
      const mv = a.boarding ? speed * 1.6 : a.invader ? speed * 1.5 : speed // invaders hustle
      a.vel.x = approach(a.vel.x, td > 0.5 ? (tx / td) * mv : 0, 8 * dt)
      a.vel.z = approach(a.vel.z, td > 0.5 ? (tz / td) * mv : 0, 8 * dt)
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

  /** Visit each patrolling police cruiser's position (for the radar). */
  forEachPolice(fn: (x: number, z: number) => void) {
    for (const p of this.police) fn(p.pos.x, p.pos.z)
  }

  dispose() {
    this.shipModel.dispose()
    for (const p of this.powerups) p.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
    for (const d of this.drones) d.model.dispose()
    for (const c of this.traffic) c.model.dispose()
    for (const p of this.police) p.model.dispose()
    for (const b of this.buses) b.model.dispose()
    for (const c of this.commuters) c.model.dispose()
    for (const a of this.aliens) a.model.dispose()
    for (const s of this.dropships) s.model.dispose()
    this.beamGeo?.dispose()
    this.burstGeo?.dispose()
    this.burstRingGeo?.dispose()
    for (const g of this.bossGeos) g.dispose()
    this.ownedMats.forEach((m) => m.dispose())
  }
}
