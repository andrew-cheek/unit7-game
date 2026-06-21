import * as THREE from 'three'
import { Engine } from './Engine'
import { World } from './World'
import { Input } from './Input'
import { Player } from './Player'
import { Physics } from './Physics'
import { Vehicles, isMech } from './Vehicles'
import { Missiles } from './Missiles'
import { AudioManager } from './Audio'
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
import { loadProfile, saveProfile, type Profile } from './storage'
import type { HudState, MinigameKind, RadarBlip, Unit7Config, Zone } from './types'

/** Something the net can catch (NPCs, aliens). Registered by their systems. */
export interface Capturable {
  position: THREE.Vector3
  alive: boolean
  capture(): number // returns score awarded
}

const NET_SEGMENTS = 22

// Mech unlock costs (credits). mechM is free so the "pilot a mech" objective is
// always reachable; the bigger mechs are earned by capturing aliens.
const MECH_COST: Record<string, number> = { mechM: 0, mechL: 400, mechXL: 1200 }

/** Short haptic pulse on capable devices (mobile). No-op where unsupported. */
function vibrate(pattern: number | number[]) {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(pattern)
  } catch {
    /* ignore */
  }
}

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
  readonly audio = new AudioManager()
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
  // Lightweight objective chain (config.missions). One active at a time.
  private missionIdx = 0
  private missionPopupTimer = 0
  private captureBase = 0
  private minigamePlayed = false
  private heroLight!: THREE.PointLight
  private mechAirborne = false
  private footTimer = 0
  private footLeft = false

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
  private profile: Profile = loadProfile()
  private credits = 0
  private unlocked = new Set<string>()
  private objTarget: THREE.Vector3 | null = null
  private objBeacon!: THREE.Group
  private objBeaconMats: THREE.Material[] = []
  private scratchFwd = new THREE.Vector3()

  // Arcade portals (neon doorways near the spawn that launch the minigames).
  private arcadePortals: { kind: MinigameKind; pos: THREE.Vector3; group: THREE.Group; disc: THREE.Mesh; beam: THREE.Mesh }[] = []
  private arcadeMats: THREE.Material[] = []
  private arcadeGeos: THREE.BufferGeometry[] = []
  private arcadeTex: THREE.CanvasTexture[] = []
  private plazaHub: { group: THREE.Group; ring: THREE.Mesh; ring2: THREE.Mesh; beamMat: THREE.MeshBasicMaterial } | null = null
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
    // A soft "hero" fill light that follows the player so the robot reads against
    // dark backgrounds (rim/hero lighting). Cheap: one point light.
    this.heroLight = new THREE.PointLight(0x9fd8ff, 22, 16, 2)
    this.engine.scene.add(this.heroLight)
    // Credits balance + unlocked vehicles from the saved profile.
    this.credits = this.profile.credits
    this.unlocked = new Set(this.profile.unlocks)
    // Guided objective beacon: a tall glowing column placed at the current goal.
    this.objBeacon = this.buildObjectiveBeacon()
    this.engine.scene.add(this.objBeacon)
    this.vehicles = new Vehicles(this.engine.scene, this.physics)
    this.missiles = new Missiles(this.engine.scene)
    const npcCount = Math.round(config.npc.count * tier.densityScale)
    this.npcs = new NPCManager(this.engine.scene, this.physics, this.capturables, npcCount)
    this.zones = new Zones(this.engine.scene)
    this.zones.setActive('earth')
    this.events = new Events(this.engine.scene, this.physics, this.capturables, (kind) => this.applyPowerup(kind))
    this.events.onSoak = () => {
      this.hud.banner = 'SPLASH!'
      this.bannerTimer = 0.45 // brief, fades fast (it's a side gag now)
      vibrate(30)
      this.audio.play('soak')
    }
    this.patrols = new Patrols(this.engine.scene, this.physics, tier.densityScale)
    this.sky = new Sky(this.engine.scene, tier.densityScale)
    this.camera = new CameraController(this.engine.camera, this.world.solidMeshes)
    this.camera.snap(this.player.position)

    this.buildArcadePortals()

    // Unlock WebAudio on the first user gesture (mobile browsers require it).
    const unlockAudio = () => {
      this.audio.unlock()
      window.removeEventListener('pointerdown', unlockAudio)
      window.removeEventListener('keydown', unlockAudio)
      window.removeEventListener('touchstart', unlockAudio)
    }
    window.addEventListener('pointerdown', unlockAudio)
    window.addEventListener('keydown', unlockAudio)
    window.addEventListener('touchstart', unlockAudio)

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
      toggleMute: () => { this.hud.muted = this.audio.toggleMute() },
    }

    this.hud = {
      mode: 'robot', zone: this.zone, stamina: 1, fuel: 1, score: 0, best: this.profile.best, credits: this.profile.credits, captured: 0,
      speed: 0, altitude: 0, heading: 0, prompt: null, powerup: null, shield: false,
      fps: 60, paused: false, lookLocked: false, loading: false, loadingProgress: 1,
      loadingMsg: '', intro: false, vehicle: null, radar: [], fade: 0, banner: null,
      objective: config.missions[0]?.title ?? null,
      muted: this.audio.isMuted,
      canCapture: false,
      missionPopup: null,
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
    // Intro mission card: tells the player what to do in the first seconds.
    this.hud.missionPopup = { title: 'UNIT 7 ONLINE', body: 'Portal Plaza detected. Follow the neon route to the beam.' }
    this.missionPopupTimer = 5
  }

  // --- Arcade portals ------------------------------------------------------

  private buildArcadePortals() {
    // A neon arcade row of doorways in an arc just ahead of spawn.
    this.arcadePortals.push(this.buildPortal('beamwars', 0x27e7ff, 0x8a5cff, 'BEAM WARS', new THREE.Vector3(-15, 0, 10)))
    this.arcadePortals.push(this.buildPortal('digduel', 0xff8a1e, 0x9bff4d, 'DIG DUEL', new THREE.Vector3(-7.5, 0, 14)))
    this.arcadePortals.push(this.buildPortal('merge2048', 0xff2bd0, 0x27e7ff, '2048', new THREE.Vector3(0, 0, 16)))
    this.arcadePortals.push(this.buildPortal('invaders', 0x9bff4d, 0xff2bd0, 'INVADERS', new THREE.Vector3(7.5, 0, 14)))
    this.arcadePortals.push(this.buildPortal('snake', 0x8a5cff, 0x9bff4d, 'SNAKE', new THREE.Vector3(15, 0, 10)))
    // Two new attractions flank the row (outside the Mars/Moon portals).
    this.arcadePortals.push(this.buildPortal('raceloop', 0xff2bd0, 0x27e7ff, 'RACE LOOP', new THREE.Vector3(-33, 0, 12)))
    this.arcadePortals.push(this.buildPortal('mecharena', 0xff8a1e, 0x27e7ff, 'MECH ARENA', new THREE.Vector3(33, 0, 12)))
    this.buildPlazaHub()
  }

  /**
   * The Portal Plaza hero landmark: a big glowing central ring, a tall sky beam
   * visible from far away, and a neon ground ring marking the plaza. Sits at the
   * centre of the arcade row so "Find Portal Plaza" has an obvious destination.
   */
  private buildPlazaHub() {
    const cx = 0, cz = 13
    const own = <T extends THREE.Material>(m: T) => { this.arcadeMats.push(m); return m }
    const ownG = <T extends THREE.BufferGeometry>(g: T) => { this.arcadeGeos.push(g); return g }
    const g = new THREE.Group()
    const gy = this.physics.sampleGround(cx, cz, 40)?.y ?? 0
    g.position.set(cx, gy, cz)
    // Big vertical hero ring.
    const ring = new THREE.Mesh(ownG(new THREE.TorusGeometry(6, 0.5, 18, 56)), own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, fog: false })))
    ring.position.y = 7
    g.add(ring)
    const ring2 = new THREE.Mesh(ownG(new THREE.TorusGeometry(4.4, 0.28, 14, 48)), own(new THREE.MeshBasicMaterial({ color: 0xff2bd0, fog: false })))
    ring2.position.y = 7
    g.add(ring2)
    // Tall sky beam, visible from across the map.
    const beam = new THREE.Mesh(ownG(new THREE.CylinderGeometry(1.6, 3.4, 220, 20, 1, true)), own(new THREE.MeshBasicMaterial({ color: 0x7fd7ff, transparent: true, opacity: 0.2, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    beam.position.y = 110
    // Explicit renderOrder so this tall additive column always sorts after the
    // city and in a stable slot, instead of swapping order with other
    // transparent layers as the camera moves (the additive-flicker fix).
    beam.renderOrder = 4
    g.add(beam)
    // Neon ground ring marking the plaza floor.
    const decal = new THREE.Mesh(ownG(new THREE.RingGeometry(8, 9.2, 48)), own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.36, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    decal.rotation.x = -Math.PI / 2
    decal.position.y = 0.15
    g.add(decal)
    this.engine.scene.add(g)
    this.plazaHub = { group: g, ring, ring2, beamMat: beam.material as THREE.MeshBasicMaterial }
  }

  private buildPortal(kind: MinigameKind, ringColor: number, discColor: number, label: string, pos: THREE.Vector3) {
    const g = new THREE.Group()
    const gy = this.physics.sampleGround(pos.x, pos.z, 40)?.y ?? 0
    pos.y = gy
    g.position.set(pos.x, gy, pos.z)

    const own = <T extends THREE.Material>(m: T) => { this.arcadeMats.push(m); return m }
    const ownG = <T extends THREE.BufferGeometry>(geo: T) => { this.arcadeGeos.push(geo); return geo }

    const pad = new THREE.Mesh(ownG(new THREE.CylinderGeometry(3.4, 3.8, 0.2, 32)), own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: ringColor, emissiveIntensity: 1.8, roughness: 0.4 })))
    pad.position.y = 0.1
    g.add(pad)

    const ring = new THREE.Mesh(ownG(new THREE.TorusGeometry(3.0, 0.28, 16, 48)), own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: ringColor, emissiveIntensity: 2.0, roughness: 0.4 })))
    ring.position.y = 3.1
    g.add(ring)

    // Portal face: single translucent disc (was blowing out to a white sphere
    // through bloom when stacked over the bright emissive ring/pad).
    const disc = new THREE.Mesh(ownG(new THREE.CircleGeometry(2.85, 48)), own(new THREE.MeshBasicMaterial({ color: discColor, transparent: true, opacity: 0.32, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })))
    disc.position.y = 3.1
    disc.renderOrder = 3
    g.add(disc)

    const beam = new THREE.Mesh(ownG(new THREE.CylinderGeometry(1.2, 2.2, 90, 18, 1, true)), own(new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.26, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    beam.position.y = 45
    // Stable sort slot for the additive column (see plaza beam note).
    beam.renderOrder = 4
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
    this.minigamePlayed = true
    this.audio.play('portal')
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
    // Mechs follow you off-world (pilot your giant robot on Mars/Moon); the cars
    // stay parked on Earth. Missiles can fire in any zone.
    this.vehicles.setZone(zone, spawn)
    this.missiles.setVisible(true)
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
    this.audio.play('portal')
    if (zone !== 'earth') this.world.pushHeadline(`UNIT 7 PILOT TOUCHES DOWN ON ${zone.toUpperCase()}`)
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
    // Locked mech: spend credits to unlock it (this press), enter on the next.
    if (isMech(v.kind) && !this.isUnlocked(v.kind)) {
      const cost = MECH_COST[v.kind] ?? 0
      if (this.credits >= cost) {
        this.addCredits(-cost)
        this.unlocked.add(v.kind)
        this.profile.unlocks = [...this.unlocked]
        saveProfile(this.profile)
        this.hud.banner = `${v.name} UNLOCKED  -${cost} CR`
        this.bannerTimer = 1.8
        this.audio.play('objective')
        vibrate(40)
        this.world.pushHeadline(`PILOT ACQUIRES ${v.name} BATTLE MECH`)
      } else {
        this.hud.banner = `LOCKED · NEED ${cost - this.credits} MORE CR`
        this.bannerTimer = 1.4
        this.audio.play('ui')
      }
      return
    }
    if (v.kind === 'rocket') {
      this.vehicles.onEnterRocket?.()
    } else {
      this.player.enterVehicle()
      this.vehicles.enter(v)
      // Mech boot-up moment: name banner + a quick camera shake.
      if (isMech(v.kind)) {
        this.hud.banner = `${v.name} ONLINE`
        this.bannerTimer = 1.6
        this.camera.shake(0.9)
        vibrate(40)
        this.audio.play('mechOnline')
      }
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
      this.addCredits(Math.round(award * 0.5))
      this.hud.captured += 1
      // Juice: a quick cyan ring pop where the target was netted.
      this.missiles.shockwave({ x: best.position.x, y: best.position.y, z: best.position.z }, 0x27e7ff, 3, 0.4)
      vibrate(25)
      this.audio.play('capture')
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
    this.audio.play('fire')
  }

  private buildObjectiveBeacon(): THREE.Group {
    const g = new THREE.Group()
    const own = <T extends THREE.Material>(m: T) => { this.objBeaconMats.push(m); return m }
    const colMat = own(new THREE.MeshBasicMaterial({ color: 0x9bff4d, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.4, 60, 12, 1, true), colMat)
    col.position.y = 30
    g.add(col)
    const ringMat = own(new THREE.MeshBasicMaterial({ color: 0x9bff4d, transparent: true, opacity: 0.8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.4, 3.2, 28), ringMat)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.4
    g.add(ring)
    g.visible = false
    return g
  }

  private addCredits(n: number) {
    this.credits += n
    this.profile.credits = this.credits
    this.hud.credits = this.credits
  }

  private isUnlocked(kind: string): boolean {
    return !MECH_COST[kind] || this.unlocked.has(kind)
  }

  /** World position the current objective points at (for the beacon + radar). */
  private computeObjectiveTarget(): THREE.Vector3 | null {
    const m = config.missions[this.missionIdx]
    if (!m) return null
    if (m.type === 'reach') return new THREE.Vector3(m.x ?? 0, 0, m.z ?? 0)
    if (this.zone !== 'earth') return null // beacons only guide within the city
    if (m.type === 'mech') {
      // Guide to the nearest mech you can actually board (free/unlocked first).
      let best: THREE.Vector3 | null = null, bd = Infinity
      for (const v of this.vehicles.list) {
        if (!isMech(v.kind) || !this.isUnlocked(v.kind)) continue
        const d = (v.position.x - this.player.position.x) ** 2 + (v.position.z - this.player.position.z) ** 2
        if (d < bd) { bd = d; best = v.position }
      }
      return best ? best.clone() : null
    }
    if (m.type === 'zone') {
      for (const p of this.zones.portalsFor('earth')) if (p.target === m.zone) return p.position.clone()
      return null
    }
    if (m.type === 'minigame') {
      let best: THREE.Vector3 | null = null, bd = Infinity
      for (const p of this.arcadePortals) {
        const d = (p.pos.x - this.player.position.x) ** 2 + (p.pos.z - this.player.position.z) ** 2
        if (d < bd) { bd = d; best = p.pos }
      }
      return best ? best.clone() : null
    }
    return null // capture: no fixed beacon (aliens roam)
  }

  /**
   * Drive the one-active-at-a-time objective chain (config.missions). Detects
   * completion by type, advances with a short banner, and keeps hud.objective in
   * sync. Purely additive: ignored once the chain is finished (free roam).
   */
  private updateObjectives() {
    const list = config.missions
    if (this.missionIdx >= list.length) { this.hud.objective = null; this.objTarget = null; this.objBeacon.visible = false; return }
    const m = list[this.missionIdx]
    let done = false
    switch (m.type) {
      case 'reach':
        done = this.zone === 'earth' && Math.hypot(this.player.position.x - (m.x ?? 0), this.player.position.z - (m.z ?? 0)) < (m.radius ?? 8)
        break
      case 'mech':
        done = !!this.vehicles.current && isMech(this.vehicles.current.kind)
        break
      case 'zone':
        done = this.zone === m.zone
        break
      case 'capture':
        done = this.hud.captured - this.captureBase >= (m.count ?? 1)
        break
      case 'minigame':
        done = this.minigamePlayed
        break
    }
    if (done) {
      this.missionIdx++
      this.hud.banner = 'OBJECTIVE COMPLETE'
      this.bannerTimer = 1.4
      vibrate(40)
      this.audio.play('objective')
      this.world.pushHeadline(`UNIT 7 PILOT COMPLETES "${m.title}"`)
      const nextM = list[this.missionIdx]
      if (nextM?.type === 'capture') this.captureBase = this.hud.captured
      this.hud.objective = nextM?.title ?? 'Free roam: explore the world!'
    } else {
      this.hud.objective = m.title
    }
    // Guided beacon: drop a glowing column on the current goal + show distance.
    this.objTarget = this.computeObjectiveTarget()
    if (this.objTarget && this.zone === 'earth') {
      const gy = this.physics.sampleGround(this.objTarget.x, this.objTarget.z, 80)?.y ?? 0
      this.objBeacon.position.set(this.objTarget.x, gy, this.objTarget.z)
      this.objBeacon.visible = true
      this.objBeacon.rotation.y += 0.4 * (1 / 60)
      const d = Math.round(Math.hypot(this.objTarget.x - this.player.position.x, this.objTarget.z - this.player.position.z))
      if (this.hud.objective) this.hud.objective = `${this.hud.objective} · ${d}m`
    } else {
      this.objBeacon.visible = false
    }
  }

  /**
   * Weight FX for a piloted mech: dust rings + a tiny shake under each foot
   * while striding low over the ground, and a big shockwave + shake when it
   * lands from height. Sells the scale; rings are pooled so it's cheap.
   */
  private updateMechFx(dt: number) {
    const v = this.vehicles.current
    if (!v) return
    const gy = this.physics.sampleGround(v.position.x, v.position.z, v.position.y + 8)?.y ?? 0
    const alt = v.position.y - gy
    const grounded = alt < 2.5 + v.size * 0.6
    // Landing: was in the air, now grounded with downward speed.
    if (this.mechAirborne && grounded && v.velocity.y < -3) {
      this.missiles.shockwave({ x: v.position.x, y: gy, z: v.position.z }, 0xbfe6ff, 7 + v.size * 1.6, 0.6)
      this.camera.shake(0.6)
      vibrate(50)
      this.audio.play('land')
    }
    this.mechAirborne = !grounded
    // Footsteps while striding low and moving.
    const hsp = Math.hypot(v.velocity.x, v.velocity.z)
    if (grounded && hsp > 3 && v.morph < 0.5) {
      this.footTimer -= dt
      if (this.footTimer <= 0) {
        this.footTimer = Math.max(0.3, 0.62 - hsp * 0.008) * (0.85 + v.size * 0.04)
        this.footLeft = !this.footLeft
        const s = (this.footLeft ? -1 : 1) * v.size * 0.6
        const fx = v.position.x + Math.cos(v.yaw) * s
        const fz = v.position.z - Math.sin(v.yaw) * s
        this.missiles.shockwave({ x: fx, y: gy, z: fz }, 0x9fb4d8, 1.6 + v.size * 0.4, 0.4)
        this.camera.shake(0.05 + v.size * 0.01)
        this.audio.play('step')
      }
    }
  }

  /** Apply a missile blast: capture every live target inside the radius. */
  private detonate(pos: THREE.Vector3, radius: number) {
    const r2 = radius * radius
    let hits = 0
    for (const c of this.capturables) {
      if (!c.alive) continue
      const dx = c.position.x - pos.x
      const dz = c.position.z - pos.z
      if (dx * dx + dz * dz > r2) continue
      const award = c.capture()
      this.hud.score += Math.round(award * this.scoreMul)
      this.addCredits(Math.round(award * 0.5))
      this.hud.captured += 1
      hits++
    }
    if (hits > 0) vibrate(40)
    this.audio.play('explosion')
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
      this.input.consumeEdge('chute')
      // In a mech, MORPH transforms between robot and jet form.
      if (this.input.consumeEdge('morph')) {
        const mode = this.vehicles.toggleTransform()
        if (mode) {
          this.hud.banner = mode === 'jet' ? 'JET FORM' : 'ROBOT FORM'
          this.bannerTimer = 1.0
          vibrate(30)
        }
      }
      // In a mech, CAPTURE / FIRE launches missiles.
      if (this.input.consumeEdge('net')) {
        if (this.vehicles.current && isMech(this.vehicles.current.kind)) this.fireMissiles()
      }
    }

    this.missileCooldown = Math.max(0, this.missileCooldown - dt)
    const gravity = config.zones[this.zone].gravity
    // Vehicles update in every zone now (mechs are pilotable off-world).
    this.vehicles.update(dt, this.input)

    if (this.vehicles.current) {
      this.player.object.position.copy(this.vehicles.current.position)
      this.focus.copy(this.vehicles.current.position)
      // Frame the mech around its torso rather than its feet.
      if (isMech(this.vehicles.current.kind)) {
        this.focus.y += this.vehicles.current.size * 3.2
        this.updateMechFx(dt)
      }
    } else {
      this.mechAirborne = false
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

    // Hero fill light trails the subject so the robot/mech stays readable.
    this.heroLight.position.set(this.focus.x + 2, this.focus.y + 6, this.focus.z + 2)
    this.updateObjectives()

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
      ;(p.disc.material as THREE.MeshBasicMaterial).opacity = 0.26 + Math.sin(_elapsed * 3) * 0.1
      ;(p.beam.material as THREE.MeshBasicMaterial).opacity = 0.22 + Math.sin(_elapsed * 2) * 0.06
    }
    // Plaza hero hub: spin the rings, pulse the sky beam.
    if (this.plazaHub) {
      this.plazaHub.group.visible = onEarth
      if (onEarth) {
        this.plazaHub.ring.rotation.z += dt * 0.5
        this.plazaHub.ring2.rotation.z -= dt * 0.8
        this.plazaHub.beamMat.opacity = 0.17 + Math.sin(_elapsed * 1.5) * 0.05
      }
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
        distanceScale: isMech(v.kind) ? Math.min(9, 1.8 + v.size * 0.55) : 1.8,
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
      // Only a few nearby landmarks so the map reads as navigation, not noise.
      let lmCount = 0
      for (const lm of this.world.landmarks) {
        if (lmCount >= 14) break
        add(lm.x, lm.z, 'building'); lmCount++
      }
      for (const v of this.vehicles.list) add(v.position.x, v.position.z, 'vehicle')
      const pp = this.events.policePos
      if (pp) add(pp.x, pp.z, 'vehicle')
      // Cap NPC + alien markers so the minimap stays meaningful.
      let npcCount = 0
      this.npcs.forEachAlive((x, z) => { if (npcCount < 8) { add(x, z, 'npc'); npcCount++ } })
      let alienCount = 0
      this.events.forEachAlien((x, z) => { if (alienCount < 6) { add(x, z, 'alien'); alienCount++ } })
      this.patrols.forEach((x, z, big) => add(x, z, big ? 'alien' : 'vehicle'))
    }
    if (this.zone !== 'moon') this.sky.forEach((x, z) => add(x, z, 'ship'))
    for (const p of this.zones.portalsFor(this.zone)) add(p.position.x, p.position.z, 'portal')
    if (this.zone === 'earth') for (const p of this.arcadePortals) add(p.pos.x, p.pos.z, 'portal')
    if (this.objTarget) add(this.objTarget.x, this.objTarget.z, 'objective') // guide blip
    return blips
  }

  private pushHud(dt: number) {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt
      if (this.bannerTimer <= 0) this.hud.banner = null
    }
    if (this.missionPopupTimer > 0) {
      this.missionPopupTimer -= dt
      if (this.missionPopupTimer <= 0) this.hud.missionPopup = null
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
        ? `${cur.name} - Space/J fly, H fire, T transform, G exit`
        : `Press G - Exit ${this.vehicles.currentName}`
    } else if (this.player.mode === 'robot') {
      const near = this.vehicles.nearest(this.player.position)
      if (near) {
        if (isMech(near.kind) && !this.isUnlocked(near.kind)) {
          const cost = MECH_COST[near.kind] ?? 0
          prompt = this.credits >= cost ? `G - Unlock ${near.name} (${cost} CR)` : `${near.name} LOCKED - need ${cost} CR`
        } else {
          prompt = `Press G - ${near.name}`
        }
      }
    }

    // CAPTURE button only shows when a live target is within net range.
    let canCapture = false
    if (!piloting && this.player.mode === 'robot') {
      const rr = config.net.range * config.net.range
      for (const c of this.capturables) {
        if (!c.alive) continue
        const dx = c.position.x - this.player.position.x
        const dz = c.position.z - this.player.position.z
        if (dx * dx + dz * dz <= rr) { canCapture = true; break }
      }
    }
    this.hud.canCapture = canCapture

    // Track + persist the best score (only writes storage when it improves).
    if (this.hud.score > this.profile.best) {
      this.profile.best = this.hud.score
      saveProfile(this.profile)
    }
    this.hud.best = this.profile.best

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
    // Persist session takings (credits + best are already saved live).
    this.profile.lifetimeCaptured += this.hud.captured
    this.profile.credits = this.credits
    saveProfile(this.profile)
    this.objBeaconMats.forEach((m) => m.dispose())
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
    this.audio.dispose()
    this.engine.dispose()
    this.world.dispose()
  }
}
