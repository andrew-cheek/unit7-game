import * as THREE from 'three'
import { Engine } from './Engine'
import { World } from './World'
import { Input } from './Input'
import { Player } from './Player'
import { Physics } from './Physics'
import { Vehicles } from './Vehicles'
import { NPCManager } from './NPC'
import { AssetLoader } from './AssetLoader'
import { Zones } from './Zones'
import { Events } from './Events'
import { Intro } from './Intro'
import { CameraController } from './Camera'
import { config } from './config'
import { detectTier, TIERS } from './tiers'
import { clamp } from './utils'
import type { HudState, RadarBlip, Unit7Config, Zone } from './types'

/** Something the net can catch (NPCs, aliens). Registered by their systems. */
export interface Capturable {
  position: THREE.Vector3
  alive: boolean
  capture(): number // returns score awarded
}

const NET_SEGMENTS = 22

/**
 * Top-level orchestrator. Owns the Engine and every gameplay subsystem, drives
 * the single update hook, manages pause, and pushes throttled HUD snapshots.
 */
export class Game {
  readonly engine: Engine
  readonly world: World
  readonly input: Input
  readonly physics: Physics
  readonly player: Player
  readonly vehicles: Vehicles
  readonly npcs: NPCManager
  readonly assets: AssetLoader
  readonly zones: Zones
  readonly events: Events
  readonly camera: CameraController
  readonly controls
  zone: Zone

  // powerup effect timers (seconds remaining) + score multiplier
  private fx = { speed: 0, shield: 0, score: 0 }
  private scoreMul = 1
  private intro: Intro | null = null
  // Sit the sky/star dome around the cinematic's pocket of airspace.
  private introFocus = new THREE.Vector3(0, 50, -390)

  // zone transition (fade out -> swap -> fade in) + rocket launch sequence
  private trans: { phase: 'none' | 'out' | 'in'; t: number; target: Zone } = { phase: 'none', t: 0, target: 'earth' }
  private launch = { active: false, t: 0, target: 'earth' as Zone }
  private travelCooldown = 0
  private bannerTimer = 0

  /** Net-catchable entities; populated by NPC/alien systems in later stages. */
  readonly capturables: Capturable[] = []

  private cfg: Required<Unit7Config>
  private hudListener: (s: HudState) => void
  private hud: HudState
  private hudAccum = 0
  private paused = false
  private radar: RadarBlip[] = []
  private focus = new THREE.Vector3()
  // FPS is measured on the real render frame in Engine (sim runs at fixed dt).

  private netLine: THREE.Line
  private netTimer = 0
  private scratchFwd = new THREE.Vector3()

  constructor(container: HTMLElement, userConfig: Unit7Config, hudListener: (s: HudState) => void) {
    // Resolve the quality tier once at startup (GPU/UA probe + manual override),
    // then make it the single object every system reads from.
    const tierName = detectTier(userConfig.quality)
    const tier = TIERS[tierName]
    config.quality = tierName
    config.tier = tier

    this.cfg = {
      startInIntro: userConfig.startInIntro ?? true,
      quality: tierName,
      initialZone: userConfig.initialZone ?? 'earth',
    }
    this.zone = this.cfg.initialZone
    this.hudListener = hudListener

    this.engine = new Engine(container, tier)
    this.world = new World(this.engine.scene, this.zone)
    this.input = new Input(this.engine.renderer.domElement)
    this.physics = new Physics(this.world.groundMeshes, this.world.colliders)
    this.player = new Player(this.engine.scene)
    this.player.object.position.copy(this.world.spawn)
    this.vehicles = new Vehicles(this.engine.scene, this.physics)
    const npcCount = Math.round(config.npc.count * tier.densityScale)
    this.npcs = new NPCManager(this.engine.scene, this.physics, this.capturables, npcCount)
    this.zones = new Zones(this.engine.scene)
    this.zones.setActive('earth')
    this.events = new Events(this.engine.scene, this.physics, this.capturables, (kind) => this.applyPowerup(kind))
    this.camera = new CameraController(this.engine.camera, this.world.solidMeshes)
    this.camera.snap(this.player.position)

    this.vehicles.onEnterRocket = () => this.startRocketLaunch()

    // Load real CC0 assets if present; otherwise the procedural world stays.
    this.assets = new AssetLoader()
    this.assets
      .loadAll(this.engine.renderer, (p, msg) => {
        this.hud.loadingProgress = p
        this.hud.loadingMsg = msg
      })
      .then(() => {
        if (this.assets.envTexture) this.engine.scene.environment = this.assets.envTexture
        if (this.assets.background) this.engine.scene.background = this.assets.background
        this.hud.loading = false
      })

    this.netLine = this.buildNetLine()
    this.engine.scene.add(this.netLine)

    this.input.onUnlock = () => {
      if (!this.paused) this.setPaused(true)
    }

    this.controls = {
      setVirtualMove: (x: number, y: number) => this.input.setVirtualMove(x, y),
      setVirtualLook: (dx: number, dy: number) => this.input.setVirtualLook(dx, dy),
      pressAction: (a: Parameters<Input['pressAction']>[0], down: boolean) => this.input.pressAction(a, down),
      resume: () => this.setPaused(false),
      pause: () => this.setPaused(true),
      skipIntro: () => this.intro?.skip(),
      requestPointerLock: () => this.input.requestLock(),
    }

    this.hud = {
      mode: 'robot', zone: this.zone, stamina: 1, fuel: 1, score: 0, captured: 0,
      speed: 0, altitude: 0, heading: 0, prompt: null, powerup: null, shield: false,
      fps: 60, paused: false, lookLocked: false, loading: false, loadingProgress: 1,
      loadingMsg: '', intro: false, vehicle: null, radar: [], fade: 0, banner: null,
    }

    this.engine.onUpdate = this.update
    if (import.meta.env.DEV) (window as unknown as { __unit7?: Game }).__unit7 = this

    // Spawn directly into an off-world zone if requested.
    if (this.zone !== 'earth') {
      const z = this.zone
      this.zone = 'earth'
      this.doTravel(z)
    }

    // Factory assembly cinematic before gameplay (skippable).
    if (this.cfg.startInIntro) {
      this.intro = new Intro(this.engine.scene, this.engine.camera)
      this.hud.intro = true
      this.player.setVisible(false)
      this.input.setLockEnabled(false)
    }
  }

  private finishIntro() {
    this.intro?.dispose()
    this.intro = null
    this.hud.intro = false
    this.player.exitVehicle(this.world.spawn.clone())
    this.player.setVisible(true)
    this.camera.snap(this.player.position)
    this.input.setLockEnabled(true)
    // The cinematic ended on black; fade back in on the gameplay side so the
    // hand-off to the follow camera reads as one continuous shot.
    this.hud.fade = 1
    this.trans = { phase: 'in', t: 0, target: this.zone }
    this.hud.banner = 'WELCOME TO UNIT 7'
    this.bannerTimer = 2.4
  }

  // --- zone travel ---------------------------------------------------------

  private requestTravel(zone: Zone) {
    if (this.trans.phase !== 'none' || zone === this.zone) return
    this.trans = { phase: 'out', t: 0, target: zone }
    this.travelCooldown = 2
  }

  /** Hard swap of surfaces, atmosphere, visible terrain and spawn for a zone. */
  private doTravel(zone: Zone) {
    if (this.vehicles.current) {
      this.player.exitVehicle(this.player.position)
    }
    this.zones.setActive(zone)
    this.world.cityVisible(zone === 'earth')
    this.world.applyZone(zone)
    this.hud.zone = zone

    const env = this.zones.env(zone)
    const spawn = zone === 'earth' ? this.world.spawn : env!.spawn
    const ground = zone === 'earth' ? this.world.groundMeshes : env!.groundMeshes
    const colliders = zone === 'earth' ? this.world.colliders : env!.colliders
    const solids = zone === 'earth' ? this.world.solidMeshes : env!.solidMeshes
    this.physics.setSurfaces(ground, colliders)
    this.camera.setSolids(solids)
    this.vehicles.setVisible(zone === 'earth')
    this.npcs.setVisible(zone === 'earth')
    this.events.setVisible(zone === 'earth')

    this.zone = zone
    this.player.exitVehicle(new THREE.Vector3(spawn.x, spawn.y, spawn.z))
    this.player.setVisible(true)
    this.camera.snap(this.player.position)
    this.hud.banner = `ENTERING ${zone.toUpperCase()}`
    this.bannerTimer = 2.6
  }

  private startRocketLaunch() {
    if (this.launch.active || this.trans.phase !== 'none') return
    const order: Zone[] = ['earth', 'mars', 'moon']
    const next = order[(order.indexOf(this.zone) + 1) % order.length]
    this.launch = { active: true, t: 0, target: next }
    this.player.enterVehicle() // hide player; "boards" the rocket
    this.hud.banner = 'LAUNCH SEQUENCE'
    this.bannerTimer = 3
  }

  start() {
    this.engine.start()
    this.hudListener({ ...this.hud })
  }

  private buildNetLine(): THREE.Line {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NET_SEGMENTS * 3), 3))
    const mat = new THREE.LineBasicMaterial({ color: 0x9bff4d, transparent: true, opacity: 0 })
    const line = new THREE.Line(geo, mat)
    line.visible = false
    line.frustumCulled = false
    return line
  }

  private setPaused(p: boolean) {
    if (this.paused === p) return
    this.paused = p
    this.hud.paused = p
    if (p) {
      this.input.setLockEnabled(false)
      this.input.exitLock()
    } else {
      this.input.setLockEnabled(true)
      this.input.requestLock()
    }
    this.hudListener({ ...this.hud, radar: this.radar })
  }

  private handleEnterExit() {
    if (this.vehicles.current) {
      const exitPos = this.vehicles.exit()
      this.player.exitVehicle(exitPos)
      return
    }
    if (this.player.mode !== 'robot' && this.player.mode !== 'plane') return
    const v = this.vehicles.nearest(this.player.position)
    if (!v) return
    if (v.kind === 'rocket') {
      this.vehicles.onEnterRocket?.()
    } else {
      this.player.enterVehicle()
      this.vehicles.enter(v)
    }
  }

  private fireNet() {
    const N = NET_SEGMENTS
    const yaw = this.input.yaw
    this.scratchFwd.set(Math.sin(yaw), 0, Math.cos(yaw))
    const start = this.player.position
    const sx = start.x
    const sy = start.y + 1.3
    const sz = start.z
    const range = config.net.range
    const peak = config.net.arcHeight

    const attr = (this.netLine.geometry as THREE.BufferGeometry).attributes.position as THREE.BufferAttribute
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1)
      attr.setXYZ(
        i,
        sx + this.scratchFwd.x * range * t,
        sy + peak * 4 * t * (1 - t),
        sz + this.scratchFwd.z * range * t,
      )
    }
    attr.needsUpdate = true
    ;(this.netLine.material as THREE.LineBasicMaterial).opacity = 1
    this.netLine.visible = true
    this.netTimer = 0.5

    // Capture the nearest live target inside the forward cone.
    let best: Capturable | null = null
    let bestD = range
    for (const c of this.capturables) {
      if (!c.alive) continue
      const dx = c.position.x - sx
      const dz = c.position.z - sz
      const d = Math.hypot(dx, dz)
      if (d > range || d < 0.001) continue
      if ((dx * this.scratchFwd.x + dz * this.scratchFwd.z) / d < 0.45) continue // ~63° cone
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    if (best) {
      const award = best.capture()
      this.hud.score += Math.round(award * this.scoreMul)
      this.hud.captured += 1
    }
  }

  private updateTransition(dt: number) {
    this.trans.t += dt
    if (this.trans.phase === 'out') {
      this.hud.fade = Math.min(1, this.trans.t / 0.45)
      if (this.trans.t >= 0.45) {
        this.doTravel(this.trans.target)
        this.trans.phase = 'in'
        this.trans.t = 0
      }
    } else if (this.trans.phase === 'in') {
      this.hud.fade = Math.max(0, 1 - this.trans.t / 0.45)
      if (this.trans.t >= 0.45) {
        this.trans.phase = 'none'
        this.hud.fade = 0
      }
    }
  }

  private updateLaunch(dt: number) {
    this.launch.t += dt
    const rocket = this.vehicles.list.find((v) => v.kind === 'rocket')
    if (rocket) {
      rocket.position.y += (4 + this.launch.t * this.launch.t * 9) * dt
      rocket.model.group.position.copy(rocket.position)
      rocket.model.update(dt, 1)
      const cam = this.engine.camera
      cam.position.set(rocket.position.x + 16, rocket.position.y + 5, rocket.position.z + 16)
      cam.lookAt(rocket.position.x, rocket.position.y + 2, rocket.position.z)
      this.focus.copy(rocket.position)
    }
    this.hud.fade = Math.max(0, (this.launch.t - 1.5) / 0.6)
    this.world.update(dt, this.focus)
    if (this.launch.t > 2.1) {
      if (rocket) {
        rocket.position.y = this.physics.sampleGround(rocket.position.x, rocket.position.z, 80)?.y ?? 0
        rocket.model.group.position.copy(rocket.position)
      }
      this.launch.active = false
      this.doTravel(this.launch.target)
      this.trans = { phase: 'in', t: 0, target: this.launch.target }
    }
  }

  private applyPowerup(kind: 'speed' | 'shield' | 'fuel' | 'score') {
    if (kind === 'speed') {
      this.fx.speed = 8
      this.player.speedMul = 1.5
    } else if (kind === 'shield') {
      this.fx.shield = 10
      this.player.shield = true
    } else if (kind === 'score') {
      this.fx.score = 10
      this.scoreMul = 2
    } else {
      this.player.fuel = config.jetpack.fuelMax
      this.hud.banner = 'JETPACK REFUELED'
      this.bannerTimer = 1.4
    }
  }

  private updateEffects(dt: number) {
    if (this.fx.speed > 0 && (this.fx.speed -= dt) <= 0) this.player.speedMul = 1
    if (this.fx.shield > 0 && (this.fx.shield -= dt) <= 0) this.player.shield = false
    if (this.fx.score > 0 && (this.fx.score -= dt) <= 0) this.scoreMul = 1
  }

  private checkPortals() {
    const px = this.player.position.x
    const pz = this.player.position.z
    for (const p of this.zones.portalsFor(this.zone)) {
      if (Math.hypot(px - p.position.x, pz - p.position.z) < p.radius) {
        this.requestTravel(p.target)
        break
      }
    }
  }

  private update = (dt: number, _elapsed: number) => {
    this.input.update()

    // Factory intro cinematic owns the camera until it finishes / is skipped.
    if (this.intro) {
      this.intro.update(dt)
      this.world.update(dt, this.introFocus)
      this.hud.fade = this.intro.fade // cinematic drives the black overlay
      if (this.intro.done) this.finishIntro()
      this.pushHud(dt)
      return
    }

    if (this.input.consumePause()) this.setPaused(!this.paused)
    if (this.paused) {
      this.pushHud(dt)
      return
    }

    this.travelCooldown = Math.max(0, this.travelCooldown - dt)

    if (this.launch.active) {
      this.updateLaunch(dt)
      this.pushHud(dt)
      return
    }
    if (this.trans.phase !== 'none') this.updateTransition(dt)

    const onEarth = this.zone === 'earth'
    const piloting = !!this.vehicles.current

    if (this.input.consumeEdge('enter')) this.handleEnterExit()
    if (!piloting) {
      if (this.input.consumeEdge('morph')) this.player.toggleMorph()
      if (this.input.consumeEdge('chute')) this.player.deployChute()
      if (this.input.consumeEdge('net')) this.fireNet()
    } else {
      // drop unused edges so they don't fire on exit
      this.input.consumeEdge('morph')
      this.input.consumeEdge('chute')
      this.input.consumeEdge('net')
    }

    const gravity = config.zones[this.zone].gravity
    if (onEarth) this.vehicles.update(dt, this.input)

    if (this.vehicles.current) {
      this.player.object.position.copy(this.vehicles.current.position)
      this.focus.copy(this.vehicles.current.position)
    } else {
      this.player.update(dt, this.input, this.physics, gravity)
      const lim = config.world.half - 1
      this.player.position.x = clamp(this.player.position.x, -lim, lim)
      this.player.position.z = clamp(this.player.position.z, -lim, lim)
      this.focus.copy(this.player.position)
      if (this.trans.phase === 'none' && this.travelCooldown === 0) this.checkPortals()
    }

    if (onEarth) this.npcs.update(dt)
    if (onEarth) this.events.update(dt, this.player.position)
    this.updateEffects(dt)
    this.zones.update(dt, this.zone)
    this.camera.update(dt, this.input, this.focus, this.buildFollowState())
    // Keep the (desktop-only) depth-of-field focused on the subject.
    this.engine.setFocusDistance(this.engine.camera.position.distanceTo(this.focus))
    this.world.update(dt, this.focus)

    if (this.netTimer > 0) {
      this.netTimer -= dt
      const o = Math.max(0, this.netTimer / 0.5)
      ;(this.netLine.material as THREE.LineBasicMaterial).opacity = o
      if (this.netTimer <= 0) this.netLine.visible = false
    }

    this.pushHud(dt)
  }

  /** Assemble the modern-cam follow hints for the current control subject. */
  private buildFollowState(): import('./Camera').FollowState {
    const v = this.vehicles.current
    const idle = this.input.sinceLook > config.camera.autoFollowDelay
    if (v) {
      const sp = Math.hypot(v.velocity.x, v.velocity.z)
      const inv = sp > 0.1 ? 1 / sp : 0
      return {
        distanceScale: 1.8,
        followYaw: v.yaw,
        moveX: v.velocity.x * inv,
        moveZ: v.velocity.z * inv,
        speed01: this.vehicles.speedFraction,
        canAutoFollow: idle && sp > 1.5,
      }
    }
    const p = this.player
    const sp = Math.hypot(p.velocity.x, p.velocity.z)
    const inv = sp > 0.1 ? 1 / sp : 0
    const onFoot = p.mode === 'robot' || p.mode === 'plane'
    return {
      distanceScale: p.mode === 'plane' ? 1.35 : 1,
      followYaw: p.yaw,
      moveX: p.velocity.x * inv,
      moveZ: p.velocity.z * inv,
      speed01: clamp(sp / config.player.runSpeed, 0, 1),
      // Trail the robot when it is moving and grounded; planes auto-follow too.
      canAutoFollow: idle && sp > 1.2 && onFoot && (p.grounded || p.mode === 'plane'),
    }
  }

  private computeRadar(): RadarBlip[] {
    const range = 130
    const px = this.focus.x
    const pz = this.focus.z
    const yaw = this.input.yaw
    const fwdX = Math.sin(yaw)
    const fwdZ = Math.cos(yaw)
    const rightX = Math.cos(yaw)
    const rightZ = -Math.sin(yaw)
    const blips: RadarBlip[] = []
    const add = (wx: number, wz: number, kind: RadarBlip['kind']) => {
      const dx = wx - px
      const dz = wz - pz
      if (dx * dx + dz * dz > range * range) return
      blips.push({ x: (dx * rightX + dz * rightZ) / range, y: (dx * fwdX + dz * fwdZ) / range, kind })
    }
    if (this.zone === 'earth') {
      for (const lm of this.world.landmarks) {
        add(lm.x, lm.z, 'building')
        if (blips.length >= 36) break
      }
      for (const v of this.vehicles.list) add(v.position.x, v.position.z, 'vehicle')
      this.npcs.forEachAlive((x, z) => add(x, z, 'npc'))
      this.events.forEachAlien((x, z) => add(x, z, 'alien'))
    }
    for (const p of this.zones.portalsFor(this.zone)) add(p.position.x, p.position.z, 'portal')
    return blips
  }

  private pushHud(dt: number) {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt
      if (this.bannerTimer <= 0) this.hud.banner = null
    }
    this.hudAccum += dt
    if (this.hudAccum < 1 / 20) return
    this.hudAccum = 0
    this.radar = this.computeRadar()

    const piloting = !!this.vehicles.current
    let prompt: string | null = null
    if (piloting) prompt = `Press G - Exit ${this.vehicles.currentName}`
    else if (this.player.mode === 'robot') {
      const near = this.vehicles.nearest(this.player.position)
      if (near) prompt = `Press G - ${near.name}`
    }

    this.hud.fps = Math.round(this.engine.fps)
    this.hud.stamina = this.player.stamina / config.player.staminaMax
    this.hud.fuel = this.player.fuel / config.jetpack.fuelMax
    this.hud.speed = piloting ? this.vehicles.currentSpeed : this.player.speed
    this.hud.altitude = Math.max(0, this.focus.y)
    this.hud.heading = this.input.yaw
    this.hud.mode = piloting ? 'vehicle' : this.player.mode
    this.hud.vehicle = this.vehicles.currentName
    this.hud.prompt = prompt
    this.hud.lookLocked = this.input.locked
    this.hud.radar = this.radar
    this.hud.shield = this.fx.shield > 0
    this.hud.powerup =
      this.fx.speed > 0 ? { kind: 'speed', remaining: this.fx.speed } : this.fx.score > 0 ? { kind: 'score', remaining: this.fx.score } : null

    this.hudListener({ ...this.hud, powerup: this.hud.powerup ? { ...this.hud.powerup } : null })
  }

  dispose() {
    this.input.dispose()
    this.player.dispose()
    this.vehicles.dispose()
    this.npcs.dispose()
    this.zones.dispose()
    this.events.dispose()
    this.intro?.dispose()
    this.assets.dispose()
    const m = this.netLine.material as THREE.Material
    this.netLine.geometry.dispose()
    m.dispose()
    this.engine.dispose()
    this.world.dispose()
  }
}
