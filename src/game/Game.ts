import * as THREE from 'three'
import { Engine } from './Engine'
import { World } from './World'
import { Input } from './Input'
import { Player } from './Player'
import { Physics } from './Physics'
import { Vehicles, isMech } from './Vehicles'
import { createMechSuit, type VehicleModel } from './procedural'
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
import { Net, type NetState, type ScoreRow } from './Net'
import { RemotePlayers } from './RemotePlayers'
import { SharedAliens } from './SharedAliens'
import { WorldEvents } from './WorldEvents'
import { ExplorationPoints } from './ExplorationPoints'
import { Playground } from './Playground'
import { DawnShow } from './DawnShow'
import { config } from './config'
import { detectTier, TIERS } from './tiers'
import { clamp } from './utils'
import { trackEvent } from '../lib/analytics'
import { loadProfile, saveProfile, loadHighScore, saveHighScore, type Profile } from './storage'
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

  private cfg: Required<Pick<Unit7Config, 'startInIntro' | 'quality' | 'initialZone'>>
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
  private arcadePortals: { kind: MinigameKind; pos: THREE.Vector3; group: THREE.Group; screenMat: THREE.MeshStandardMaterial }[] = []
  // The colossal Unit-7 robot presiding over the arcade (the hub centerpiece).
  private arcadeRobot: VehicleModel | null = null
  // A short "conveyed in" transport beat played when you step onto a cabinet,
  // before the minigame entry fires.
  private pendingEntry: { kind: MinigameKind; pos: THREE.Vector3; t: number; beam: THREE.Mesh } | null = null
  private arcadeMats: THREE.Material[] = []
  private arcadeGeos: THREE.BufferGeometry[] = []
  private arcadeTex: THREE.CanvasTexture[] = []
  private plazaHub: { group: THREE.Group; ring: THREE.Mesh; ring2: THREE.Mesh; beamMat: THREE.MeshBasicMaterial } | null = null
  private rocketGate: THREE.Group | null = null
  private inMinigame = false
  private activePortal = new THREE.Vector3()
  private arcadeCooldown = 0

  // Shared-world multiplayer. `net` is null until the player joins with a name.
  private net: Net | null = null
  private remotePlayers!: RemotePlayers
  private sharedAliens!: SharedAliens
  private worldEvents!: WorldEvents
  private exploration!: ExplorationPoints
  private playground!: Playground
  private dawnShow!: DawnShow
  private danceToggle = false // 'B' key toggle for the robot dance emote
  private stuckT = 0 // time spent wedged while trying to move (triggers recovery)
  private timeFromQuery = false // ?time= debug override present (skip morning start)
  // Neon density/quality setting (persisted): scales city neon + bloom.
  private neonLevel: 'low' | 'med' | 'high' = (() => { const v = loadHighScore('neon'); return v === 1 ? 'low' : v === 2 ? 'med' : 'high' })()
  private neonBloomMul = 1
  // Transient steam puffs for the mech boot-up burst.
  private bootPuffs: { mesh: THREE.Mesh; vy: number; t: number; ttl: number; mat: THREE.MeshBasicMaterial }[] = []
  private bootGeo = new THREE.SphereGeometry(1, 10, 8)
  // Bubble-gun projectiles that burst into the crowd-floating effect.
  private bubbleShots: { mesh: THREE.Mesh; vel: THREE.Vector3; t: number }[] = []
  private bubbleShotGeo = new THREE.SphereGeometry(0.5, 12, 10)
  private bubbleShotMat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
  private netAccum = 0
  private online = 1 // players in the world incl. self (1 = solo)
  private leaderboard: ScoreRow[] = []

  // --- analytics state (GA via trackEvent; never affects gameplay) ----------
  private multiplayerEnabled: boolean
  private gameStarted = false // game_start fired exactly once per (re)entry
  private startedMode: 'solo' | 'multiplayer' | null = null // remembered for cinematic replays
  private sessionStartMs = 0 // perf.now() at game_start, for game_over duration
  private lastScoreMilestone = 0 // highest 100-pt milestone already reported
  private caughtCount = 0 // times the player has been caught (soaked)
  private lastCaughtMs = -1e9 // throttles player_caught during balloon barrages
  private prevJetHeld = false // jetpack rising-edge debounce
  private prevBoostHeld = false // boost rising-edge debounce
  private minigameStartMs = 0 // perf.now() on arcade entry, for minigame_end duration

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
    this.multiplayerEnabled = userConfig.multiplayer !== false
    this.hudListener = hudListener

    this.engine = new Engine(container, tier)
    this.world = new World(this.engine.scene, this.zone)
    // Debug: jump the day/night clock with ?time=<seconds into the 120s cycle>.
    if (typeof location !== 'undefined') {
      const t = new URLSearchParams(location.search).get('time')
      if (t != null && !Number.isNaN(Number(t))) { this.world.setDebugTime(Number(t)); this.timeFromQuery = true }
    }
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
    this.remotePlayers = new RemotePlayers(this.engine.scene)
    this.sharedAliens = new SharedAliens(this.engine.scene)
    // Ambient world events (ship flyovers, drone swarms, meteors, cargo drops)
    // and off-path exploration rewards (discoveries + collectible energy cores).
    this.worldEvents = new WorldEvents(this.engine.scene)
    this.worldEvents.onEvent = (label) => {
      if (this.bannerTimer <= 0) { this.hud.banner = label; this.bannerTimer = 1.8 }
    }
    this.exploration = new ExplorationPoints(this.engine.scene, (credits, label) => {
      this.addCredits(credits)
      this.hud.banner = `${label} +${credits}`
      this.bannerTimer = 1.8
      this.audio.play('capture')
      vibrate(20)
    })
    // Interactive toys: trampoline bounce pads (all zones) + a city dance floor.
    this.playground = new Playground(this.engine.scene)
    // Day/night spectacle: solar trees + dawn arrival / dusk departure shuttle.
    this.dawnShow = new DawnShow(this.engine.scene, this.physics)
    this.events = new Events(this.engine.scene, this.physics, this.capturables, (kind) => this.applyPowerup(kind))
    this.events.onSoak = () => {
      this.hud.banner = 'SPLASH!'
      this.bannerTimer = 0.45 // brief, fades fast (it's a side gag now)
      vibrate(30)
      this.audio.play('soak')
      this.onPlayerCaught()
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
      skipIntro: () => {
        if (this.intro && !this.intro.done) trackEvent('intro_skipped')
        this.intro?.skip()
      },
      requestPointerLock: () => this.input.requestLock(),
      exitMinigame: () => this.exitMinigame(),
      restartIntro: () => this.restartIntro(),
      toggleMute: () => { this.hud.muted = this.audio.toggleMute(); trackEvent('mute_toggled', { muted: this.hud.muted }) },
      cycleNeon: () => this.cycleNeon(),
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
      online: 1,
      leaderboard: [],
      neon: this.neonLevel,
    }
    // After hud + world exist: apply the persisted neon level (sets density + bloom).
    this.applyNeon()

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
      if (this.arcadeRobot) this.arcadeRobot.group.visible = false
    } else {
      // No cinematic: drop straight into the morning arrival.
      this.startMorning()
      // Without multiplayer there's no join/solo prompt, so control begins now.
      if (!this.multiplayerEnabled) this.emitGameStart('solo')
    }
  }

  /**
   * Fire game_start once per (re)entry into the world. Records the mode (for a
   * later cinematic replay) and the session clock (for game_over duration).
   */
  private emitGameStart(mode: 'solo' | 'multiplayer') {
    if (this.gameStarted) return
    this.gameStarted = true
    this.startedMode = mode
    this.sessionStartMs = typeof performance !== 'undefined' ? performance.now() : 0
    trackEvent('game_start', { mode, zone: this.zone })
  }

  /**
   * Called by the React shell when the player dismisses the join prompt with
   * "play solo". Keeping the trackEvent inside the engine layer means src/game
   * stays free of React and the shell just pokes a plain method.
   */
  startSolo() {
    this.emitGameStart('solo')
  }

  /** Count + report a "caught" hit (water-balloon soak), throttled so a balloon
   * barrage can't spam GA. The running tally also feeds game_over's `caught`. */
  private onPlayerCaught() {
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (now - this.lastCaughtMs < 1500) return
    this.lastCaughtMs = now
    this.caughtCount += 1
    trackEvent('player_caught', { caught_count: this.caughtCount })
  }

  /** Fire game_over with the session summary. No-op if the world never started. */
  private emitGameOver() {
    if (!this.gameStarted) return
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    const duration_seconds = this.sessionStartMs ? Math.round((now - this.sessionStartMs) / 1000) : 0
    trackEvent('game_over', {
      score: this.hud.score,
      best: this.profile.best,
      caught: this.caughtCount,
      credits: this.credits,
      zone: this.zone,
      duration_seconds,
    })
  }

  /** Replay the opening cinematic from the top (triggered by the HUD button). */
  private restartIntro() {
    if (this.intro || this.inMinigame || this.paused) return
    // Replaying the cinematic ends the current run; finishIntro re-emits
    // game_start (with the same mode) when control hands back.
    this.emitGameOver()
    this.gameStarted = false
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
    if (this.arcadeRobot) this.arcadeRobot.group.visible = false
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
    this.startMorning()
    // Control hands off here. On a cinematic replay the solo/multiplayer choice
    // was already made, so re-announce it; on a first run with multiplayer
    // disabled there's no join prompt, so the world begins now. (With multiplayer
    // enabled, game_start waits for the join/solo choice in the React shell.)
    if (this.startedMode) this.emitGameStart(this.startedMode)
    else if (!this.multiplayerEnabled) this.emitGameStart('solo')
  }

  /**
   * Begin gameplay in the early morning so the dawn arrival plays as you take
   * control: the sun is rising, the shuttle descends and drops workers who head
   * into the offices, and the commuter buses run their stops. The robots already
   * at the desks / charging stay put (they don't keep the humans' 9-7 hours).
   */
  private startMorning() {
    if (this.timeFromQuery || this.zone !== 'earth') return
    this.world.setDebugTime(7) // just into the 5s..15s dawn ramp
    this.dawnShow.resetClock()
  }

  // --- Arcade portals ------------------------------------------------------

  private buildArcadePortals() {
    // The arcade is a row of cabinets in front of a colossal Unit-7 robot that
    // presides over the whole hub. Stepping onto a cabinet "conveys" you in (a
    // transport beam) and drops you into its game - a 2D cabinet game, or a
    // planet (Mars / Moon) reskinned as just another cabinet.
    const A = config.palette
    this.arcadePortals.push(this.buildCabinet('beamwars', A.cyan, 'BEAM WARS', new THREE.Vector3(-15, 0, 10)))
    this.arcadePortals.push(this.buildCabinet('digduel', A.orange, 'DIG DUEL', new THREE.Vector3(-7.5, 0, 14)))
    this.arcadePortals.push(this.buildCabinet('merge2048', A.magenta, '2048', new THREE.Vector3(0, 0, 16)))
    this.arcadePortals.push(this.buildCabinet('invaders', A.lime, 'INVADERS', new THREE.Vector3(7.5, 0, 14)))
    this.arcadePortals.push(this.buildCabinet('snake', A.purple, 'SNAKE', new THREE.Vector3(15, 0, 10)))
    this.arcadePortals.push(this.buildCabinet('raceloop', A.magenta, 'RACE LOOP', new THREE.Vector3(-33, 0, 12)))
    this.arcadePortals.push(this.buildCabinet('mecharena', A.orange, 'MECH ARENA', new THREE.Vector3(33, 0, 12)))
    // Planet/moon travel stays as its own separate ring-portals (built in Zones),
    // NOT arcade cabinets: the arcade takes you to the mini-games, the portals
    // take you to other worlds.
    this.buildArcadeRobot()
    this.buildPlazaHub()
    this.buildRocketGate()
  }

  /** One arcade cabinet bound to a 2D minigame. */
  private buildCabinet(kind: MinigameKind, color: number, label: string, pos: THREE.Vector3) {
    const { group, screenMat } = this.makeCabinet(color, label, pos)
    return { kind, pos: pos.clone(), group, screenMat }
  }

  /**
   * Builds the cabinet fixture: a dark body with a glowing screen and marquee
   * facing the approaching player (toward -Z / the spawn), a control lip, and a
   * faint stand-here floor pad. Returns the group and the screen material so the
   * update loop can pulse it. Replaces the old glowing-ring portal look.
   */
  private makeCabinet(color: number, label: string, pos: THREE.Vector3) {
    const own = <T extends THREE.Material>(m: T) => { this.arcadeMats.push(m); return m }
    const ownG = <T extends THREE.BufferGeometry>(geo: T) => { this.arcadeGeos.push(geo); return geo }
    const gy = this.physics.sampleGround(pos.x, pos.z, 40)?.y ?? 0
    pos.y = gy
    const g = new THREE.Group()
    g.position.set(pos.x, gy, pos.z)
    // Face the player approaching from spawn (south, -Z): screen on the -Z face.
    const bodyMat = own(new THREE.MeshStandardMaterial({ color: 0x0b0e16, metalness: 0.5, roughness: 0.5 }))
    const trimMat = own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: 1.6, roughness: 0.4 }))
    const screenMat = own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: 1.5, roughness: 0.3 }))

    const body = new THREE.Mesh(ownG(new THREE.BoxGeometry(3.2, 4.2, 1.8)), bodyMat)
    body.position.y = 2.1
    g.add(body)
    // Glowing screen, tilted back slightly, on the front (-Z) face.
    const tex = this.makeLabelTexture(label, color)
    this.arcadeTex.push(tex)
    const screenFace = own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.4, roughness: 0.3 }))
    const screen = new THREE.Mesh(ownG(new THREE.PlaneGeometry(2.5, 1.6)), screenFace)
    screen.position.set(0, 2.6, -0.92)
    screen.rotation.x = 0.12
    g.add(screen)
    // Marquee header strip.
    const marquee = new THREE.Mesh(ownG(new THREE.BoxGeometry(3.0, 0.5, 0.2)), trimMat)
    marquee.position.set(0, 4.0, -0.85)
    g.add(marquee)
    // Side neon trim.
    for (const sx of [-1.55, 1.55]) {
      const strip = new THREE.Mesh(ownG(new THREE.BoxGeometry(0.12, 3.6, 0.12)), trimMat)
      strip.position.set(sx, 2.2, -0.86)
      g.add(strip)
    }
    // Stand-here floor pad.
    const pad = new THREE.Mesh(ownG(new THREE.RingGeometry(1.4, 1.8, 28)), own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    pad.rotation.x = -Math.PI / 2
    pad.position.set(0, 0.06, -2.2)
    g.add(pad)
    // Keep the body from being walked through.
    this.physics.colliders.push(new THREE.Box3(
      new THREE.Vector3(pos.x - 1.6, 0, pos.z - 0.9),
      new THREE.Vector3(pos.x + 1.6, 4.2, pos.z + 0.9),
    ))
    this.engine.scene.add(g)
    return { group: g, screenMat }
  }

  /**
   * The colossal Unit-7 robot at the back of the arcade, presiding over the
   * cabinet row. Reuses the battle-mech model at hub scale (~70m), turned to
   * face the player, with a big ARCADE marquee. Prototype: it's the landmark /
   * "the arcade is a giant robot" read; the cabinets are the working portals.
   */
  private buildArcadeRobot() {
    const SCALE = 13
    const robot = createMechSuit({ scale: SCALE, armor: 0x1b2336, trim: config.palette.cyan, core: 0x6fd8ff })
    const x = 0, z = 44
    const gy = this.physics.sampleGround(x, z, 60)?.y ?? 0
    // The model's feet sit ~0.3 below its origin; lift by that x scale so the
    // colossus stands on the ground rather than sinking into it.
    robot.group.position.set(x, gy + 0.3 * SCALE, z)
    robot.group.rotation.y = Math.PI // face -Z, toward the player / cabinets
    this.engine.scene.add(robot.group)
    this.arcadeRobot = robot
    // ARCADE marquee floating in front of the robot's chest.
    const tex = this.makeLabelTexture('ARCADE', config.palette.cyan)
    this.arcadeTex.push(tex)
    const signMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
    this.arcadeMats.push(signMat)
    const sign = new THREE.Sprite(signMat)
    sign.position.set(0, gy + 40, z - 8)
    sign.scale.set(30, 7.5, 1)
    this.engine.scene.add(sign)
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
    const ring = new THREE.Mesh(ownG(new THREE.TorusGeometry(6, 0.5, 18, 56)), own(new THREE.MeshBasicMaterial({ color: 0x1aa6c4, fog: false })))
    ring.position.y = 7
    g.add(ring)
    const ring2 = new THREE.Mesh(ownG(new THREE.TorusGeometry(4.4, 0.28, 14, 48)), own(new THREE.MeshBasicMaterial({ color: 0xc41f9e, fog: false })))
    ring2.position.y = 7
    g.add(ring2)
    // Tall sky beam, visible from across the map.
    const beam = new THREE.Mesh(ownG(new THREE.CylinderGeometry(1.4, 2.6, 220, 20, 1, true)), own(new THREE.MeshBasicMaterial({ color: 0x7fd7ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    beam.position.y = 110
    // Explicit renderOrder so this tall additive column always sorts after the
    // city and in a stable slot, instead of swapping order with other
    // transparent layers as the camera moves (the additive-flicker fix).
    beam.renderOrder = 4
    g.add(beam)
    // Neon ground ring marking the plaza floor.
    const decal = new THREE.Mesh(ownG(new THREE.RingGeometry(8, 9.2, 48)), own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.22, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    decal.rotation.x = -Math.PI / 2
    decal.position.y = 0.15
    g.add(decal)
    this.engine.scene.add(g)
    this.plazaHub = { group: g, ring, ring2, beamMat: beam.material as THREE.MeshBasicMaterial }
  }

  /**
   * Dresses the parked rocket (at 2,-20) as an obvious off-world gateway: a
   * glowing launch-pad ring on the ground and a tall readable sign, so it reads
   * as "go to Mars / the Moon", not background scenery. Earth-only.
   */
  private buildRocketGate() {
    const own = <T extends THREE.Material>(m: T) => { this.arcadeMats.push(m); return m }
    const ownG = <T extends THREE.BufferGeometry>(g: T) => { this.arcadeGeos.push(g); return g }
    const x = 2, z = -20
    const gy = this.physics.sampleGround(x, z, 40)?.y ?? 0
    const g = new THREE.Group()
    g.position.set(x, gy, z)
    const ring = new THREE.Mesh(ownG(new THREE.RingGeometry(5, 6.3, 44)), own(new THREE.MeshBasicMaterial({ color: config.palette.orange, transparent: true, opacity: 0.45, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.14
    g.add(ring)
    const tex = this.makeLabelTexture('LAUNCH → MARS / MOON', config.palette.orange)
    this.arcadeTex.push(tex)
    const sign = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })))
    sign.position.set(0, 17, 0)
    sign.scale.set(15, 3.75, 1)
    g.add(sign)
    this.engine.scene.add(g)
    this.rocketGate = g
  }

  /** A neon text label baked to a canvas texture for a billboard sprite. */
  private makeLabelTexture(text: string, color = 0x27e7ff): THREE.CanvasTexture {
    const cv = document.createElement('canvas')
    cv.width = 512
    cv.height = 128
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, cv.width, cv.height)
    // Shrink the font until the label fits the canvas, so longer signage
    // ("LAUNCH -> MARS / MOON") doesn't clip at the edges.
    let size = 72
    ctx.font = `800 ${size}px ui-monospace, Menlo, monospace`
    while (size > 30 && ctx.measureText(text).width > cv.width - 36) {
      size -= 4
      ctx.font = `800 ${size}px ui-monospace, Menlo, monospace`
    }
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
    if (this.inMinigame || this.pendingEntry || this.arcadeCooldown > 0 || this.player.mode !== 'robot') return
    if (this.trans.phase !== 'none') return
    // The stand-here pad is in front of the cabinet (toward -Z), so trigger on
    // proximity to the pad point, not the cabinet body.
    for (const p of this.arcadePortals) {
      if (this.nearCabinetPad(p.pos)) { this.startTransport(p.pos, p.kind); return }
    }
  }

  private nearCabinetPad(pos: THREE.Vector3) {
    const dx = this.player.position.x - pos.x
    const dz = this.player.position.z - (pos.z - 2.2) // pad sits 2.2 in front (-Z)
    return dx * dx + dz * dz < 2.2 * 2.2
  }

  /**
   * Begins the "conveyed in" transport: spawns a bright beam column at the
   * cabinet pad. When the short beat elapses (in update), the minigame entry
   * fires. This animation IS the portal. The pending flag blocks re-triggering
   * other cabinets meanwhile.
   */
  private startTransport(pos: THREE.Vector3, kind: MinigameKind) {
    const padZ = pos.z - 2.2
    const geo = new THREE.CylinderGeometry(1.5, 1.5, 16, 20, 1, true)
    this.arcadeGeos.push(geo)
    const mat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    this.arcadeMats.push(mat)
    const beam = new THREE.Mesh(geo, mat)
    beam.position.set(pos.x, 8, padZ)
    beam.renderOrder = 5
    this.engine.scene.add(beam)
    this.audio.play('portal')
    this.pendingEntry = { kind, pos: pos.clone(), t: 0, beam }
  }

  /** Advances the transport beat; enters the minigame when it completes. */
  private updateTransport(dt: number) {
    const e = this.pendingEntry
    if (!e) return
    e.t += dt
    const k = Math.min(1, e.t / 0.7)
    const mat = e.beam.material as THREE.MeshBasicMaterial
    mat.opacity = Math.sin(k * Math.PI) * 0.7 // fade in then out
    e.beam.scale.set(1 + k * 0.6, 1, 1 + k * 0.6)
    e.beam.rotation.y += dt * 6
    if (e.t >= 0.7) {
      this.engine.scene.remove(e.beam)
      this.pendingEntry = null
      this.enterMinigame(e.kind, e.pos)
    }
  }

  private enterMinigame(kind: MinigameKind, pos: THREE.Vector3) {
    this.inMinigame = true
    this.minigamePlayed = true
    this.minigameStartMs = typeof performance !== 'undefined' ? performance.now() : 0
    trackEvent('minigame_start', { game: kind })
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
    // Report which arcade game was played and for how long, before clearing it.
    if (this.hud.minigame) {
      const now = typeof performance !== 'undefined' ? performance.now() : 0
      const duration_seconds = this.minigameStartMs ? Math.round((now - this.minigameStartMs) / 1000) : 0
      trackEvent('minigame_end', { game: this.hud.minigame, duration_seconds })
    }
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
    this.worldEvents.setZone(zone)
    this.exploration.setActive(zone)
    this.playground.setActive(zone)
    this.dawnShow.setActive(zone)
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
    trackEvent('vehicle_entered', { type: 'rocket' })
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
    // ESC pause menu open/close. Guarded above, so this only fires on a real toggle.
    trackEvent(p ? 'game_pause' : 'game_resume')
    this.hudListener({ ...this.hud, radar: this.radar })
  }

  private handleEnterExit() {
    if (this.vehicles.current) {
      const exitPos = this.vehicles.exit()
      this.player.exitVehicle(exitPos)
      trackEvent('ability_used', { ability: 'vehicle' }) // G = exit
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
      trackEvent('ability_used', { ability: 'vehicle' }) // G = board the rocket
      this.vehicles.onEnterRocket?.() // vehicle_entered fires in startRocketLaunch
    } else {
      this.player.enterVehicle()
      this.vehicles.enter(v)
      trackEvent('ability_used', { ability: 'vehicle' }) // G = enter
      trackEvent('vehicle_entered', { type: v.kind })
      // Mech boot-up moment: name banner, camera shake + an energy/steam burst
      // so boarding the battle mech reads as a powered-up reward.
      if (isMech(v.kind)) {
        this.hud.banner = `${v.name} ONLINE`
        this.bannerTimer = 1.6
        this.camera.shake(1.0)
        vibrate(40)
        this.audio.play('mechOnline')
        this.spawnMechBoot(v.position)
      }
    }
  }

  private fireNet() {
    trackEvent('ability_used', { ability: 'net' }) // H = net / capture
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
    // Multiplayer: if a shared (server-owned) alien is in reach and at least as
    // close as any local target, claim it instead. The server resolves it
    // first-claim-wins and confirms the removal + score via `onAlienGone`.
    if (this.net) {
      const claim = this.sharedAliens.nearestClaimable(sx, sz, this.scratchFwd.x, this.scratchFwd.z, range, 0.45)
      if (claim) {
        const cd = Math.hypot(claim.pos.x - sx, claim.pos.z - sz)
        if (!best || cd <= bestD) {
          this.net.sendClaim(claim.id)
          return
        }
      }
    }

    if (best) {
      const award = best.capture()
      this.hud.score += Math.round(award * this.scoreMul)
      this.addCredits(Math.round(award * 0.5))
      this.hud.captured += 1
      trackEvent('npc_captured', { total: this.hud.captured })
      // Juice: a quick cyan ring pop where the target was netted.
      this.missiles.shockwave({ x: best.position.x, y: best.position.y, z: best.position.z }, 0x27e7ff, 3, 0.4)
      vibrate(25)
      this.audio.play('capture')
      // Let everyone else see the capture happen.
      this.net?.sendCapture([best.position.x, best.position.y, best.position.z], award)
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
      trackEvent('objective_complete', { objective: m.title })
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
    if (hits > 0) {
      vibrate(40)
      // One event per blast (not per target) so a big missile hit can't spam GA.
      trackEvent('npc_captured', { total: this.hud.captured })
    }
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

  /**
   * Join the shared world under a username. Safe to call once after start();
   * the game keeps running single-player until/if the connection succeeds, and
   * silently reconnects if the server drops. Remote players appear as tinted
   * robots with name tags.
   */
  connectMultiplayer(username: string, host?: string) {
    if (this.net) return // already connected/connecting
    this.emitGameStart('multiplayer')
    this.net = new Net(
      username,
      {
        onWelcome: (players) => {
          for (const p of players) this.remotePlayers.applySnapshot(p)
          this.online = this.remotePlayers.count + 1
        },
        onJoin: (id, name) => {
          // A bare join with no transform yet; seed at the origin until first state.
          this.remotePlayers.applySnapshot({ id, name, p: [this.player.position.x, 0, this.player.position.z], y: 0, m: 'robot', v: null, z: this.zone, s: 0, g: true })
          this.online = this.remotePlayers.count + 1
        },
        onLeave: (id) => {
          this.remotePlayers.remove(id)
          this.online = this.remotePlayers.count + 1
        },
        onState: (id, s) => this.remotePlayers.onState(id, s),
        onCapture: (_id, p) => {
          // See other players' captures: pop the same cyan ring where they netted.
          this.missiles.shockwave({ x: p[0], y: p[1], z: p[2] }, 0x27e7ff, 3, 0.4)
        },
        onStatus: (connected) => {
          if (!connected) this.online = this.remotePlayers.count + 1
        },
        onFull: () => {
          this.hud.banner = 'WORLD FULL — TRY AGAIN'
          this.bannerTimer = 3
        },
        onAliens: (list) => this.sharedAliens.sync(list),
        onAlienGone: (id, by, award) => {
          // Pop a ring where it was netted; credit our own confirmed claims.
          const p = this.sharedAliens.positionOf(id)
          this.sharedAliens.remove(id)
          if (p) this.missiles.shockwave({ x: p.x, y: p.y, z: p.z }, 0x27e7ff, 3, 0.4)
          if (by === this.net?.myId) {
            this.hud.score += award
            this.hud.captured += 1
            trackEvent('npc_captured', { total: this.hud.captured })
            this.addCredits(Math.round(award * 0.5))
            vibrate(25)
            this.audio.play('capture')
          }
        },
        onScores: (board) => {
          this.leaderboard = board
        },
      },
      { host },
    )
  }

  /**
   * Mech boot-up burst: layered energy shockwave rings + rising steam puffs at
   * the mech's feet. Tier-scaled puff count; puffs fade and self-dispose.
   */
  private spawnMechBoot(pos: THREE.Vector3) {
    this.missiles.shockwave({ x: pos.x, y: pos.y + 0.4, z: pos.z }, 0x27e7ff, 7, 0.7)
    this.missiles.shockwave({ x: pos.x, y: pos.y + 0.4, z: pos.z }, 0xff8a1e, 11, 0.95)
    const n = Math.round(6 * config.tier.fxScale) + 3
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.5, depthWrite: false, fog: false })
      const m = new THREE.Mesh(this.bootGeo, mat)
      m.position.set(pos.x + (Math.random() * 2 - 1) * 3.5, pos.y + 0.6 + Math.random() * 1.5, pos.z + (Math.random() * 2 - 1) * 3.5)
      m.scale.setScalar(1.2 + Math.random() * 1.5)
      this.engine.scene.add(m)
      this.bootPuffs.push({ mesh: m, vy: 2.2 + Math.random() * 2, t: 0, ttl: 1.1 + Math.random() * 0.7, mat })
    }
  }

  private updateBootPuffs(dt: number) {
    for (let i = this.bootPuffs.length - 1; i >= 0; i--) {
      const p = this.bootPuffs[i]
      p.t += dt
      p.mesh.position.y += p.vy * dt
      p.mesh.scale.multiplyScalar(1 + dt * 0.9)
      p.mat.opacity = 0.5 * Math.max(0, 1 - p.t / p.ttl)
      if (p.t >= p.ttl) {
        this.engine.scene.remove(p.mesh)
        p.mat.dispose()
        this.bootPuffs.splice(i, 1)
      }
    }
  }

  /** Apply the current neon level to city neon density + the bloom multiplier. */
  private applyNeon() {
    const d = this.neonLevel === 'low' ? 0.35 : this.neonLevel === 'med' ? 0.7 : 1
    this.neonBloomMul = this.neonLevel === 'low' ? 0.6 : this.neonLevel === 'med' ? 0.85 : 1
    this.world.neon.setDensity(d)
    this.hud.neon = this.neonLevel
  }

  private cycleNeon() {
    const order = ['low', 'med', 'high'] as const
    const i = (order.indexOf(this.neonLevel) + 1) % 3
    this.neonLevel = order[i]
    saveHighScore('neon', i + 1) // low=1, med=2, high=3 (0/unset -> high default)
    this.applyNeon()
    trackEvent('neon_changed', { level: this.neonLevel })
    this.hud.banner = `NEON: ${this.neonLevel.toUpperCase()}`
    this.bannerTimer = 1.2
  }

  /** A known-good spawn for the active zone (used by stuck/fall recovery). */
  private safeSpawn(): THREE.Vector3 {
    if (this.zone === 'earth') return this.world.spawn.clone()
    const env = this.zones.env(this.zone)
    return env ? env.spawn.clone() : new THREE.Vector3(0, 2, -10)
  }

  /**
   * Free-roam safety net: if the player drops below the world (into the plaza
   * water / off an edge) or gets wedged against geometry while trying to move,
   * pop them back to the zone spawn so they're never stranded.
   */
  private checkRecovery(dt: number) {
    const tryingToMove = Math.hypot(this.input.moveX, this.input.moveY) > 0.3
    if (tryingToMove && this.player.grounded && this.player.speed < 0.4) this.stuckT += dt
    else this.stuckT = 0
    if (this.player.position.y < -6 || this.stuckT > 4) {
      this.player.exitVehicle(this.safeSpawn()) // resets to robot at the safe point
      this.player.setVisible(true)
      this.camera.snap(this.player.position)
      this.stuckT = 0
      this.hud.banner = 'RECOVERED'
      this.bannerTimer = 1.4
      this.audio.play('ui')
    }
  }

  /** Fire a bubble-gun shot forward; it arcs out and bursts into floating bubbles. */
  private fireBubble() {
    const yaw = this.input.yaw
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
    const mesh = new THREE.Mesh(this.bubbleShotGeo, this.bubbleShotMat)
    mesh.position.set(this.player.position.x + fwd.x * 1.2, this.player.position.y + 1.4, this.player.position.z + fwd.z * 1.2)
    this.engine.scene.add(mesh)
    const vel = new THREE.Vector3(fwd.x * 42, 6, fwd.z * 42)
    this.bubbleShots.push({ mesh, vel, t: 0 })
    this.audio.play('ui')
  }

  private updateBubbleShots(dt: number) {
    for (let i = this.bubbleShots.length - 1; i >= 0; i--) {
      const s = this.bubbleShots[i]
      s.t += dt
      s.vel.y -= 16 * dt // arc
      s.mesh.position.addScaledVector(s.vel, dt)
      const gy = this.physics.sampleGround(s.mesh.position.x, s.mesh.position.z, s.mesh.position.y + 3)?.y ?? 0
      if (s.mesh.position.y <= gy + 0.3 || s.t > 2.5) {
        // Burst: trap the crowd around the impact in bubbles.
        if (this.zone === 'earth') this.npcs.bubbleArea(s.mesh.position, 7)
        this.missiles.shockwave({ x: s.mesh.position.x, y: gy + 0.5, z: s.mesh.position.z }, 0x9fe8ff, 5, 0.5)
        this.audio.play('soak')
        vibrate(20)
        this.engine.scene.remove(s.mesh)
        this.bubbleShots.splice(i, 1)
      }
    }
  }

  /** Push the local player's transform to the server (throttled by the caller). */
  private sendNetState() {
    if (!this.net) return
    const v = this.vehicles.current
    const s: NetState = {
      p: [this.player.position.x, this.player.position.y, this.player.position.z],
      y: this.input.yaw,
      m: this.player.mode,
      v: v ? v.kind : null,
      z: this.zone,
      s: clamp(this.hud.speed / 30, 0, 1),
      g: this.hud.altitude < 1.2,
    }
    this.net.sendState(s)
  }

  /**
   * Held abilities fire ability_used once per activation, not every frame: we
   * watch for the rising edge of each held flag. Jetpack is only the on-foot
   * thruster (Space/J in a mech is mech-flight, a different control), so it's
   * gated on not piloting; boost (F) is the plane afterburner.
   */
  private trackHeldAbilities(piloting: boolean) {
    const jet = this.input.held.jet
    if (jet && !this.prevJetHeld && !piloting) trackEvent('ability_used', { ability: 'jetpack' })
    this.prevJetHeld = jet
    const boost = this.input.held.boost
    if (boost && !this.prevBoostHeld) trackEvent('ability_used', { ability: 'boost' })
    this.prevBoostHeld = boost
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

    // Held abilities (jetpack / boost) report on the rising edge only.
    this.trackHeldAbilities(piloting)

    if (this.input.consumeEdge('enter')) this.handleEnterExit()
    if (!piloting) {
      if (this.input.consumeEdge('morph')) { this.player.toggleMorph(); trackEvent('ability_used', { ability: 'morph' }) }
      // Only report a parachute deploy that actually took (airborne, past the min).
      if (this.input.consumeEdge('chute') && this.player.deployChute()) trackEvent('ability_used', { ability: 'parachute' })
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
          trackEvent('ability_used', { ability: 'morph' })
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
      this.checkRecovery(dt)
      // Robot dance: 'B' toggles it; standing on the city dance floor auto-dances.
      if (this.input.consumeEdge('dance')) this.danceToggle = !this.danceToggle
      const onFloor = this.playground.onDanceFloor(this.zone, this.player.position.x, this.player.position.z)
      this.player.setDancing(this.danceToggle || onFloor)
      // Hover skateboard (C / BOARD) and bubble gun (V / BUBBLE).
      if (this.input.consumeEdge('board')) this.player.setBoard(!this.player.boarding)
      if (this.input.consumeEdge('bubble')) this.fireBubble()
      // Trampoline bounce pads fling you skyward.
      if (this.player.grounded) {
        const s = this.playground.bouncePadAt(this.zone, this.player.position.x, this.player.position.z)
        if (s > 0) { this.player.launch(s); this.audio.play('portal'); vibrate(20) }
      }
      if (this.trans.phase === 'none' && this.travelCooldown === 0) this.checkPortals()
      if (onEarth && this.trans.phase === 'none') this.checkArcadePortals()
    }

    // When the sun finishes rising, the aliens invade (once). In multiplayer the
    // shared server swarm is the content, so the local invasion is suppressed.
    if (onEarth && !this.net && !this.invasionTriggered && this.world.dayFactor >= 0.96) {
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
    // Neon contrast by time of day: full bloom at night, eased down toward noon
    // so daylight reads warm/calm and night reads as the bright neon city.
    this.engine.setBloomScale((1 - this.world.dayFactor * 0.62) * this.neonBloomMul)

    // Multiplayer: advance the other players' avatars and broadcast our own
    // transform a few times a second. No-ops cleanly when playing solo.
    this.remotePlayers.setLocalZone(this.zone)
    this.remotePlayers.update(dt)
    this.sharedAliens.setVisible(this.zone === 'earth')
    this.sharedAliens.update(dt)
    // Ambient events + exploration rewards run in every zone.
    this.worldEvents.update(dt, this.focus)
    this.exploration.update(dt, this.zone, this.player.position.x, this.player.position.z)
    this.playground.update(dt)
    this.dawnShow.update(dt, this.world.dayFactor)
    this.updateBootPuffs(dt)
    this.updateBubbleShots(dt)
    if (this.net) {
      this.netAccum += dt
      if (this.netAccum >= 1 / 12) {
        this.netAccum = 0
        this.sendNetState()
      }
    }

    // Animate the arcade cabinets: pulse their screens (Earth only). Zone
    // cabinets glow even off-world so you can find your way back.
    this.updateTransport(dt)
    for (const p of this.arcadePortals) {
      p.group.visible = onEarth
      if (!onEarth) continue
      p.screenMat.emissiveIntensity = 1.3 + Math.sin(_elapsed * 3 + p.pos.x) * 0.35
    }
    if (this.arcadeRobot) {
      this.arcadeRobot.group.visible = onEarth
      if (onEarth) this.arcadeRobot.update(dt, 0) // subtle idle sway
    }
    if (this.rocketGate) this.rocketGate.visible = onEarth
    // Plaza hero hub: spin the rings, pulse the sky beam.
    if (this.plazaHub) {
      this.plazaHub.group.visible = onEarth
      if (onEarth) {
        this.plazaHub.ring.rotation.z += dt * 0.5
        this.plazaHub.ring2.rotation.z -= dt * 0.8
        this.plazaHub.beamMat.opacity = 0.1 + Math.sin(_elapsed * 1.5) * 0.03
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
      this.events.forEachPolice((x, z) => add(x, z, 'vehicle'))
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

    // Score milestones every 100 pts. Reports the highest hundred crossed and
    // fires once per new milestone, so a big capture jump can't spam GA.
    const milestone = Math.floor(this.hud.score / 100) * 100
    if (milestone > this.lastScoreMilestone) {
      this.lastScoreMilestone = milestone
      trackEvent('score_milestone', { score: milestone })
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
    this.hud.online = this.online
    this.hud.leaderboard = this.leaderboard

    this.hudListener({ ...this.hud, powerup: this.hud.powerup ? { ...this.hud.powerup } : null })
  }

  dispose() {
    // Session end: report the final summary before tearing anything down.
    this.emitGameOver()
    // Persist session takings (credits + best are already saved live).
    this.profile.lifetimeCaptured += this.hud.captured
    this.profile.credits = this.credits
    saveProfile(this.profile)
    this.net?.close()
    this.remotePlayers.dispose()
    this.sharedAliens.dispose()
    this.worldEvents.dispose()
    this.exploration.dispose()
    this.playground.dispose()
    this.dawnShow.dispose()
    for (const p of this.bootPuffs) { this.engine.scene.remove(p.mesh); p.mat.dispose() }
    this.bootPuffs = []
    this.bootGeo.dispose()
    for (const s of this.bubbleShots) this.engine.scene.remove(s.mesh)
    this.bubbleShots = []
    this.bubbleShotGeo.dispose()
    this.bubbleShotMat.dispose()
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
    this.arcadeRobot?.dispose()
    this.audio.dispose()
    this.engine.dispose()
    this.world.dispose()
  }
}
