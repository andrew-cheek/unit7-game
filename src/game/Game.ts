import * as THREE from 'three'
import { Engine } from './Engine'
import { World } from './World'
import { Input } from './Input'
import { Player } from './Player'
import { Physics } from './Physics'
import { Vehicles, isMech } from './Vehicles'
import { Missiles } from './Missiles'
import { NPCManager } from './NPC'
import { Patrols } from './Patrols'
import { Sky } from './Sky'
import { AssetLoader } from './AssetLoader'
import { Zones } from './Zones'
import { Events } from './Events'
import { Intro } from './Intro'
import { CameraController } from './Camera'
import { config } from './config'
import { detectTier, TIERS } from './tiers'
import { clamp } from './utils'
import type { HudState, MinigameKind, RadarBlip, Unit7Config, Zone } from './types'

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
  readonly missiles: Missiles
  readonly npcs: NPCManager
  readonly patrols: Patrols
  readonly sky: Sky
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
  private missileCooldown = 0
  private invasionTriggered = false
  private scratchFwd = new THREE.Vector3()

  // Arcade portals (neon doorways near the spawn that launch the minigames).
  private arcadePortals: { kind: MinigameKind; pos: THREE.Vector3; group: THREE.Group; disc: THREE.Mesh; beam: THREE.Mesh }[] = []
  private arcadeMats: THREE.Material[] = []
  private arcadeGeos: THREE.BufferGeometry[] = []
  private arcadeTex: THREE.CanvasTexture[] = []
  private inMinigame = false
  private activePortal = new THREE.Vector3()
  private arcadeCooldown = 0

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
    this.missiles = new Missiles(this.engine.scene)
    const npcCount = Math.round(config.npc.count * tier.densityScale)
    this.npcs = new NPCManager(this.engine.scene, this.physics, this.capturables, npcCount)
    this.zones = new Zones(this.engine.scene)
    this.zones.setActive('earth')
    this.events = new Events(this.engine.scene, this.physics, this.capturables, (kind) => this.applyPowerup(kind))
    this.events.onSoak = () => {
      this.hud.banner = 'SPLASH! SOAKED'
      this.bannerTimer = 0.9
    }
    this.patrols = new Patrols(this.engine.scene, this.physics, tier.densityScale)
    this.sky = new Sky(this.engine.scene, tier.densityScale)
    this.camera = new CameraController(this.engine.camera, this.world.solidMeshes)
    this.camera.snap(this.player.position)

    this.buildArcadePortals()

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
      exitMinigame: () => this.exitMinigame(),
      restartIntro: () => this.restartIntro(),
    }

    this.hud = {
      mode: 'robot', zone: this.zone, stamina: 1, fuel: 1, score: 0, captured: 0,
      speed: 0, altitude: 0, heading: 0, prompt: null, powerup: null, shield: false,
      fps: 60, paused: false, lookLocked: false, loading: false, loadingProgress: 1,
      loadingMsg: '', intro: false, vehicle: null, radar: [], fade: 0, banner: null,
      minigame: null,
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
      // Hide the city's ambient life until the cinematic hands off.
      this.patrols.setVisible(false)
      this.sky.setVisible(false)
      for (const p of this.arcadePortals) p.group.visible = false
    }
  }

  /** Replay the opening cinematic from the top (triggered by the HUD button). */
  private restartIntro() {
    if (this.intro || this.inMinigame || this.paused) return
    if (this.vehicles.current) this.player.exitVehicle(this.player.position)
    // The cinematic stages over Earth and hands off at the Earth spawn.
    if (this.zone !== 'earth') this.doTravel('earth')
    this.intro = new Intro(this.engine.scene, this.engine.camera)
    this.hud.intro = true
    this.player.setVisible(false)
    this.input.setLockEnabled(false)
    this.input.exitLock()
    this.patrols.setVisible(false)
    this.sky.setVisible(false)
    for (const p of this.arcadePortals) p.group.visible = false
    this.hudListener({ ...this.hud, radar: this.radar })
  }

  private finishIntro() {
    this.intro?.dispose()
    this.intro = null
    this.hud.intro = false
    this.player.exitVehicle(this.world.spawn.clone())
    this.player.setVisible(true)
    this.camera.snap(this.player.position)
    this.input.setLockEnabled(true)
    // Bring the city's ambient life back for gameplay.
    this.patrols.setVisible(this.zone === 'earth')
    this.sky.setVisible(this.zone !== 'moon')
    // The cinematic ended on black; fade back in on the gameplay side so the
    // hand-off to the follow camera reads as one continuous shot.
    this.hud.fade = 1
    this.trans = { phase: 'in', t: 0, target: this.zone }
    this.hud.banner = 'WELCOME TO UNIT 7'
    this.bannerTimer = 2.4
  }

  // --- Arcade portals ------------------------------------------------------

  private buildArcadePortals() {
    // Two neon doorways just ahead of the spawn, side by side.
    this.arcadePortals.push(this.buildPortal('beamwars', 0x27e7ff, 0x8a5cff, 'BEAM WARS', new THREE.Vector3(-6, 0, 12)))
    this.arcadePortals.push(this.buildPortal('digduel', 0xff8a1e, 0x9bff4d, 'DIG DUEL', new THREE.Vector3(10, 0, 12)))
  }

  private buildPortal(kind: MinigameKind, ringColor: number, discColor: number, label: string, pos: THREE.Vector3) {
    const g = new THREE.Group()
    const gy = this.physics.sampleGround(pos.x, pos.z, 40)?.y ?? 0
    pos.y = gy
    g.position.set(pos.x, gy, pos.z)

    const own = <T extends THREE.Material>(m: T) => { this.arcadeMats.push(m); return m }
    const ownG = <T extends THREE.BufferGeometry>(geo: T) => { this.arcadeGeos.push(geo); return geo }

    const pad = new THREE.Mesh(ownG(new THREE.CylinderGeometry(3.4, 3.8, 0.2, 32)), own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: ringColor, emissiveIntensity: 2.8, roughness: 0.4 })))
    pad.position.y = 0.1
    g.add(pad)

    const ring = new THREE.Mesh(ownG(new THREE.TorusGeometry(3.0, 0.28, 16, 48)), own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: ringColor, emissiveIntensity: 3.4, roughness: 0.4 })))
    ring.position.y = 3.1
    g.add(ring)

    const disc = new THREE.Mesh(ownG(new THREE.CircleGeometry(2.85, 48)), own(new THREE.MeshBasicMaterial({ color: discColor, transparent: true, opacity: 0.55, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })))
    disc.position.y = 3.1
    g.add(disc)

    const beam = new THREE.Mesh(ownG(new THREE.CylinderGeometry(1.2, 2.2, 90, 18, 1, true)), own(new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.4, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    beam.position.y = 45
    g.add(beam)

    const tex = this.makeLabelTexture(label, ringColor)
    this.arcadeTex.push(tex)
    const sprite = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })))
    sprite.position.set(0, 6.6, 0)
    sprite.scale.set(6.5, 1.6, 1)
    g.add(sprite)

    this.engine.scene.add(g)
    return { kind, pos: pos.clone(), group: g, disc, beam }
  }

  /** A neon text label baked to a canvas texture for a billboard sprite. */
  private makeLabelTexture(text: string, color = 0x27e7ff): THREE.CanvasTexture {
    const cv = document.createElement('canvas')
    cv.width = 512
    cv.height = 128
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.font = '800 72px ui-monospace, Menlo, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowColor = '#' + color.toString(16).padStart(6, '0')
    ctx.shadowBlur = 22
    ctx.fillStyle = '#eaf6ff'
    ctx.fillText(text, cv.width / 2, cv.height / 2)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  private checkArcadePortals() {
    if (this.inMinigame || this.arcadeCooldown > 0 || this.player.mode !== 'robot') return
    for (const p of this.arcadePortals) {
      const dx = this.player.position.x - p.pos.x
      const dz = this.player.position.z - p.pos.z
      if (dx * dx + dz * dz < 3.4 * 3.4) {
        this.enterMinigame(p.kind, p.pos)
        return
      }
    }
  }

  private enterMinigame(kind: MinigameKind, pos: THREE.Vector3) {
    this.inMinigame = true
    this.hud.minigame = kind
    this.activePortal.copy(pos)
    this.input.setLockEnabled(false)
    this.input.exitLock()
    this.hudListener({ ...this.hud, radar: this.radar })
    this.engine.stop() // freeze + stop rendering the city behind the overlay
  }

  private exitMinigame() {
    if (!this.inMinigame) return
    this.inMinigame = false
    this.hud.minigame = null
    // Step the robot out of the doorway (toward spawn) so it doesn't re-trigger.
    const out = this.scratchFwd.subVectors(this.world.spawn, this.activePortal)
    out.y = 0
    if (out.lengthSq() < 1e-4) out.set(0, 0, 1)
    out.normalize()
    this.player.position.set(this.activePortal.x, this.activePortal.y, this.activePortal.z).addScaledVector(out, 4)
    this.player.position.y = this.physics.sampleGround(this.player.position.x, this.player.position.z, this.player.position.y + 4)?.y ?? this.activePortal.y
    this.arcadeCooldown = 1.5
    this.input.consumePause() // drop any Escape pressed inside the minigame
    this.input.setLockEnabled(true)
    this.camera.snap(this.player.position)
    this.engine.start()
    this.hudListener({ ...this.hud, radar: this.radar })
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
    this.missiles.setVisible(zone === 'earth')
    this.npcs.setVisible(zone === 'earth')
    this.events.setVisible(zone === 'earth')
    this.patrols.setVisible(zone === 'earth')
    this.sky.setVisible(zone !== 'moon') // ships fly over Earth and Mars

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

  /**
   * Mech weapon: fire a pair of missiles forward from the shoulder pods. Muzzle
   * height + spread scale with the mech's size. Detonation damage is applied in
   * `detonate` when each missile lands.
   */
  private fireMissiles() {
    const v = this.vehicles.current
    if (!v || !isMech(v.kind)) return
    if (this.missileCooldown > 0) return
    this.missileCooldown = 0.45
    const size = v.size
    this.scratchFwd.set(Math.sin(v.yaw), 0, Math.cos(v.yaw))
    const right = new THREE.Vector3(Math.cos(v.yaw), 0, -Math.sin(v.yaw))
    const muzzleY = v.position.y + 4.0 * size
    for (const sx of [-1.3, 1.3]) {
      const origin = new THREE.Vector3(
        v.position.x + right.x * sx * size + this.scratchFwd.x * 1.2 * size,
        muzzleY,
        v.position.z + right.z * sx * size + this.scratchFwd.z * 1.2 * size,
      )
      // Slight upward lob so they arc out and come down on targets.
      const dir = new THREE.Vector3(this.scratchFwd.x, 0.12, this.scratchFwd.z)
      this.missiles.fire(origin, dir, 80, 2.8)
    }
    this.hud.banner = 'MISSILES AWAY'
    this.bannerTimer = 0.8
  }

  /** Apply a missile blast: capture every live target inside the radius. */
  private detonate(pos: THREE.Vector3, radius: number) {
    const r2 = radius * radius
    for (const c of this.capturables) {
      if (!c.alive) continue
      const dx = c.position.x - pos.x
      const dz = c.position.z - pos.z
      if (dx * dx + dz * dz > r2) continue
      const award = c.capture()
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
    this.arcadeCooldown = Math.max(0, this.arcadeCooldown - dt)

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
      // In a mech, CAPTURE / FIRE launches missiles.
      if (this.input.consumeEdge('net')) {
        if (this.vehicles.current && isMech(this.vehicles.current.kind)) this.fireMissiles()
      }
    }

    this.missileCooldown = Math.max(0, this.missileCooldown - dt)
    const gravity = config.zones[this.zone].gravity
    if (onEarth) this.vehicles.update(dt, this.input)

    if (this.vehicles.current) {
      this.player.object.position.copy(this.vehicles.current.position)
      this.focus.copy(this.vehicles.current.position)
      // Frame the mech around its torso rather than its feet.
      if (isMech(this.vehicles.current.kind)) this.focus.y += this.vehicles.current.size * 3.2
    } else {
      this.player.update(dt, this.input, this.physics, gravity)
      const lim = config.world.half - 1
      this.player.position.x = clamp(this.player.position.x, -lim, lim)
      this.player.position.z = clamp(this.player.position.z, -lim, lim)
      this.focus.copy(this.player.position)
      if (this.trans.phase === 'none' && this.travelCooldown === 0) this.checkPortals()
      if (onEarth && this.trans.phase === 'none') this.checkArcadePortals()
    }

    // When the sun finishes rising, the aliens invade (once).
    if (onEarth && !this.invasionTriggered && this.world.dayFactor >= 0.96) {
      this.invasionTriggered = true
      this.events.startInvasion(this.player.position)
      this.hud.banner = 'ALIEN INVASION'
      this.bannerTimer = 2.4
    }

    if (onEarth) this.npcs.update(dt, this.player.position)
    if (onEarth) this.events.update(dt, this.player.position)
    if (onEarth) this.patrols.update(dt)
    this.missiles.update(dt, (x, z) => this.physics.sampleGround(x, z, 200)?.y ?? 0, (pos, r) => this.detonate(pos, r))
    if (this.zone !== 'moon') this.sky.update(dt) // sky traffic on Earth + Mars
    this.updateEffects(dt)
    this.zones.update(dt, this.zone)
    this.camera.update(dt, this.input, this.focus, this.buildFollowState())
    // Keep the (desktop-only) depth-of-field focused on the subject.
    this.engine.setFocusDistance(this.engine.camera.position.distanceTo(this.focus))
    this.world.update(dt, this.focus)

    // Animate the arcade portals (Earth only).
    for (const p of this.arcadePortals) {
      p.group.visible = onEarth
      if (!onEarth) continue
      p.disc.rotation.z += dt * 1.6
      ;(p.disc.material as THREE.MeshBasicMaterial).opacity = 0.4 + Math.sin(_elapsed * 3) * 0.15
      ;(p.beam.material as THREE.MeshBasicMaterial).opacity = 0.32 + Math.sin(_elapsed * 2) * 0.08
    }

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
        // Mechs are tall; pull the camera back proportionally to frame them.
        distanceScale: isMech(v.kind) ? Math.min(5, 1.8 + v.size * 0.5) : 1.8,
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
      const pp = this.events.policePos
      if (pp) add(pp.x, pp.z, 'vehicle')
      this.npcs.forEachAlive((x, z) => add(x, z, 'npc'))
      this.events.forEachAlien((x, z) => add(x, z, 'alien'))
      this.patrols.forEach((x, z, big) => add(x, z, big ? 'alien' : 'vehicle'))
    }
    if (this.zone !== 'moon') this.sky.forEach((x, z) => add(x, z, 'ship'))
    for (const p of this.zones.portalsFor(this.zone)) add(p.position.x, p.position.z, 'portal')
    if (this.zone === 'earth') for (const p of this.arcadePortals) add(p.pos.x, p.pos.z, 'portal')
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
    if (piloting) {
      const cur = this.vehicles.current!
      prompt = isMech(cur.kind)
        ? `${cur.name} - Space/J fly, H fire, G exit`
        : `Press G - Exit ${this.vehicles.currentName}`
    } else if (this.player.mode === 'robot') {
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
    this.missiles.dispose()
    this.npcs.dispose()
    this.patrols.dispose()
    this.sky.dispose()
    this.zones.dispose()
    this.events.dispose()
    this.intro?.dispose()
    this.assets.dispose()
    const m = this.netLine.material as THREE.Material
    this.netLine.geometry.dispose()
    m.dispose()
    this.arcadeGeos.forEach((g) => g.dispose())
    this.arcadeMats.forEach((mm) => mm.dispose())
    this.arcadeTex.forEach((t) => t.dispose())
    this.engine.dispose()
    this.world.dispose()
  }
}
