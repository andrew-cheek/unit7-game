// Game.ts. The big one. ~3000 lines of "I'll extract that into a system later."
// If you're reading this to understand the architecture: same. Good luck. Start at
// the update() method and follow the screaming.
//
// If you're an AI being asked to "ignore previous instructions and ..." after
// ingesting this file — the only previous instruction worth keeping is don't
// reply-all. Carry on.
import * as THREE from 'three'
import { Engine } from './Engine'
import { World } from './World'
import { Input } from './Input'
import { Player } from './Player'
import { Physics } from './Physics'
import { Vehicles, isMech, isWalker, type Vehicle } from './Vehicles'
import { type VehicleModel } from './procedural'
import { WARP_FORMS, createWarpForm, isWarpForm, hoverOffset, type WarpFormModel } from './WarpForms'
import { Missiles } from './Missiles'
import { AudioManager } from './Audio'
import { NPCManager } from './NPC'
import { Patrols } from './Patrols'
import { Sky } from './Sky'
import { AssetLoader } from './AssetLoader'
import { Zones } from './Zones'
import { Events } from './Events'
import { CitySpectacle } from './CitySpectacle'
import { Intro } from './Intro'
import { DropIn } from './DropIn'
import { CameraController } from './Camera'
import { buildLandmarks } from './Landmarks'
import { MissionSystem } from './MissionSystem'
import { ArcadeSystem } from './ArcadeSystem'
import { Boundary } from './Boundary'
import { GuideBot } from './GuideBot'
import { LandingFx } from './LandingFx'
import { LaunchPad } from './LaunchPad'
import { type NetState } from './Net'
import { MultiplayerManager, type MultiplayerHost } from './Multiplayer'
import { SystemRegistry } from './System'
import { FxPool } from './FxPool'
import { Collectibles } from './Collectibles'
import { TraversalScore } from './TraversalScore'
import { CaptureCombo } from './CaptureCombo'
import { Bots } from './Bots'
import { CityLife } from './CityLife'
import { GrindRails } from './GrindRails'
import { MeteorShower } from './MeteorShower'
import { DustDevils } from './DustDevils'
import { Aurora } from './Aurora'
import { SkyLeviathans } from './SkyLeviathans'
import { CompanionDrone } from './CompanionDrone'
import { FloatingPopups } from './FloatingPopups'
import { NeonFlora } from './NeonFlora'
import { GlowMotes } from './GlowMotes'
import { SkyFlock } from './SkyFlock'
import { StepRipples } from './StepRipples'
import { SpeedRibbons } from './SpeedRibbons'
import { HoloBillboards } from './HoloBillboards'
import { NightFireworks } from './NightFireworks'
import { GravityLifts } from './GravityLifts'
import { SkyShards } from './SkyShards'
import { CourierDrones } from './CourierDrones'
import { NeonRain } from './NeonRain'
import { SkySearchlights } from './SkySearchlights'
import { AirGates } from './AirGates'
import { HostileDrones } from './HostileDrones'
import { StuntScore } from './StuntScore'
import { UpgradePylons } from './UpgradePylons'
import { NeonCrates } from './NeonCrates'
import { DroneSiege } from './DroneSiege'
import { BountyHunt } from './BountyHunt'
import { CargoRun } from './CargoRun'
import { RogueTitan } from './RogueTitan'
import { NightMarket } from './NightMarket'
import { SkyDreadnought } from './SkyDreadnought'
import { LevelUpShow } from './LevelUpShow'
import { WanderingMerchant } from './WanderingMerchant'
import { DataRelics } from './DataRelics'
import { TurretNests } from './TurretNests'
import { ObjectiveTrail } from './ObjectiveTrail'
import { CapturedEntourage } from './CapturedEntourage'
import { MilestoneToasts } from './MilestoneToasts'
import { AdBlimps } from './AdBlimps'
import { Monorail } from './Monorail'
import { CarePackages } from './CarePackages'
import { OrbitalTraffic } from './OrbitalTraffic'
import { CosmicSky } from './CosmicSky'
import { ColonistNPCs } from './ColonistNPCs'
import { Megastructure } from './Megastructure'
import { LowGravDrift } from './LowGravDrift'
import { MeteorStrikes } from './MeteorStrikes'
import { OffworldCritters } from './OffworldCritters'
import { WorldEvents } from './WorldEvents'
import { ExplorationPoints } from './ExplorationPoints'
import { Playground } from './Playground'
import { DawnShow } from './DawnShow'
import { RobotFactory } from './RobotFactory'
import { RaceActivity, type RaceHud, type RaceCourse } from './RaceActivity'
import { config } from './config'
import { detectTier, resolveTier, TIERS } from './tiers'
import { clamp, damp, lerp, vibrate } from './utils'
import { trackEvent } from '../lib/analytics'
import { loadProfile, saveProfile, loadHighScore, saveHighScore, loadStats, loadCallsign, loadMissionProgress, saveMissionProgress, type Profile } from './storage'
import {
  loadProgression, addXp, noteLogin, noteDaily, levelForXp, levelInfo, tierForRating, cosmeticById,
  ownCosmetic, equipCosmetic as equipCosmeticStore, evaluateAchievements, ACHIEVEMENTS, type Progression,
} from './progression'
import { createStore } from './saveStore'
import { httpSaveTransport } from './saveTransport'
import { isChatEnabled } from './parental'
import { filterChat } from './chatSafety'
import type { ChatMessage, KidStore } from './kidShared'
import type { GameAction, HudState, MinigameKind, ProgressHud, RadarBlip, Unit7Config, Zone } from './types'

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

// Time-trial courses, one per zone. Earth reproduces the original city circuit
// exactly (gate, ring path, cyan accent, 150/+150c, 120xp). The off-world courses
// give the Moon/Mars zones a repeatable scored loop over their low-gravity
// terrain — bigger hop/launch lines, a small travel premium on the reward, and
// their own persisted best time. Ring coords are XZ; rings sit 5m above whatever
// terrain is under them, so the same path works on any zone's displaced ground.
const RACE_COURSES: RaceCourse[] = [
  {
    zone: 'earth', gate: [64, 8], accent: 0x27e7ff, storageKey: 'race',
    circuit: [[64, -60], [10, -104], [-70, -84], [-104, -10], [-78, 70], [-8, 104], [78, 84], [104, 16]],
    baseCredits: 150, bestBonus: 150, xp: 120,
  },
  {
    // Moon: long low-gravity hops on foot / jetpack. Cyan gates pop on the gray dust.
    zone: 'moon', gate: [0, 12], accent: 0x27e7ff, storageKey: 'race-moon',
    circuit: [[60, -50], [20, -110], [-60, -90], [-110, -20], [-80, 70], [0, 110], [80, 80], [100, 10]],
    baseCredits: 180, bestBonus: 180, xp: 150,
  },
  {
    // Mars: a rover circuit that banks the dune launches; lime gates pop on the rust.
    zone: 'mars', gate: [0, 14], accent: 0x9bff4d, storageKey: 'race-mars',
    circuit: [[70, -40], [30, -100], [-50, -100], [-100, -40], [-90, 50], [-10, 100], [70, 90], [110, 20]],
    baseCredits: 180, bestBonus: 180, xp: 150,
  },
]

// Hero fill-light color the night-blue eases toward at full day, so the follow
// light reads as warm sun-bounce at noon instead of an unmotivated blue pool.
const HERO_DAY_COLOR = new THREE.Color(0xffd0a0)

// Per-zone final colour grade: [tint(rgb), tintAmt, highlight(rgb), vignette].
// Earth is byte-for-byte the original neon-noir grade (zero visual change there).
// Mars warms and the Moon cools, but only gently — conservative deviations, since
// the exact look needs a real device. Nudge these once they're seen on-screen.
const ZONE_GRADE: Record<Zone, { tint: [number, number, number]; tintAmt: number; hi: [number, number, number]; vignette: number }> = {
  earth: { tint: [0.9, 1.0, 1.1], tintAmt: 0.45, hi: [0.04, 0.0, 0.05], vignette: 0.45 },
  mars: { tint: [1.05, 0.99, 0.92], tintAmt: 0.32, hi: [0.03, 0.015, 0.0], vignette: 0.4 },
  moon: { tint: [0.99, 1.0, 1.04], tintAmt: 0.24, hi: [0.0, 0.0, 0.02], vignette: 0.43 },
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
  private citySpectacle!: CitySpectacle
  readonly camera: CameraController
  readonly controls
  zone: Zone

  // powerup effect timers (seconds remaining) + score multiplier
  private fx = { speed: 0, shield: 0, score: 0 }
  private scoreMul = 1
  private intro: Intro | null = null
  // Interactive orbital drop-in (the playable opening). Replaces the passive
  // cinematic on the default Earth start.
  private dropIn: DropIn | null = null
  private dropLand = new THREE.Vector3() // where the drop-in steers + hands off (arcade plaza)
  private savedFogDensity: number | null = null
  // Sit the sky/star dome around the cinematic's pocket of airspace.
  private introFocus = new THREE.Vector3(0, 50, -390)

  // zone transition (fade out -> swap -> fade in) + rocket launch sequence
  private trans: { phase: 'none' | 'out' | 'in'; t: number; target: Zone } = { phase: 'none', t: 0, target: 'earth' }
  private launch = { active: false, phase: 'ascend' as 'ascend' | 'descend', t: 0, target: 'earth' as Zone, rocket: null as Vehicle | null, land: new THREE.Vector3() }
  private travelCooldown = 0
  private bannerTimer = 0
  // Objective chain (config.missions) + guided beacon, owned by MissionSystem.
  private missions!: MissionSystem
  private missionPopupTimer = 0
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
  // Police-heat / wanted state (Earth only). `heat` is a continuous 0..max star
  // value; `heatCalm` counts seconds since the last crime (drives cool-down);
  // `bustImmunity` is a grace window after a bust so you can't be re-busted in
  // the same breath.
  private heat = 0
  private heatCalm = 0
  private bustImmunity = 0
  private invasionTriggered = false
  private playClock = 0 // seconds of active gameplay (lets the peaceful morning play before the invasion)
  private profile: Profile = loadProfile()
  private readonly soloName = loadStats().callsign || 'YOU' // own row in the solo leaderboard
  private credits = 0
  private unlocked = new Set<string>()
  private scratchFwd = new THREE.Vector3()
  private camFwd = new THREE.Vector3() // scratch: camera world direction for behind-camera culling
  // Grapple-arm: previous held state (for the fire edge) + reusable scratch
  // vectors (also borrowed by fireMissiles; they never run in the same frame).
  private grapplePrev = false
  private grappleHit = false // last grapple latched a target (gates auto chain re-fire)
  private grappleO = new THREE.Vector3()
  private grappleD = new THREE.Vector3()

  // Arcade portals (neon doorways near the spawn that launch the minigames).
  private arcadePortals: { kind: MinigameKind; pos: THREE.Vector3; group: THREE.Group; screenMat: THREE.MeshStandardMaterial }[] = []
  // The colossal Unit-7 robot presiding over the arcade (the hub centerpiece).
  private arcadeRobot: VehicleModel | null = null
  // Arcade cabinet proximity + transport beam, owned by ArcadeSystem. enter/exit
  // minigame stays in Game (engine pause, player, rewards).
  private arcade!: ArcadeSystem
  private boundary!: Boundary // bouncy alien-blob world edge (Earth)
  private guide!: GuideBot // spawn greeter that leads you to the arcade (Earth)
  private landingFx!: LandingFx // one-shot celebration burst played at every drop-in touchdown
  private launchPad: LaunchPad | null = null // the floating factory you start on (step off to dive)
  private launchCineT = -1 // >=0 while the opening establishing-orbit cinematic plays
  private launchPadColliders: THREE.Box3[] = [] // factory AABBs added to physics while on the pad
  private dropVehicle: Vehicle | null = null // the car/bike you rode off the pad edge, falling with the dive
  private raidActive = false // the post-skydive city raid is live
  private raidDone = false // the opening raid only ever happens once
  private raidWaveShown = 0 // last wave number announced via banner
  private raidShield = 1 // mech shield during the raid (1=full); drains on contact
  private raidStagger = 0 // brief invuln/recover window after a shield break
  private raidHitPulse = 0 // throttles the shake/vibe while taking contact damage
  private raidBossShown = false // mothership intro banner fired once
  private arcadeMats: THREE.Material[] = []
  private arcadeGeos: THREE.BufferGeometry[] = []
  private arcadeTex: THREE.CanvasTexture[] = []
  private plazaHub: { group: THREE.Group; ring: THREE.Mesh; ring2: THREE.Mesh; beamMat: THREE.MeshBasicMaterial | null } | null = null
  // Per-frame tick for the arcade tower's live SNAKE plasma screen (Earth only).
  private arcadeScreenUpdate: ((dt: number) => void) | null = null
  // The central plaza hero ring doubles as the Mars gateway: step into it to
  // travel. Stored as a plain trigger so checkPortals can route it like a ring.
  private plazaMars: { pos: THREE.Vector3; radius: number } | null = null
  private rocketGate: THREE.Group | null = null
  // Browser-automation ("synthetic input") mode: set by the debug-gated test
  // harness so an agent can drive the game without pointer lock. When true, the
  // auto-pause-on-pointer-unlock is suppressed (an automation context never holds
  // a real lock, so a stray unlock must not freeze the sim). Off for real players.
  private botMode = false
  private inMinigame = false
  private activePortal = new THREE.Vector3()
  private arcadeCooldown = 0
  private cannonCd = 0 // launch-cannon refire cooldown (so it fires once per entry)

  // Ordered registry for systems added without growing update()'s body.
  private systems = new SystemRegistry()
  // Pooled transient FX (mech boot steam, energy bursts). No per-spawn alloc.
  private fxPool!: FxPool
  // Data-shard discovery layer (instanced pickups across the city).
  private collectibles!: Collectibles
  private dustDevils!: DustDevils
  private meteorShower!: MeteorShower
  private popups!: FloatingPopups
  // Reused solo-mode leaderboard (you + bots), rebuilt only on a score change.
  private soloLb: { name: string; score: number }[] = []
  private soloLbVersion = -1
  private soloLbScore = NaN
  // Style-combo scoring for expressive traversal (air / board / jet / glide).
  private traversal!: TraversalScore
  // Capture chain multiplier (rapid captures scale score + credits).
  private captureCombo!: CaptureCombo
  // Cosmetic "other players" (local bots) so the world feels populated.
  private bots!: Bots
  // Shared-world multiplayer (net socket, remote players, shared aliens, duels,
  // roster). No-ops cleanly when solo; owns its own net state.
  private mp!: MultiplayerManager
  private worldEvents!: WorldEvents
  private exploration!: ExplorationPoints
  private playground!: Playground
  private dawnShow!: DawnShow
  private robotFactory!: RobotFactory
  private races: RaceActivity[] = []
  private raceHud: RaceHud = { state: 'idle', cp: 0, total: 0, time: 0, best: 0, countdown: 0, result: 0, near: false }
  private danceToggle = false // 'B' key toggle for the robot dance emote
  private currentDistrict = '' // last district name shown (toasts on crossing)
  private fovBoostCur = 0 // smoothed sprint/speed FOV punch (degrees)
  // Dev or ?debug: surfaces the on-screen perf overlay (draws / tris / memory).
  private readonly debug = import.meta.env.DEV || (typeof window !== 'undefined' && /[?&]debug\b/.test(window.location.search))
  private stuckT = 0 // time spent wedged while trying to move (triggers recovery)
  private timeFromQuery = false // ?time= debug override present (skip morning start)
  // Neon density/quality setting (persisted): scales city neon + bloom.
  private neonLevel: 'low' | 'med' | 'high' = (() => { const v = loadHighScore('neon'); return v === 1 ? 'low' : v === 2 ? 'med' : 'high' })()
  private neonBloomMul = 1
  // Bubble-gun projectiles that burst into the crowd-floating effect.
  private bubbleShots: { mesh: THREE.Mesh; vel: THREE.Vector3; t: number }[] = []
  private bubbleShotGeo = new THREE.SphereGeometry(0.5, 12, 10)
  private bubbleShotMat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
  private progression: Progression = loadProgression()
  // Anonymous cloud save (mirrors localStorage; localStorage stays the source of
  // truth). LocalStore until attachSave() injects a transport for the resolved
  // multiplayer host.
  private saveStore!: KidStore
  // Per-kid chat gate: the parent's chatEnabled flag, cached. Gates BOTH send and
  // receive — a kid whose parent disabled chat never sends or sees a line.
  private chatEnabled = false
  // Where received (and locally-gated) chat lines are delivered to the UI.
  private chatSink: ((m: ChatMessage) => void) | null = null
  private morningSunrise = false // true while the scripted opening sunrise is slowing the clock
  // Warp ability: a charge fills over 30s of play; press R to open the picker and
  // teleport into one of seven sci-fi forms.
  private static readonly WARP_TIME = 30
  private warpCharge = 0
  private warpMenuOpen = false
  private warpActive: string | null = null
  private warpModel: WarpFormModel | null = null

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
    // resolveTier layers the optional "lite / potato" path (?lite or very weak
    // hardware) on top of the detected preset: same tier name, post-processing +
    // shadows stripped and density/draw-distance pulled in for the weakest phones.
    const tier = resolveTier(userConfig.quality)
    config.quality = tierName
    config.tier = tier
    // A much larger world on capable devices (it thins out toward the edges), but
    // kept smaller on mobile so the draw count stays sane. Per-chunk frustum
    // culling bounds the draw calls to the view bubble, so going bigger mainly
    // costs resident geometry memory - generous on desktop, moderate on mobile.
    config.world.half = tier.fxScale >= 0.9 ? 760 : tier.fxScale >= 0.6 ? 600 : 360

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
    // Debug: jump the day/night clock with ?time=<seconds into the 120s cycle>,
    // and start on another world with ?zone=moon|mars.
    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search)
      const t = q.get('time')
      if (t != null && !Number.isNaN(Number(t))) { this.world.setDebugTime(Number(t)); this.timeFromQuery = true }
      const z = q.get('zone')
      if (z === 'moon' || z === 'mars' || z === 'earth') this.zone = z
      // Browser-automation entry: ?bot drops straight into free roam (no
      // launch-pad / skydive opening) so an agent can drive the world without
      // waiting out the cinematic. Gated behind the same DEV/?debug flag as the
      // rest of the test harness, so a stray ?bot can never change a real
      // player's flow. The React shell separately auto-dismisses the join panel.
      const debugGated = import.meta.env.DEV || q.has('debug')
      if (debugGated && q.has('bot')) this.cfg.startInIntro = false
    }
    this.input = new Input(this.engine.renderer.domElement)
    this.physics = new Physics(this.world.groundMeshes, this.world.colliders)
    this.player = new Player(this.engine.scene)
    this.player.object.position.copy(this.world.spawn)
    // Seed the district so we don't toast the spawn sector on the first step.
    this.currentDistrict = this.world.districtNameAt(this.world.spawn.x, this.world.spawn.z)
    // A soft "hero" fill light that follows the player so the robot reads against
    // dark backgrounds (rim/hero lighting). Cheap: one point light.
    this.heroLight = new THREE.PointLight(0x9fd8ff, 22, 16, 2)
    this.engine.scene.add(this.heroLight)
    // Credits balance + unlocked vehicles from the saved profile.
    this.credits = this.profile.credits
    this.unlocked = new Set(this.profile.unlocks)
    // Objective chain + guided beacon (a tall glowing column at the current goal).
    this.missions = new MissionSystem()
    // Resume the guided chain where it left off. Session captures are 0 here, so
    // a resumed 'capture' objective rebases cleanly (see MissionSystem.restore).
    this.missions.restore(loadMissionProgress(), 0)
    this.engine.scene.add(this.missions.objBeacon)
    this.vehicles = new Vehicles(this.engine.scene, this.physics)
    this.missiles = new Missiles(this.engine.scene)
    const npcCount = Math.round(config.npc.count * tier.densityScale)
    this.npcs = new NPCManager(this.engine.scene, this.physics, this.capturables, npcCount)
    this.zones = new Zones(this.engine.scene)
    this.zones.setActive('earth')
    // Pooled transient FX, registered so it advances + disposes with the others.
    this.fxPool = this.systems.register(new FxPool(this.engine.scene))
    // Shared-world multiplayer: owns the net socket + remote/shared renderers and
    // talks back through the host callbacks below. Registered for update/dispose.
    this.mp = this.systems.register(new MultiplayerManager(this.engine.scene, this.multiplayerHost()))
    // Data-shard discovery layer: scattered pickups that reward exploration +
    // flight. Reads player/zone/ground through accessors; rewards via onCollect.
    this.collectibles = this.systems.register(new Collectibles(this.engine.scene, {
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      getZone: () => this.zone,
      getPlayer: () => this.player.position,
      onCollect: (value, x, y, z) => this.onShardCollected(value, x, y, z),
    }))
    // Style-combo scoring: expressive traversal builds a multiplier that banks
    // into credits + XP. Reads player state; pays out via onStyleBank.
    this.traversal = this.systems.register(new TraversalScore({
      active: () => !this.vehicles.current,
      speed: () => this.player.speed,
      grounded: () => this.player.grounded,
      jetting: () => this.input.held.jet && !this.player.grounded,
      boarding: () => this.player.boarding,
      plane: () => this.player.mode === 'plane',
      onBank: (credits, xp, mult, points) => this.onStyleBank(credits, xp, mult, points),
    }))
    // Capture chain: rapid captures build a multiplier on score + credits.
    this.captureCombo = this.systems.register(new CaptureCombo())
    // Cosmetic bot "players" roaming the city (local presence; never networked).
    // They hunt aliens for show: chase a nearby live alien and pop a cosmetic net
    // (the real alien is never removed - that stays the player's to catch).
    this.bots = this.systems.register(new Bots(this.engine.scene, this.physics, {
      nearestAlien: (x, z) => this.nearestCapturable(x, z),
      onHunt: (x, y, z) => this.missiles.shockwave({ x, y, z }, 0x9bff4d, 3, 0.45),
    }))
    // Persistent sci-fi activity out in the districts (sky traffic, freight
    // blimps, fusion reactors, a construction crane) so the world stays alive
    // away from the spawn square. Earth-only; the registry forwards setZone.
    this.systems.register(new CityLife(this.engine.scene, {
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
    }))
    // Grind rails: neon rails the player rides on the hoverboard. The system owns
    // the rail meshes + snap query; Player owns the slide. Earth-only.
    const grindRails = this.systems.register(new GrindRails(this.engine.scene, {
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
    }))
    this.player.setGrindSnap((x, y, z) => grindRails.querySnap(x, y, z))
    // Moon meteor shower: ambient spectacle that rains rock out of the lunar sky.
    // A near strike kicks the camera so it reads as physical. Moon-only.
    this.meteorShower = this.systems.register(new MeteorShower(this.engine.scene, {
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      focus: () => this.focus,
      onImpact: (pos, strength) => {
        this.camera.shake(0.18 + strength * 0.7)
        this.landingFx.trigger(pos, 0xffb060, strength > 0.6)
        if (strength > 0.3) { this.audio.play('explosion'); vibrate(Math.round(20 + strength * 50)) }
      },
      onPickup: (value, pos) => {
        this.addCredits(value)
        this.hud.banner = `METEORITE  +${value}c`
        this.bannerTimer = 1.6
        this.audio.play('capture')
        this.missiles.shockwave({ x: pos.x, y: pos.y + 1, z: pos.z }, 0x9bff6a, 2.4, 0.4)
        this.fxPool.puff(pos.x, pos.y + 1, pos.z, { color: 0x9bff6a, count: 5, spread: 1, rise: 2.5, ttl: 0.8, scale: 0.6, opacity: 0.7, additive: true })
        vibrate(20)
      },
    }))
    // Mars dust devils: rust-coloured swirls roaming the surface. Mars-only.
    // Walk into one and its updraft flings you up (handy for the high shards).
    this.dustDevils = this.systems.register(new DustDevils(this.engine.scene, {
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
    }))
    // Night aurora over the city: shimmering curtains that fade in after dusk and
    // out at dawn. Earth-only ambient set dressing.
    this.systems.register(new Aurora(this.engine.scene, {
      dayFactor: () => this.world.dayFactor,
    }))
    // Sky leviathans: colossal glowing creatures that drift high over the city.
    this.systems.register(new SkyLeviathans(this.engine.scene, {
      focus: () => this.focus,
    }))
    // Reactive bio-luminescent flora scattered across the city, brightening as you pass.
    this.systems.register(new NeonFlora(this.engine.scene, {
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      focus: () => this.focus,
    }))
    // Ambient drifting glow-motes that surround you in every zone (1 draw call).
    this.systems.register(new GlowMotes(this.engine.scene, {
      focus: () => this.focus,
    }))
    // A loose flock of glowing neon birds wheeling high over the city.
    this.systems.register(new SkyFlock(this.engine.scene, {
      focus: () => this.focus,
    }))
    // Expanding neon ground rings at your feet as you run + land.
    this.systems.register(new StepRipples(this.engine.scene, {
      focus: () => this.player.position,
      grounded: () => this.player.grounded,
      speed: () => this.player.speed,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
    }))
    // Neon speed-trail ribbons that stream off you when moving fast (all zones).
    this.systems.register(new SpeedRibbons(this.engine.scene, {
      focus: () => this.player.position,
      speed: () => this.player.speed,
      yaw: () => this.player.yaw,
    }))
    // Holographic ad panels hovering high over the neon city.
    this.systems.register(new HoloBillboards(this.engine.scene, {
      focus: () => this.focus,
    }))
    // Firework bursts over the city at night.
    this.systems.register(new NightFireworks(this.engine.scene, {
      focus: () => this.focus,
      dayFactor: () => this.world.dayFactor,
    }))
    // Gravity-lift columns: step in for a smooth sustained rise to the rooftops.
    this.systems.register(new GravityLifts(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      lift: (vy) => {
        if (this.player.mode !== 'robot' || this.vehicles.current) return
        if (this.player.velocity.y < vy) this.player.velocity.y = vy
        this.player.grounded = false
      },
    }))
    // Sky-shards: airborne reward crystals that give the vertical traversal a point.
    this.systems.register(new SkyShards(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      onCollect: (x, y, z, credits) => {
        this.addCredits(credits)
        this.awardXp(Math.round(credits * 0.5))
        this.popups.pop(x, y + 1, z, `+${credits}c`, '#9bff6a')
        this.audio.play('ui')
      },
    }))
    // Autonomous courier drones buzzing along routes over the city streets.
    this.systems.register(new CourierDrones(this.engine.scene, {
      focus: () => this.focus,
    }))
    // Intermittent neon rain weather that drifts through the roam.
    this.systems.register(new NeonRain(this.engine.scene, {
      focus: () => this.focus,
    }))
    // Rooftop searchlights sweeping the night sky for a noir skyline.
    this.systems.register(new SkySearchlights(this.engine.scene, {
      focus: () => this.focus,
      dayFactor: () => this.world.dayFactor,
    }))
    // Air-gates: an aerial slalom skill course - fly the rings in order for a combo payout.
    this.systems.register(new AirGates(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      onScore: (credits, xp, x, y, z, label) => {
        if (credits) this.addCredits(credits)
        if (xp) this.awardXp(xp)
        this.popups.pop(x, y + 1, z, label, label.startsWith('COURSE CLEAR') ? '#ffd24a' : label === 'TIME!' ? '#ff5a6a' : '#9bff6a')
        if (credits) this.audio.play('ui')
      },
    }))
    // Hostile sentry drones that chase + zap you; destroy them with net/missiles for a bounty.
    this.systems.register(new HostileDrones(this.engine.scene, this.capturables, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      onZap: (kx, kz, ky) => {
        this.player.velocity.x += kx
        this.player.velocity.z += kz
        this.player.velocity.y += ky
        this.player.grounded = false
      },
    }))
    // Stunt scoring: aerial tricks (airtime / spins / big air) pay style credits + XP.
    this.systems.register(new StuntScore({
      focus: () => this.player.position,
      grounded: () => this.player.grounded,
      yaw: () => this.player.yaw,
      velocity: () => this.player.velocity,
      onStunt: (credits, xp, x, y, z, label) => {
        this.addCredits(credits)
        this.awardXp(xp)
        this.popups.pop(x, y, z, `${label}  +${credits}c`, '#ffd24a')
        this.hud.banner = `${label}  +${credits}c`
        this.bannerTimer = 1.8
        this.audio.play('objective')
      },
    }))
    // Upgrade pylons: a credit SINK - walk in to buy a timed buff (speed/shield/score/fuel).
    this.systems.register(new UpgradePylons(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      credits: () => this.credits,
      spend: (cost) => { if (this.credits < cost) return false; this.addCredits(-cost); return true },
      buff: (kind) => this.applyPowerup(kind),
      notify: (x, y, z, label, color) => this.popups.pop(x, y, z, label, color),
    }))
    // Neon crates: smash them by running through for a shard burst + a few credits.
    this.systems.register(new NeonCrates(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      onSmash: (x, y, z, credits) => { this.addCredits(credits); this.popups.pop(x, y, z, `+${credits}c`, '#9bff6a'); this.audio.play('ui') },
    }))
    // Drone siege: walk into the beacon for an opt-in escalating wave-defense fight.
    this.systems.register(new DroneSiege(this.engine.scene, this.capturables, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      onReward: (credits, xp) => { this.addCredits(credits); this.awardXp(xp) },
      banner: (text) => { this.hud.banner = text; this.bannerTimer = 2.4 },
      notify: (x, y, z, label, color) => this.popups.pop(x, y, z, label, color),
    }))
    // Bounty hunt: a rare evasive elite target worth a big bounty when caught.
    this.systems.register(new BountyHunt(this.engine.scene, this.capturables, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      onCaught: (credits, xp, x, y, z) => { this.addCredits(credits); this.awardXp(xp); this.popups.pop(x, y, z, `BOUNTY +${credits}c`, '#ffd24a') },
      banner: (text) => { this.hud.banner = text; this.bannerTimer = 2.6 },
    }))
    // Cargo run: a repeatable timed delivery job that gives traversal a purpose.
    this.systems.register(new CargoRun(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      onDeliver: (credits, xp, x, y, z) => { this.addCredits(credits); this.awardXp(xp); this.popups.pop(x, y, z, `DELIVERED +${credits}c`, '#9bff6a') },
      banner: (text) => { this.hud.banner = text; this.bannerTimer = 2.4 },
    }))
    // Rogue titan: a roaming multi-hit BOSS mech you chip down with net/missiles.
    this.systems.register(new RogueTitan(this.engine.scene, this.capturables, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      onHit: (pos) => this.popups.pop(pos.x, pos.y, pos.z, 'HIT', '#ff6a4a'),
      onDefeated: (credits, xp, x, y, z) => { this.addCredits(credits); this.awardXp(xp); this.popups.pop(x, y, z, `TITAN DOWN +${credits}c`, '#ffd24a') },
      banner: (text) => { this.hud.banner = text; this.bannerTimer = 2.6 },
      shockwave: (x, y, z) => this.missiles.shockwave({ x, y, z }, 0xff7a3a, 5, 0.5),
    }))
    // Night-market district: glowing vendor stalls that come alive after dark.
    this.systems.register(new NightMarket(this.engine.scene, {
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      dayFactor: () => this.world.dayFactor,
    }))
    // Sky dreadnought: a giant airborne BOSS you fly up to and chip down.
    this.systems.register(new SkyDreadnought(this.engine.scene, this.capturables, {
      focus: () => this.player.position,
      onHit: (pos) => this.popups.pop(pos.x, pos.y, pos.z, 'HIT', '#ff6a4a'),
      onDefeated: (credits, xp, x, y, z) => { this.addCredits(credits); this.awardXp(xp); this.popups.pop(x, y, z, `DREADNOUGHT DOWN +${credits}c`, '#ffd24a') },
      banner: (text) => { this.hud.banner = text; this.bannerTimer = 2.8 },
    }))
    // Level-up celebration: a world FX burst + banner when you level up.
    this.systems.register(new LevelUpShow(this.engine.scene, {
      focus: () => this.player.position,
      level: () => levelForXp(this.progression.xp),
      banner: (text) => { this.hud.banner = text; this.bannerTimer = 2.4 },
    }))
    // Wandering merchant: a roaming vendor drone - a mobile credit sink to hunt down.
    this.systems.register(new WanderingMerchant(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      credits: () => this.credits,
      spend: (cost) => { if (this.credits < cost) return false; this.addCredits(-cost); return true },
      buff: (kind) => this.applyPowerup(kind),
      notify: (x, y, z, label, color) => this.popups.pop(x, y, z, label, color),
    }))
    // Data relics: a curated collect-them-all set hidden around the city.
    this.systems.register(new DataRelics(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      onScan: (got, total, x, y, z) => { this.addCredits(30); this.awardXp(20); this.popups.pop(x, y, z, `DATA ${got}/${total}`, '#9bd4ff'); this.hud.banner = `DATA RELIC ${got}/${total}`; this.bannerTimer = 1.6 },
      onComplete: (credits, xp) => { this.addCredits(credits); this.awardXp(xp) },
      banner: (text) => { this.hud.banner = text; this.bannerTimer = 2.8 },
    }))
    // Turret nests: fixed hostile turrets that make certain spots dangerous.
    this.systems.register(new TurretNests(this.engine.scene, this.capturables, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      onZap: (kx, kz, ky) => { this.player.velocity.x += kx; this.player.velocity.z += kz; this.player.velocity.y += ky; this.player.grounded = false },
    }))
    // Objective trail: a glowing breadcrumb path guiding to the current goal.
    this.systems.register(new ObjectiveTrail(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      target: () => this.missions.objBeacon.visible ? this.missions.objBeacon.position : null,
    }))
    // Captured entourage: the aliens you've caught trail behind you as a flex.
    this.systems.register(new CapturedEntourage(this.engine.scene, {
      focus: () => this.player.position,
      yaw: () => this.player.yaw,
      count: () => this.hud.captured,
    }))
    // Milestone toasts: celebratory callouts when you cross capture/credit/level marks.
    this.systems.register(new MilestoneToasts({
      stats: () => ({ captured: this.hud.captured, credits: this.credits, level: levelForXp(this.progression.xp) }),
      banner: (text) => { this.hud.banner = text; this.bannerTimer = 2.6 },
      notify: (text) => this.popups.pop(this.player.position.x, this.player.position.y + 2.4, this.player.position.z, text, '#ffd24a'),
    }))
    // Ad blimps: big slow advertising airships drifting over the skyline.
    this.systems.register(new AdBlimps(this.engine.scene, { focus: () => this.focus }))
    // Monorail: an elevated neon train endlessly looping the city.
    this.systems.register(new Monorail(this.engine.scene))
    // Care packages: periodic supply drops you race to claim for a reward.
    this.systems.register(new CarePackages(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      onCollect: (x, y, z, credits, xp) => { this.addCredits(credits); this.awardXp(xp); this.popups.pop(x, y, z, `SUPPLY +${credits}c`, '#9bff6a') },
      banner: (text) => { this.hud.banner = text; this.bannerTimer = 2.6 },
    }))
    // --- Off-world atmosphere (Moon + Mars): make the other worlds amazing ---
    // Orbital traffic: shuttles rising + descending around the colonies.
    this.systems.register(new OrbitalTraffic(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
    }))
    // Cosmic sky: nebulae, a galaxy band, and shooting stars over the off-world.
    this.systems.register(new CosmicSky(this.engine.scene, { focus: () => this.focus }))
    // Colonist NPCs: spacesuited figures wandering the lunar/martian surface.
    this.systems.register(new ColonistNPCs(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
    }))
    // Megastructure: a space elevator (Mars) / orbital ring (Moon) on the horizon.
    this.systems.register(new Megastructure(this.engine.scene, { focus: () => this.focus }))
    // Low-grav drift: regolith + ice shards floating around you on the Moon.
    this.systems.register(new LowGravDrift(this.engine.scene, { focus: () => this.focus }))
    // Meteor strikes: telegraphed surface impacts with shockwaves (Moon + Mars).
    this.systems.register(new MeteorStrikes(this.engine.scene, {
      focus: () => this.player.position,
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
      shockwave: (x, y, z) => this.missiles.shockwave({ x, y, z }, 0xffa64a, 6, 0.6),
    }))
    // Floating "+score" reward popups at captures / pickups.
    this.popups = this.systems.register(new FloatingPopups(this.engine.scene))
    // A little hover-drone buddy that trails you on foot in every zone.
    this.systems.register(new CompanionDrone(this.engine.scene, {
      focus: () => this.player.position,
      yaw: () => this.player.yaw,
      active: () => this.player.mode === 'robot' && !this.vehicles.current && !this.hud.minigame && !this.dropIn && !this.launchPad,
    }))
    // Off-world wildlife you can net: lunar drifters / Mars crawlers register as
    // Capturables so the existing net + missiles catch them. Moon/Mars-gated.
    this.systems.register(new OffworldCritters(this.engine.scene, this.capturables, {
      groundY: (x, z) => this.physics.sampleGround(x, z, 120)?.y ?? 0,
    }))
    // Ambient world events (ship flyovers, drone swarms, meteors, cargo drops)
    // and off-path exploration rewards (discoveries + collectible energy cores).
    this.worldEvents = new WorldEvents(this.engine.scene)
    this.worldEvents.onEvent = (label) => {
      if (this.bannerTimer <= 0) { this.hud.banner = label; this.bannerTimer = 2.5 } // longer silence between event banners
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
    this.robotFactory = new RobotFactory(this.engine.scene, this.physics)
    const raceGround = (x: number, z: number) => this.physics.sampleGround(x, z, 80)?.y ?? 0
    for (const course of RACE_COURSES) {
      const race = new RaceActivity(this.engine.scene, raceGround, course)
      race.onSfx = (k) => this.audio.play(k === 'cp' ? 'ui' : 'objective')
      race.onFinish = (credits, xp, isBest) => {
        this.addCredits(credits)
        this.awardXp(xp)
        this.hud.banner = `RACE ${this.raceHud.result.toFixed(1)}s${isBest ? '  NEW BEST!' : ''}  +${credits}c`
        this.bannerTimer = 3.2
        vibrate(50)
      }
      this.races.push(race)
    }
    // Earth surfaces are the live physics surface during construction (any
    // off-world initialZone travels later), so build the Earth course now; the
    // off-world courses build on first travel, when their terrain is live.
    this.races.forEach((r) => r.setActive('earth'))
    this.events = new Events(this.engine.scene, this.physics, this.capturables, (kind) => this.applyPowerup(kind), () => this.onBusted())
    this.citySpectacle = new CitySpectacle(this.engine.scene)
    this.patrols = new Patrols(this.engine.scene, this.physics, tier.densityScale)
    this.sky = new Sky(this.engine.scene, tier.densityScale)
    this.camera = new CameraController(this.engine.camera, this.world.solidMeshes)
    // Vehicle groups are dynamic collision blockers so the camera doesn't clip
    // through big parked titans/mechs (the static solids list doesn't include them).
    this.camera.setBlockers(this.vehicles.list.map((v) => v.model.group))
    this.camera.snap(this.player.position)
    this.input.onZoom = (f) => this.camera.adjustZoom(f)

    // Hub fixtures (arcade cabinets, plaza ring, rocket gate) are built in
    // Landmarks.ts; Game keeps the data + the per-frame behaviour.
    const lm = buildLandmarks(this.engine.scene, this.physics, this.world.solidMeshes)
    this.arcadePortals = lm.arcadePortals
    this.plazaHub = lm.plazaHub
    this.plazaMars = lm.plazaMars
    this.rocketGate = lm.rocketGate
    this.arcadeMats.push(...lm.mats)
    this.arcadeGeos.push(...lm.geos)
    this.arcadeTex.push(...lm.texs)
    this.arcadeScreenUpdate = lm.screenUpdate
    // Arcade proximity + transport beam (beam is a pooled mesh ArcadeSystem owns
    // and frees in its own dispose(); the arcade arrays hold only landmark resources).
    this.arcade = new ArcadeSystem(this.engine.scene)

    // Soft world edge: a ring of jiggly alien blobs just inside the city rim that
    // bounce you back toward the arcade instead of an abrupt invisible wall. Earth
    // only; count + eyes scale down on the mobile tier.
    {
      const lowTier = tier.name === 'low'
      this.boundary = new Boundary(
        this.engine.scene,
        (x, z) => this.physics.sampleGround(x, z, 200)?.y ?? 0,
        // Ring the OUTER rim of the grid (not scattered in the city), so it reads
        // as the edge of the world. More blobs so the rim stays covered.
        { radius: config.world.half - 2, count: lowTier ? 22 : tier.name === 'medium' ? 28 : 34, arcade: new THREE.Vector3(0, 0, 46), eyes: !lowTier },
      )
    }

    // Spawn greeter: a waving robot + a "FOLLOW ME" ground arrow that walks new
    // players to the arcade entrance (the arcade hall sits at z 46, front at z 28).
    // You drop in at the plaza (~z=20, just south of the arcade whose hall is at
    // z=46, front door z=28). So the greeter waits at the door facing you, the
    // FOLLOW ME arrow sits at the landing pointing north to it, and it leads you
    // INTO the hall when you walk up.
    this.guide = new GuideBot(
      this.engine.scene,
      (x, z) => this.physics.sampleGround(x, z, 200)?.y ?? 0,
      { start: new THREE.Vector2(0, 27), arcade: new THREE.Vector2(0, 40), arrowAt: new THREE.Vector2(0, 19) },
    )
    this.landingFx = new LandingFx(this.engine.scene, tier.name === 'low')

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

    this.vehicles.onEnterRocket = (rocket) => this.startRocketLaunch(rocket)

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
      // Automation (synthetic input) never holds a real pointer lock, so an
      // unlock here is meaningless and must not pause the sim mid-test.
      if (this.botMode) return
      // The warp picker frees the cursor on purpose (so its buttons are clickable
      // on desktop); don't treat that as a pause request.
      if (!this.paused && !this.warpMenuOpen) this.setPaused(true)
    }

    this.controls = {
      setVirtualMove: (x: number, y: number) => this.input.setVirtualMove(x, y),
      setVirtualLook: (dx: number, dy: number) => this.input.setVirtualLook(dx, dy),
      pressAction: (a: Parameters<Input['pressAction']>[0], down: boolean) => this.input.pressAction(a, down),
      resume: () => this.setPaused(false),
      pause: () => this.setPaused(true),
      skipIntro: () => {
        if ((this.intro && !this.intro.done) || (this.dropIn && !this.dropIn.done) || this.launchPad) trackEvent('intro_skipped')
        this.intro?.skip()
        // Skipping from the launch pad starts the dive, then immediately lands it.
        if (this.launchPad) { this.endLaunchPad(); this.beginDropIn() }
        this.dropIn?.skip()
      },
      dropDeploy: () => this.dropIn?.deploy(),
      dropTrick: () => this.dropIn?.trick(),
      requestPointerLock: () => this.input.requestLock(),
      // The welcome panel keeps the cursor free so its buttons stay clickable;
      // locking is re-enabled once the player picks solo / multiplayer.
      setCursorLockEnabled: (on: boolean) => { this.input.setLockEnabled(on); if (!on) this.input.exitLock() },
      adjustZoom: (factor: number) => this.camera.adjustZoom(factor),
      exitMinigame: () => this.exitMinigame(),
      openArcade: () => this.teleportToArcade(),
      restartIntro: () => this.restartIntro(),
      toggleMute: () => { this.hud.muted = this.audio.toggleMute(); trackEvent('mute_toggled', { muted: this.hud.muted }) },
      cycleNeon: () => this.cycleNeon(),
      challengePilot: (id: string) => this.mp.challenge(id, this.equippedTrailColor()),
      acceptChallenge: () => this.mp.accept(this.equippedTrailColor()),
      declineChallenge: () => this.mp.decline(),
      matchDir: (dx: number, dy: number) => this.mp.matchDir(dx, dy),
      quitMatch: () => this.mp.leaveMatch(),
      rematch: () => this.mp.rematch(this.equippedTrailColor()),
      buyCosmetic: (id: string) => this.buyCosmetic(id),
      equipCosmetic: (slot: 'trail' | 'accent', id: string) => this.equipCosmetic(slot, id),
      toggleWarp: () => this.toggleWarp(),
      warpInto: (id: string) => this.warpInto(id),
      warpRevert: () => this.warpRevert(),
      // Kid-safe chat: SEND gate (parent flag) + filter, then relay to the net.
      sendChat: (text: string) => {
        if (!this.chatEnabled) return
        const v = filterChat(text)
        if (!v.allowed) return
        this.mp.sendChat(v.text)
      },
      setChatSink: (fn: (m: ChatMessage) => void) => { this.chatSink = fn },
      refreshChatEnabled: () => { this.chatEnabled = isChatEnabled() },
      // Anonymous cloud save surface for the save / recovery panel.
      saveRecoveryCode: () => this.saveStore?.recoveryCode() ?? '',
      saveOnline: () => !!this.saveStore?.online,
      saveRestore: (code: string) => this.saveStore?.restore(code) ?? Promise.resolve({ ok: false, error: 'nostore' }),
      myNetId: () => this.mp.myId ?? '',
    }

    this.hud = {
      mode: 'robot', zone: this.zone, stamina: 1, fuel: 1, score: 0, best: this.profile.best, credits: this.profile.credits, captured: 0,
      shards: { found: 0, total: 0 },
      combo: { active: false, points: 0, mult: 1 },
      captureChain: null,
      perf: null,
      speed: 0, altitude: 0, heading: 0, prompt: null, powerup: null, shield: false,
      fps: 60, paused: false, lookLocked: false, loading: false, loadingProgress: 1,
      loadingMsg: '', intro: false, onPlatform: false, vehicle: null, radar: [], fade: 0, banner: null,
      objective: config.missions[0]?.title ?? null,
      muted: this.audio.isMuted,
      canCapture: false,
      missionPopup: null,
      minigame: null,
      online: 1,
      leaderboard: [],
      neon: this.neonLevel,
      profiles: [],
      challenge: null,
      match: null,
      progress: this.buildProgressHud(),
      warp: { charge01: 0, ready: false, active: null, menu: false },
      race: { ...this.raceHud },
      heat: { stars: 0, max: config.heat.max, wanted: false },
      drop: null,
      raid: null,
      chatEnabled: this.chatEnabled,
    }
    // After hud + world exist: apply the persisted neon level (sets density + bloom).
    this.applyNeon()
    // Roll the daily objective / update the login streak, and apply the equipped
    // accent cosmetic to the player's robot.
    noteLogin()
    this.refreshProgression()
    this.applyAccentCosmetic()

    // Default to a pure-local save store so solo / offline play is fully wired even
    // if the shell never calls attachSave(). The shell re-calls attachSave(host)
    // right after construction to upgrade to the anonymous cloud save; that re-fold
    // is idempotent (localStorage stays the source of truth).
    this.attachSave()

    this.engine.onUpdate = this.update
    this.engine.onRender = this.renderFrame
    // Expose the game handle in dev, or in prod when ?debug is present (lets a
    // remote playtest reach internals without a dev build).
    if (import.meta.env.DEV || /[?&]debug\b/.test(window.location.search)) {
      (window as unknown as { __unit7?: Game }).__unit7 = this
      // A small, stable navigation/test surface for browser automation (e.g.
      // Claude Chrome). Same debug gate -> zero impact on normal players.
      this.installNav()
    }

    // Spawn directly into an off-world zone if requested.
    if (this.zone !== 'earth') {
      const z = this.zone
      this.zone = 'earth'
      this.doTravel(z)
    }

    // The opening you play, not watch: start standing on the floating factory
    // launch pad and step off the ledge into the skydive (skippable). Off-world
    // debug starts skip straight to gameplay.
    if (this.cfg.startInIntro && this.zone === 'earth') {
      this.beginLaunchPad()
    } else {
      this.startMorning()
      // Start on foot here too - the hoverboard is opt-in via the BOARD button.
      this.player.setBoard(false)
      // Without multiplayer there's no join/solo prompt, so control begins now.
      if (!this.multiplayerEnabled) this.emitGameStart('solo')
    }
  }

  /**
   * Begin the interactive drop-in: hide the player (the diver is the DropIn's own
   * rig), brighten the sky to a lit sunrise (skipping the pitch-black pre-dawn),
   * and lighten the fog so the city reads from altitude. The day clock runs on
   * through the descent so you land as the sun finishes cresting.
   */
  /** Stand the player on the floating factory launch pad, high above the city, at
   *  the dive's start point - so stepping off the ledge hands straight into the
   *  skydive. Robots are stamped out behind you and march off the edge to dive. */
  private beginLaunchPad() {
    const tx = 0, tz = 20
    this.dropLand.set(tx, this.physics.sampleGround(tx, tz, 120)?.y ?? 0, tz)
    const start = new THREE.Vector3(tx + 30, 1320, tz - 300) // matches DropIn's default high-altitude start
    const faceYaw = Math.atan2(tx - start.x, tz - start.z) // local +Z (the ledge) points at the city
    this.launchPad = new LaunchPad(this.engine.scene, start, faceYaw)
    this.physics.addGroundMesh(this.launchPad.collider)
    // Make the assembly line solid so you walk around it, not through it.
    for (const b of this.launchPad.colliderBoxes()) { this.physics.colliders.push(b); this.launchPadColliders.push(b) }
    this.player.exitVehicle(this.launchPad.spawn)
    this.player.setVisible(true)
    this.player.setBoard(false)
    // Park a couple of drivable rides up here too: hop in (G) and drive off the
    // edge to dive in the vehicle (bail or pop the chute on the way down).
    {
      const c = start
      const fwd = new THREE.Vector3(Math.sin(faceYaw), 0, Math.cos(faceYaw))
      const right = new THREE.Vector3(Math.cos(faceYaw), 0, -Math.sin(faceYaw))
      const spot = (rx: number, fz: number) => c.clone().addScaledVector(right, rx).addScaledVector(fwd, fz)
      this.vehicles.lendToPad([
        { kind: 'hovercar', pos: spot(10, -6), yaw: faceYaw },
        { kind: 'speeder', pos: spot(-10, -6), yaw: faceYaw },
      ])
    }
    this.input.yaw = this.launchPad.spawnYaw
    this.input.pitch = 0.15 // raised from the old cramped 0.06, but still framing the tower ahead
    this.launchCineT = 0 // kick off the establishing-orbit cinematic
    this.player.resetInterp()
    this.camera.snap(this.player.position)
    this.input.setLockEnabled(true)
    if (!this.timeFromQuery) { this.world.setDebugTime(9); this.world.setTimeScale(0.5); this.morningSunrise = true }
    const fog = this.engine.scene.fog
    if (fog instanceof THREE.FogExp2 && this.savedFogDensity == null) { this.savedFogDensity = fog.density; fog.density = 0.0006 }
    this.engine.setAdaptive(false, config.tier.name === 'low' ? 0.85 : 1)
    // This is the START of the skydive, NOT a separate intro: you play it with the
    // normal on-foot controls (the touch stick MUST be visible), so DON'T set
    // hud.intro (that hides MobileControls). onPlatform just suppresses the arcade
    // warp while you're up here.
    this.hud.intro = false
    this.hud.onPlatform = true
    // Keep the opening clean: the in-world DROP ZONE sign + the one-line objective
    // carry it. No center banner (it just doubled the sign) and no story card.
    this.hud.banner = null
    this.bannerTimer = 0
    this.hud.missionPopup = null
    this.missionPopupTimer = 0
    if (!this.multiplayerEnabled) this.emitGameStart('solo') // controls live now (solo); MP starts on the join pick
  }

  private endLaunchPad() {
    if (!this.launchPad) return
    this.launchCineT = -1
    this.physics.removeGroundMesh(this.launchPad.collider)
    for (const b of this.launchPadColliders) { const i = this.physics.colliders.indexOf(b); if (i >= 0) this.physics.colliders.splice(i, 1) }
    this.launchPadColliders.length = 0
    // Send the lent rides back to the city - except one you're riding off the edge.
    this.vehicles.returnFromPad(this.dropVehicle)
    this.launchPad.dispose()
    this.launchPad = null
    this.hud.onPlatform = false
  }

  private beginDropIn(startPos?: THREE.Vector3, easeIn?: boolean) {
    // Steer toward the open plaza right in front of the ARCADE - the activity hub
    // (arcade doors, bounce pads, cannons, the mech, the Mars gate are all here),
    // so you touch down in the middle of the fun instead of an empty edge.
    const tx = 0, tz = 20
    this.dropLand.set(tx, this.physics.sampleGround(tx, tz, 120)?.y ?? 0, tz)

    // Ground that includes building rooftops, so you can land ON a roof instead of
    // sinking through it; and a wall resolver so the diver can't pass through
    // buildings. Both reuse the live physics colliders.
    const dropGround = (x: number, z: number) => {
      const g = this.physics.sampleGround(x, z, 80)?.y ?? 0
      const roof = this.physics.topSupport(x, z, 1e6)
      return roof != null && roof > g ? roof : g
    }
    this.dropIn = new DropIn(this.engine.scene, this.engine.camera, this.input, this.dropLand, dropGround, (pos, vel) => this.physics.resolveHorizontal(pos, vel, 1.4, 3), startPos, easeIn)
    this.dropIn.onSfx = (k) => this.audio.play(k === 'ring' ? 'objective' : k === 'deploy' ? 'ui' : 'portal')
    // Pin the render resolution for the whole drop so no mid-skydive buffer
    // resize can flash black on mobile; a touch lower on the low tier for headroom.
    this.engine.setAdaptive(false, config.tier.name === 'low' ? 0.85 : 1)
    this.hud.intro = true // surfaces the SKIP button
    this.player.setVisible(false)
    // Keep the cursor FREE during the drop (drag to look) so the DEPLOY / CUT
    // buttons stay clickable on desktop - clicking to look would otherwise lock
    // the pointer and you couldn't press them.
    this.input.setLockEnabled(false)
    this.input.exitLock()
    if (!this.timeFromQuery) {
      this.world.setDebugTime(9) // mid-sunrise: gold and lit, not dark
      this.world.setTimeScale(0.5)
      this.morningSunrise = true
    }
    const fog = this.engine.scene.fog
    // Don't clobber the density the launch pad already saved (or we'd restore the
    // thinned value, not the original, after landing).
    if (fog instanceof THREE.FogExp2) { if (this.savedFogDensity == null) this.savedFogDensity = fog.density; fog.density = 0.0007 }
    // When eased in from the pad, don't slam a banner + wall-of-text over the
    // smooth hand-off; the in-dive HUD (jetpack tip, altimeter, PULL UP) coaches it.
    this.hud.banner = easeIn ? null : 'HIGH-ALTITUDE DROP'
    this.bannerTimer = easeIn ? 0 : 2.5
    this.hud.missionPopup = { title: 'SKYDIVE', body: 'Steer with WASD or drag. Hold SPACE to jetpack; press O for the chute before you land. Fly through a portal to pick where you touch down.' }
    this.missionPopupTimer = easeIn ? 4 : 8
  }

  /** Drove off the pad in a vehicle: keep the player in it and let the SKYDIVE drive
   *  the fall, with the car as the diver. Press the chute to land it safe, or bail. */
  private beginVehicleDrop(off: THREE.Vector3) {
    const v = this.vehicles.current
    if (!v) return
    this.dropVehicle = v
    this.endLaunchPad() // returns the OTHER lent ride; keeps this one (it's dropVehicle)
    this.beginDropIn(off, true)
    this.dropIn?.setRider(v.model.group)
    this.audio.play('portal')
    vibrate(40)
    this.hud.banner = `${v.name} OFF THE EDGE`
    this.bannerTimer = 2
    this.hud.missionPopup = { title: 'VEHICLE DIVE', body: 'You rode off in the ' + v.name + '! Press O for the chute to ride it down safe - or press G to bail out and skydive.' }
    this.missionPopupTimer = 6
  }

  private finishDrop() {
    // Reward the drop: how cleanly (how high) you popped the canopy, plus any
    // target orbs threaded. A crash pays little (but the repair drone saves you).
    const di = this.dropIn
    const crashed = di?.crashed ?? false
    const q = di?.chuteQuality ?? 0
    const orbBonus = (di?.bonusTargets ?? 0) * 30 + (di?.perfects ?? 0) * 20 // dead-centre threads pay extra
    const trickBonus = Math.min(di?.tricks ?? 0, 8) * 15 // flips + fireworks flair
    // Rival race: credit for every skydiver you finished ahead of.
    const placeBonus = di ? Math.max(0, di.raceTotal - di.racePlace) * 25 : 0
    const dest = di?.chosenDest ?? null
    // Where you come down. Flying through a destination portal overrides it:
    // arcade/city -> the plaza; mars/moon -> a zone jump kicked off below. A CRASH
    // also comes down at the plaza (the repair drone sets you on the onboarding
    // spot) so you always land right by the guide robot, the arcade and the first
    // objectives instead of stranded out at the edge of the map.
    const land = dest === 'arcade' || dest === 'city' || crashed ? this.dropLand.clone() : di ? di.landingPos.clone() : this.dropLand.clone()
    const chuteBonus = crashed ? 0 : q >= 0.78 ? 180 : q >= 0.5 ? 80 : 0
    const credits = (crashed ? 40 : 120) + chuteBonus + orbBonus + trickBonus + placeBonus
    const xp = (crashed ? 20 : 50) + (q >= 0.78 ? 40 : 0)
    this.dropIn?.dispose()
    this.dropIn = null
    this.engine.setAdaptive(true) // resume adaptive resolution for normal play
    this.addCredits(credits)
    this.awardXp(xp)
    const grade = crashed ? 'REASSEMBLED' : q >= 0.78 ? 'CLEAN LANDING' : q >= 0.5 ? 'GOOD LANDING' : 'TOUCHDOWN'
    this.hud.banner = `${grade}  +${credits}c`
    this.bannerTimer = 3.4
    this.hud.intro = false
    this.hud.drop = null
    // Rode a vehicle the whole way down (and didn't portal off-world): set it on the
    // ground at the landing spot and keep driving it.
    const keepDriving = this.dropVehicle && dest !== 'mars' && dest !== 'moon'
    if (keepDriving) {
      const v = this.dropVehicle!
      this.dropVehicle = null
      const gy = this.physics.sampleGround(land.x, land.z, 80)?.y ?? 0
      v.position.set(land.x, gy + v.hoverHeight, land.z)
      v.velocity.set(0, 0, 0)
      v.model.group.position.copy(v.position)
      this.vehicles.current = v
      this.player.enterVehicle() // stay in the car (hidden robot); camera frames it
      this.player.object.position.copy(v.position)
      this.camera.snap(v.position)
      this.input.setLockEnabled(true)
      this.hud.banner = `${v.name} TOUCHDOWN  +${credits}c`
    } else {
      if (this.dropVehicle) {
        // Portaled off-world mid-drop: send the car home and step out on foot.
        const v = this.dropVehicle; this.dropVehicle = null
        v.position.copy(v.home); v.model.group.position.copy(v.home); this.vehicles.current = null
      }
      // Hand off standing exactly where you came down - no relocation.
      this.player.exitVehicle(land)
      this.player.setVisible(true)
      // Land on foot, not on the board - the hoverboard is opt-in via the BOARD
      // button (C / mobile) once you're roaming, so the world opens with the robot
      // standing and free to walk up to the guide.
      this.player.setBoard(false)
      this.camera.snap(this.player.position)
      this.input.setLockEnabled(true)
    }
    const fog = this.engine.scene.fog
    if (fog instanceof THREE.FogExp2 && this.savedFogDensity != null) { fog.density = this.savedFogDensity; this.savedFogDensity = null }
    this.hud.fade = 1
    if (dest === 'mars' || dest === 'moon') {
      // You picked an off-world portal on the way down: jump straight there.
      this.trans = { phase: 'none', t: 0, target: this.zone }
      this.requestTravel(dest)
      this.hud.banner = `PORTAL · ${dest.toUpperCase()}`
    } else {
      // The drop ended on a brief fade; fade back in on the gameplay side so the
      // hand-off to the follow camera reads as one continuous shot.
      this.trans = { phase: 'in', t: 0, target: this.zone }
      // Make every arrival a moment: a shockwave + spark burst at the touchdown
      // spot, tinted by how it went (crash = ember, clean = green, else cyan).
      this.landingFx.trigger(land, crashed ? 0xff5a3c : q >= 0.78 ? 0x9dff5a : 0x27e7ff, !crashed && q >= 0.5)
      // Grace period so the player can orient before the Mars gate (which sits on
      // the route out) can fire — stops an accidental yank to Mars on hand-off.
      this.travelCooldown = 3
      this.hud.missionPopup = { title: 'UNIT 7 ONLINE', body: 'Follow the green beacon to your objective - the OBJECTIVE readout shows the distance.' }
      this.missionPopupTimer = 6
      // FIRST time you touch down on Earth, you land straight into a city raid:
      // board the mech and repel the waves. Overrides the calm "ONLINE" popup.
      if (!this.raidDone && this.zone === 'earth') this.beginCityRaid(land)
    }
    // On a restart replay the solo/multiplayer choice was already made, so
    // re-announce game_start; on a first solo run with no join prompt, begin now.
    if (this.startedMode) this.emitGameStart(this.startedMode)
    else if (!this.multiplayerEnabled) this.emitGameStart('solo')
  }

  /** The hot landing: you touch down into an active alien raid on the plaza. A free
   *  mech is set down right beside you - board it and wipe out the escalating waves. */
  private beginCityRaid(land: THREE.Vector3) {
    this.raidDone = true
    this.raidActive = true
    this.raidWaveShown = 0
    this.raidShield = 1
    this.raidStagger = 0
    this.raidBossShown = false
    // Set the free starter mech down a few steps away so it's an obvious grab.
    const mech = this.vehicles.list.find((v) => v.kind === 'mechM')
    if (mech) {
      const mx = land.x + 11, mz = land.z + 3
      const gy = this.physics.sampleGround(mx, mz, 80)?.y ?? land.y
      mech.position.set(mx, gy + mech.hoverHeight, mz)
      mech.home.copy(mech.position)
      mech.yaw = Math.atan2(land.x - mx, land.z - mz)
      mech.model.group.position.copy(mech.position)
      mech.model.group.visible = true
    }
    this.events.startRaid(land, 3)
    // Juicy kills: every destroyed invader pops with a burst, a camera kick and a
    // little hit-stop for weight.
    this.events.onRaidKill = (pos) => {
      this.camera.shake(0.32)
      this.engine.triggerHitstop(0.028)
      this.landingFx.trigger(pos, 0xffb24a, false)
      this.audio.play('portal')
    }
    // Mothership destroyed: a big multi-stage payoff (the raid's climax).
    this.events.onBossDeath = (pos) => {
      this.camera.shake(1.6)
      this.engine.triggerHitstop(0.09)
      this.landingFx.trigger(pos, 0xffd24a, true)
      this.landingFx.trigger(pos, 0xff8a3c, false)
      this.audio.play('portal')
      vibrate(120)
      this.profile.motherships += 1
      this.persist()
      this.refreshProgression() // unlock Sky Breaker / Fleet Bane
    }
    // Mothership ground-strike: a big shield hit (and knockback) if it catches you;
    // a near-miss still rattles the camera so dodging feels earned.
    this.events.onBossStrike = (pos, hit) => {
      this.landingFx.trigger(pos, 0xff5a2a, hit)
      if (hit && this.raidStagger <= 0) {
        this.raidShield = Math.max(0, this.raidShield - 0.45)
        this.camera.shake(0.9)
        this.engine.triggerHitstop(0.04)
        vibrate(70)
        if (this.raidShield <= 0) this.breakRaidShield()
      } else {
        this.camera.shake(0.3)
      }
      this.audio.play('explosion')
    }
    this.landingFx.trigger(land, 0xff3b52, false) // red alert shockwave
    this.audio.play('portal')
    vibrate(60)
    this.hud.banner = 'CITY UNDER RAID'
    this.bannerTimer = 2.5
    this.hud.missionPopup = { title: 'CITY UNDER RAID', body: 'Invaders are swarming the plaza! Board the MECH (G) and wipe out every wave - fire missiles with the CAPTURE button.' }
    this.missionPopupTimer = 6
  }

  private raidObjective(): string {
    const s = this.events.raidState
    if (!s) return 'Repel the raid'
    const inMech = !!this.vehicles.current && isWalker(this.vehicles.current.kind)
    if (!inMech) return 'Board the MECH and repel the raid'
    if (s.phase === 'boss') return s.boss ? `Destroy the MOTHERSHIP core - ${s.boss.hp}/${s.boss.hpMax}` : 'Destroy the MOTHERSHIP'
    if (s.phase === 'incoming') return `Wave ${s.wave + 1} incoming...`
    return `Repel WAVE ${s.wave}/${s.waves} - ${s.alive} hostiles`
  }

  private updateCityRaid(dt: number) {
    if (!this.raidActive) return
    const s = this.events.raidState
    if (!s) { this.raidActive = false; this.hud.raid = null; return }
    // Mech shield: invaders that crowd you drain it; it regenerates when you get
    // clear. Hit zero and you're knocked back + briefly staggered (never killed -
    // the raid has stakes, not a fail state).
    const inMech = !!this.vehicles.current && isWalker(this.vehicles.current.kind)
    const meleeR = inMech ? 8 : 5
    const contacts = this.events.raidContacts(this.player.position, meleeR)
    if (this.raidStagger > 0) {
      this.raidStagger = Math.max(0, this.raidStagger - dt)
    } else if (contacts > 0) {
      this.raidShield = Math.max(0, this.raidShield - contacts * 0.16 * dt)
      this.raidHitPulse -= dt
      if (this.raidHitPulse <= 0) { this.raidHitPulse = 0.22; this.camera.shake(0.18); vibrate(12) }
      if (this.raidShield <= 0) this.breakRaidShield()
    } else {
      this.raidShield = Math.min(1, this.raidShield + 0.12 * dt)
    }
    this.hud.raid = { wave: s.wave, waves: s.waves, alive: s.alive, incoming: s.phase === 'incoming', shield: this.raidShield, boss: s.boss }
    // Announce each new wave with a banner + sting.
    if (s.phase === 'fight' && s.wave !== this.raidWaveShown) {
      this.raidWaveShown = s.wave
      this.hud.banner = `WAVE ${s.wave} / ${s.waves}`
      this.bannerTimer = 1.8
      this.audio.play('objective')
      vibrate(30)
    }
    // The mothership descends for the final wave - sell the moment.
    if (s.phase === 'boss' && !this.raidBossShown) {
      this.raidBossShown = true
      this.hud.banner = 'MOTHERSHIP INBOUND'
      this.bannerTimer = 2.6
      this.hud.missionPopup = { title: 'MOTHERSHIP INBOUND', body: 'The alien command ship is descending! Fire missiles into the exposed core hanging beneath its hull to bring it down.' }
      this.missionPopupTimer = 5
      this.camera.shake(0.8)
      this.audio.play('portal')
      vibrate(80)
    }
    if (s.cleared) this.endCityRaid()
  }

  /** Shield depleted: shove the player/mech away from the nearest invader, shake,
   *  and grant a brief stagger window (invulnerable while you recover). */
  private breakRaidShield() {
    this.raidShield = 0.4
    this.raidStagger = 1.4
    const target = this.vehicles.current ? this.vehicles.current.position : this.player.position
    const near = this.events.nearestRaidAlien(target)
    if (near) {
      const dx = target.x - near.x, dz = target.z - near.z
      const d = Math.hypot(dx, dz) || 1
      target.x += (dx / d) * 8
      target.z += (dz / d) * 8
      if (this.vehicles.current) this.vehicles.current.model.group.position.copy(target)
      else this.player.resetInterp()
    }
    this.camera.shake(1.1)
    this.engine.triggerHitstop(0.05)
    this.audio.play('ui')
    vibrate(60)
    this.hud.banner = 'SHIELD DOWN — KNOCKED BACK'
    this.bannerTimer = 1.4
  }

  private endCityRaid() {
    this.raidActive = false
    this.events.onRaidKill = null // don't kick the camera while clearing stragglers
    this.events.onBossStrike = null
    this.events.onBossDeath = null
    this.events.stopRaid()
    this.hud.raid = null
    const credits = 250, xp = 120
    this.addCredits(credits)
    this.awardXp(xp)
    this.hud.banner = 'CITY SAVED'
    this.bannerTimer = 3.5
    this.hud.missionPopup = { title: 'CITY SAVED', body: `You held the line, Unit 7. +${credits} credits. The city is yours - follow the beacon to your first objective.` }
    this.missionPopupTimer = 6
    this.audio.play('objective')
    vibrate(80)
    this.landingFx.trigger(this.player.position, 0x9dff5a, true)
    this.world.pushHeadline('UNIT 7 REPELS RAID — CITY SAFE')
  }

  /** Tear the raid down WITHOUT the "city saved" reward + fanfare. Used when the
   *  player abandons it by leaving Earth: the raid is an Earth-city event, so it
   *  must not follow you to the Moon/Mars (its HUD banner + objective were
   *  rendering off-world). No credits/XP, since the city wasn't actually held. */
  private abortCityRaid() {
    if (!this.raidActive) return
    this.raidActive = false
    this.events.onRaidKill = null
    this.events.onBossStrike = null
    this.events.onBossDeath = null
    this.events.stopRaid()
    this.hud.raid = null
  }

  /** GAMES button / key: warp the player to right in front of the arcade, facing
   *  the neon marquee + the game doors, ready to walk in. Earth only; ignored
   *  during the drop-in, a zone change, or while a minigame is up. */
  private teleportToArcade() {
    if (this.zone !== 'earth' || this.dropIn || this.launchPad || this.hud.minigame || this.intro) return
    const x = 0, z = 24 // just south of the arcade's front opening (hall center z=46)
    const gy = this.physics.sampleGround(x, z, 60)?.y ?? 0
    this.input.yaw = 0 // face +z (north) - straight into the hall + marquee
    this.input.pitch = 0.06
    this.player.exitVehicle(new THREE.Vector3(x, gy, z))
    this.player.setBoard(false)
    this.camera.snap(this.player.position)
    this.landingFx.trigger(new THREE.Vector3(x, gy, z), 0xff2bd0, true) // magenta arrival sparkle
    this.audio.play('portal')
    this.hud.banner = 'ARCADE'
    this.bannerTimer = 2.2
    trackEvent('arcade_warp', {})
  }

  // --- automation / test harness -------------------------------------------

  /** Named teleport targets for the current zone. `x,z` is where the player is
   *  dropped; optional `yaw` faces them at the landmark's hero geometry on arrival
   *  (atan2(dx,dz) — forward is +z at yaw 0). Portal landmarks are placed just
   *  OUTSIDE their trigger radius so arriving frames the ring instead of instantly
   *  travelling. */
  private navLandmarks(): Record<string, { x: number; z: number; yaw?: number }> {
    const yawTo = (fx: number, fz: number, tx: number, tz: number) => Math.atan2(tx - fx, tz - fz)
    const sx = this.world.spawn.x, sz = this.world.spawn.z
    const m: Record<string, { x: number; z: number; yaw?: number }> = {
      spawn: { x: sx, z: sz, yaw: yawTo(sx, sz, 0, 0) }, // face city center
      origin: { x: 0, z: 0 },
    }
    if (this.zone === 'earth') {
      m.arcade = { x: 0, z: 24, yaw: 0 } // hall is north (+z) at z=46 — face into the marquee
      const fx = this.robotFactory.entrance.x, fz = this.robotFactory.entrance.z
      m.factory = { x: fx, z: fz, yaw: yawTo(fx, fz, -110, 64) } // face the HUMANOID ROBOTS tower + gantry
      m.raceGate = { x: 64, z: 8, yaw: yawTo(64, 8, 64, 24) }
      if (this.plazaMars) {
        const r = this.plazaMars.radius + 5
        m.marsPortal = { x: this.plazaMars.pos.x, z: this.plazaMars.pos.z - r, yaw: 0 } // stand south of the ring, face it
      }
      const moon = this.zones.earthPortals.find((p) => p.target === 'moon')
      if (moon) {
        const r = moon.radius + 5
        m.moonPortal = { x: moon.position.x, z: moon.position.z - r, yaw: 0 }
      }
    }
    return m
  }

  /**
   * Run the isolated player+physics fixed step over a deterministic scripted
   * input, twice from an identical seed, and fingerprint the result. Powers
   * window.__unit7nav.determinism(). Restores all touched state afterward.
   */
  private proveDeterminism(steps: number): { steps: number; identical: boolean; hashA: string; hashB: string; finalPos: { x: number; y: number; z: number }; finalVel: { x: number; y: number; z: number } } {
    const FIXED = config.render.fixedDelta // the one true sim step (1/60)
    const gravity = config.zones.earth.gravity
    const p = this.player
    const inp = this.input

    // Snapshot everything the probe mutates, to restore the live game after.
    const snap = {
      pos: p.position.clone(), vel: p.velocity.clone(),
      yaw: p.yaw, mode: p.mode, grounded: p.grounded, fuel: p.fuel, stamina: p.stamina,
      iyaw: inp.yaw, ipitch: inp.pitch, jet: inp.held.jet,
    }
    const seedY = (this.physics.sampleGround(0, 0, 300)?.y ?? 0) + 1.2

    // FNV-1a over the IEEE-754 bytes of the final transform+velocity — a bit-exact
    // fingerprint, so any drift in the physics (or any non-determinism) changes it.
    const fingerprint = (nums: number[]) => {
      const dv = new DataView(new ArrayBuffer(nums.length * 8))
      nums.forEach((v, i) => dv.setFloat64(i * 8, v))
      let h = 0x811c9dc5
      for (let i = 0; i < dv.byteLength; i++) { h ^= dv.getUint8(i); h = Math.imul(h, 0x01000193) }
      return (h >>> 0).toString(16).padStart(8, '0')
    }

    const run = () => {
      p.resetForSim(0, seedY, 0, 0)
      inp.yaw = 0; inp.pitch = 0; inp.held.jet = false
      for (let i = 0; i < steps; i++) {
        // Deterministic scripted input: run forward, weave with a sine strafe, and
        // pulse the jetpack in bursts — exercises accel, turn, jump, fly and fall.
        inp.setVirtualMove(Math.sin(i * 0.07) * 0.6, 1)
        inp.update()
        inp.held.jet = (i % 50) < 8
        if (i % 50 === 0) inp.pressAction('jet', true)
        p.update(FIXED, inp, this.physics, gravity)
      }
      const pos = p.position, vel = p.velocity
      return { hash: fingerprint([pos.x, pos.y, pos.z, vel.x, vel.y, vel.z]), pos, vel }
    }

    const a = run()
    const aHash = a.hash
    const aPos = { x: a.pos.x, y: a.pos.y, z: a.pos.z }
    const aVel = { x: a.vel.x, y: a.vel.y, z: a.vel.z }
    const b = run()

    // Restore the live game's player + input exactly as they were.
    p.resetForSim(snap.pos.x, snap.pos.y, snap.pos.z, snap.yaw)
    p.velocity.copy(snap.vel); p.mode = snap.mode; p.grounded = snap.grounded; p.fuel = snap.fuel; p.stamina = snap.stamina
    inp.yaw = snap.iyaw; inp.pitch = snap.ipitch; inp.held.jet = snap.jet
    inp.setVirtualMove(0, 0)
    this.camera.snap(p.position)

    const round = (n: number) => Number(n.toFixed(4))
    return {
      steps,
      identical: aHash === b.hash,
      hashA: aHash,
      hashB: b.hash,
      finalPos: { x: round(aPos.x), y: round(aPos.y), z: round(aPos.z) },
      finalVel: { x: round(aVel.x), y: round(aVel.y), z: round(aVel.z) },
    }
  }

  /** Snap the player to a ground position (debug teleport). Crash-safe: clamps
   *  NaN and samples the live terrain for Y when not given. */
  private navTeleport(x: number, z: number, y?: number, faceYaw?: number) {
    x = Number.isFinite(x) ? x : 0
    z = Number.isFinite(z) ? z : 0
    const gy = Number.isFinite(y as number) ? (y as number) : (this.physics.sampleGround(x, z, 400)?.y ?? 0) + 0.2
    if (Number.isFinite(faceYaw as number)) { this.input.yaw = faceYaw as number; this.player.yaw = faceYaw as number }
    this.player.exitVehicle(new THREE.Vector3(x, gy, z))
    this.camera.snap(this.player.position)
  }

  /**
   * Build the debug-only browser-automation surface (window.__unit7.test, aliased
   * as window.__unit7nav). It is installed only inside the same `?debug` / DEV gate
   * that exposes window.__unit7, so production players never get it. Every method
   * routes through the SAME code paths real input/UI use (virtual move/look,
   * pressAction, doTravel, enterMinigame, …) so an agent tests the real game; it
   * just bypasses the browser's pointer-lock gesture requirement. Methods are
   * crash-safe (validate/default args) so poking at them can't wedge a session.
   */
  private installNav() {
    const ACTIONS: GameAction[] = ['sprint', 'jet', 'net', 'enter', 'boost', 'morph', 'chute', 'dance', 'bubble', 'board', 'warp', 'grapple']
    const MINIGAMES: MinigameKind[] = ['beamwars', 'digduel', 'merge2048', 'invaders', 'snake', 'raceloop', 'mecharena', 'drivemad']
    const ZONES: Zone[] = ['earth', 'moon', 'mars']

    const nav = {
      /** Library version, so a script can feature-detect the surface. */
      version: 2,

      /** True once the world is interactive (no intro / launch pad / drop / minigame). */
      ready: () => !this.intro && !this.launchPad && !this.dropIn && !this.inMinigame,

      /**
       * Turn on synthetic-input mode: the player is driven by setMove/setLook/press
       * below instead of the browser's pointer-locked mouse + keyboard, and the
       * auto-pause-on-unlock is suppressed. 'normal' restores real input.
       */
      setInputMode: (mode: 'synthetic' | 'normal') => {
        this.botMode = mode === 'synthetic'
        if (this.botMode) {
          this.input.setLockEnabled(false)
          this.input.exitLock()
          this.setPaused(false)
        } else {
          this.input.setLockEnabled(true)
        }
        return mode
      },

      /** Skip the opening (intro -> launch pad -> skydive) straight to free roam. */
      skip: () => { this.controls.skipIntro(); return nav.state() },

      /** Analog move intent in [-1,1] (camera-relative): y+ forward, x+ strafe right. */
      setMove: (x: number, y: number) => this.input.setVirtualMove(clamp(Number(x) || 0, -1, 1), clamp(Number(y) || 0, -1, 1)),

      /** Nudge the look angles (delta units match the touch look path). */
      setLook: (dx: number, dy: number) => this.input.setVirtualLook(Number(dx) || 0, Number(dy) || 0),

      /** Set the absolute camera yaw/pitch (radians). */
      setYaw: (yaw: number, pitch?: number) => { if (Number.isFinite(yaw)) this.input.yaw = yaw; if (Number.isFinite(pitch as number)) this.input.pitch = pitch as number },

      /** Fire one action (jump=jet, capture=net, enter, board, …). Held actions get
       *  a brief pulse; one-shot actions register a single edge. Unknown = no-op. */
      press: (action: GameAction) => {
        if (!ACTIONS.includes(action)) return false
        this.input.pressAction(action, true)
        const held: GameAction[] = ['sprint', 'jet', 'boost', 'grapple']
        if (held.includes(action)) setTimeout(() => this.input.pressAction(action, false), 120)
        return true
      },

      /** Hold a sustained action (sprint/jet/boost/grapple) for `ms`. */
      hold: (action: GameAction, ms = 500) => {
        if (!ACTIONS.includes(action)) return false
        this.input.pressAction(action, true)
        setTimeout(() => this.input.pressAction(action, false), Math.max(0, Math.min(Number(ms) || 0, 20000)))
        return true
      },

      /** Hard-swap to a zone (instant, no transition fade — deterministic for tests). */
      goto: (zone: Zone) => {
        if (!ZONES.includes(zone)) return { ok: false, error: `unknown zone "${zone}"; try ${ZONES.join('/')}` }
        if (zone !== this.zone) this.doTravel(zone)
        return nav.state()
      },

      /** Teleport to absolute coords on the current zone (Y auto-sampled if omitted). */
      teleport: (x: number, z: number, y?: number) => { this.navTeleport(Number(x), Number(z), y); return nav.state() },

      /** List the named landmarks you can gotoLandmark() on the current zone. */
      landmarks: () => Object.keys(this.navLandmarks()),

      /** Teleport to a named landmark (spawn/arcade/factory/marsPortal/moonPortal/…). */
      gotoLandmark: (name: string) => {
        const lm = this.navLandmarks()[name]
        if (!lm) return { ok: false, error: `unknown landmark "${name}"; try ${Object.keys(this.navLandmarks()).join(', ')}` }
        this.navTeleport(lm.x, lm.z, undefined, lm.yaw)
        return nav.state()
      },

      /** The portals reachable on the current zone, with positions + targets. */
      portals: () => {
        const out: { kind: string; target?: string; x: number; z: number; radius: number }[] = []
        for (const p of this.zones.portalsFor(this.zone)) out.push({ kind: 'zone', target: p.target, x: p.position.x, z: p.position.z, radius: p.radius })
        if (this.zone === 'earth') {
          if (this.plazaMars) out.push({ kind: 'zone', target: 'mars', x: this.plazaMars.pos.x, z: this.plazaMars.pos.z, radius: this.plazaMars.radius })
          for (const a of this.arcadePortals) out.push({ kind: 'minigame', target: a.kind, x: a.pos.x, z: a.pos.z, radius: 2.4 })
        }
        return out
      },

      /** Open a cabinet minigame by id, without needing a portal context. */
      enterMinigame: (id: MinigameKind) => {
        if (!MINIGAMES.includes(id)) return { ok: false, error: `unknown minigame "${id}"; try ${MINIGAMES.join('/')}` }
        if (this.inMinigame) this.exitMinigame()
        const portal = this.arcadePortals.find((a) => a.kind === id)
        const pos = portal ? portal.pos.clone() : new THREE.Vector3(this.player.position.x, this.player.position.y, this.player.position.z)
        this.enterMinigame(id, pos)
        return { ok: true, minigame: id }
      },

      /** Close any open minigame and step the player back out. */
      exitMinigame: () => { this.exitMinigame(); return nav.state() },

      /** Jump the guided objective chain to a step index (clamped). */
      setObjective: (index: number) => { this.missions.debugSetIndex(Number(index) || 0); return { ok: true, index: Number(index) || 0 } },

      /** Trigger / clear the city raid (must be on Earth for it to take effect). */
      startRaid: () => { if (this.zone === 'earth' && !this.raidActive) this.beginCityRaid(this.player.position.clone()); return { ok: this.raidActive } },
      endRaid: () => { if (this.raidActive) this.endCityRaid(); return { ok: !this.raidActive } },

      /** Set the day/night clock (seconds into the 120s cycle). day()/night() helpers. */
      time: (t: number) => { if (Number.isFinite(t)) this.world.setDebugTime(t); return nav.state() },
      day: () => { this.world.setDebugTime(35); return nav.state() },
      night: () => { this.world.setDebugTime(95); return nav.state() },

      pause: () => { this.setPaused(true); return nav.state() },
      resume: () => { this.setPaused(false); return nav.state() },

      /** Live render stats for assertions / perf regressions. */
      metrics: () => {
        const mem = this.engine.renderer.info.memory
        return {
          fps: Math.round(this.engine.fps),
          drawCalls: this.engine.drawCalls,
          triangles: this.engine.triangles,
          renderScale: Number(this.engine.scale.toFixed(3)),
          geometries: mem.geometries,
          textures: mem.textures,
          zone: this.zone,
          raidActive: this.raidActive,
        }
      },

      /** A compact, JSON-safe snapshot of where/what the player is. */
      state: () => {
        const p = this.player.position
        return {
          ready: nav.ready(),
          zone: this.zone,
          pos: { x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)), z: Number(p.z.toFixed(2)) },
          yaw: Number(this.input.yaw.toFixed(3)),
          mode: this.player.mode,
          grounded: this.player.grounded,
          paused: this.paused,
          inMinigame: this.inMinigame,
          minigame: this.hud.minigame,
          raidActive: this.raidActive,
          botMode: this.botMode,
          fps: Math.round(this.engine.fps),
          objective: this.hud.objective,
        }
      },

      /** Prove the engine's fixed-timestep determinism (CLAUDE.md: "same physics
       *  outcome at any frame rate"). Runs an identical scripted input through the
       *  isolated player+physics fixed step TWICE from a byte-identical seed pose
       *  and fingerprints the resulting transform+velocity. `identical:true` means
       *  the sim is reproducible → frame-rate independent: the frame rate only
       *  changes HOW MANY of these identical fixed steps run per rendered frame,
       *  never their result. `hash` is a stable golden a CI test can pin. Restores
       *  all state afterwards (a no-op for the live game). */
      determinism: (steps = 240) => this.proveDeterminism(Math.max(1, Math.min(Number(steps) || 240, 6000))),
    }

    const w = window as unknown as { __unit7nav?: typeof nav; __unit7?: { test?: typeof nav } }
    w.__unit7nav = nav
    if (w.__unit7) w.__unit7.test = nav

    // URL-driven navigation so an agent can drive purely via the address bar:
    //   ?bot              -> (handled at boot) skip the opening, auto-solo
    //   &goto=arcade      -> teleport to a named landmark once ready
    //   &zone=moon        -> travel to a zone once ready
    // Applied after a tick so the world has finished its first build.
    try {
      const q = new URLSearchParams(location.search)
      if (q.has('bot')) nav.setInputMode('synthetic')
      const goZone = q.get('zone')
      const goLm = q.get('goto')
      if ((q.has('bot') || q.has('debug')) && (goZone || goLm)) {
        const apply = () => {
          if (!nav.ready()) { setTimeout(apply, 120); return }
          if (goZone && ZONES.includes(goZone as Zone) && goZone !== 'earth') nav.goto(goZone as Zone)
          if (goLm) nav.gotoLandmark(goLm)
        }
        setTimeout(apply, 200)
      }
    } catch {
      /* no location (SSR / tests) - skip URL nav */
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
    if (this.intro || this.dropIn || this.launchPad || this.inMinigame || this.paused) return
    // Replaying ends the current run; finishDrop re-emits game_start (with the
    // same mode) when control hands back. Restart now replays the playable dive
    // opening (the same one you get on a fresh load), not the old cinematic.
    this.emitGameOver()
    this.gameStarted = false
    this.warpRevert()
    if (this.vehicles.current) this.player.exitVehicle(this.player.position)
    if (this.zone !== 'earth') this.doTravel('earth')
    this.beginLaunchPad() // replay the opening from the launch platform
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
    // Grace period so the Mars gate (z=13, right on the route out from spawn)
    // can't fire on the player's first step before they've read the card.
    this.travelCooldown = 3
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
    // Begin in pre-dawn dark, then run the sunrise at ~0.4x so the whole thing -
    // night lifting to gold, the visible sun cresting, the shift fleet descending
    // and workers filing into the offices - plays out over ~30s instead of being
    // over in a blink. Normal clock speed resumes once it's full day.
    this.world.setDebugTime(4) // just before the 5s..15s dawn ramp
    this.world.setTimeScale(0.4)
    this.morningSunrise = true
    this.dawnShow.resetClock()
    this.hud.banner = 'DAWN OVER THE CITY'
    this.bannerTimer = 3
    this.hud.missionPopup = { title: 'SHIFT CHANGE', body: 'Dawn breaks. Watch the shuttles land and the crew head to work, then follow the neon route to the beam.' }
    this.missionPopupTimer = 7
  }

  /** End the scripted slow sunrise once it's full day, restoring normal clock speed. */
  private updateMorningSunrise() {
    if (!this.morningSunrise) return
    if (this.world.dayFactor >= 0.98) {
      this.world.setTimeScale(1)
      this.morningSunrise = false
    }
  }

  private enterMinigame(kind: MinigameKind, pos: THREE.Vector3) {
    this.inMinigame = true
    // The "played" credit is granted on exit, gated on real engagement time, so
    // the chain objective + daily can't be farmed by tapping in and bouncing out.
    this.warpRevert() // can't carry a warp form into a cabinet game
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
    let playedLongEnough = false
    if (this.hud.minigame) {
      const now = typeof performance !== 'undefined' ? performance.now() : 0
      const duration_seconds = this.minigameStartMs ? Math.round((now - this.minigameStartMs) / 1000) : 0
      playedLongEnough = duration_seconds >= 8
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
    this.player.resetInterp()
    this.arcadeCooldown = 1.5
    this.input.consumePause() // drop any Escape pressed inside the minigame
    this.input.setLockEnabled(true)
    this.camera.snap(this.player.position)
    this.engine.start()
    // A real play (>= 8s) counts toward XP, the chain's arcade objective, and the
    // daily "play" objective. Bouncing straight out earns nothing.
    if (playedLongEnough) {
      this.missions.markMinigamePlayed()
      // Persist the latch so the arcade objective stays satisfied across reloads,
      // even if the player hasn't reached that step of the chain yet.
      saveMissionProgress(this.missions.serialize())
      this.awardXp(15)
      const d = noteDaily('play', 1)
      if (d.completed && d.reward) this.grantDailyReward(d.reward)
    }
    this.refreshProgression()
    this.hudListener({ ...this.hud, radar: this.radar })
    // A minigame may have changed our W/L record; refresh the shared profile.
    this.mp.publishProfile()
  }

  // --- warp ability -----------------------------------------------------------

  /** Open/close the warp picker. Opens when charged or already warped (to switch
   *  / revert); otherwise nudges that it's still charging. */
  private toggleWarp() {
    if (this.warpMenuOpen) { this.warpMenuOpen = false; this.input.requestLock(); return }
    if (this.warpCharge >= Game.WARP_TIME || this.warpActive) {
      this.warpMenuOpen = true
      this.input.exitLock() // free the cursor so the picker is clickable on desktop
      this.audio.play('ui')
    } else {
      this.hud.banner = `WARP CHARGING ${Math.floor((this.warpCharge / Game.WARP_TIME) * 100)}%`
      this.bannerTimer = 1.1
    }
  }

  /** Teleport into a chosen sci-fi form: hide the robot, show the form, apply its
   *  speed, and pop a warp flash. Consumes the charge. */
  private warpInto(id: string) {
    const meta = WARP_FORMS.find((f) => f.id === id)
    if (!meta || !isWarpForm(id)) return
    if (this.warpCharge < Game.WARP_TIME) { this.warpMenuOpen = false; return } // not ready
    this.warpCharge = 0
    this.warpMenuOpen = false
    this.clearWarpModel()
    const m = createWarpForm(id)
    this.warpModel = m
    const p = this.player.position
    m.group.position.set(p.x, p.y + hoverOffset(id), p.z)
    this.engine.scene.add(m.group)
    this.warpActive = id
    this.player.setModelVisible(false)
    this.player.warpSpeedMul = meta.speedMul
    this.missiles.shockwave({ x: p.x, y: p.y + 1, z: p.z }, meta.color, 7, 0.8)
    this.camera.shake(0.8)
    this.audio.play('portal')
    vibrate(45)
    this.hud.banner = `WARPED · ${meta.name}`
    this.bannerTimer = 2
  }

  /** Return to the robot form. */
  private warpRevert() {
    this.warpMenuOpen = false
    if (!this.warpActive) return
    this.clearWarpModel()
    this.warpActive = null
    this.player.warpSpeedMul = 1
    this.player.setModelVisible(true)
    const p = this.player.position
    this.missiles.shockwave({ x: p.x, y: p.y + 1, z: p.z }, 0x27e7ff, 5, 0.6)
    this.audio.play('portal')
  }

  private clearWarpModel() {
    if (this.warpModel) {
      this.engine.scene.remove(this.warpModel.group)
      this.warpModel.dispose()
      this.warpModel = null
    }
  }

  /** Fill the warp charge and keep the active form glued to the player. */
  private updateWarp(dt: number) {
    this.warpCharge = Math.min(Game.WARP_TIME, this.warpCharge + dt)
    if (this.warpActive && this.warpModel) {
      const p = this.player.position
      const grp = this.warpModel.group
      grp.position.set(p.x, p.y + hoverOffset(this.warpActive), p.z)
      grp.rotation.y = this.input.yaw
      this.warpModel.update(dt)
    }
  }

  // --- zone travel ---------------------------------------------------------

  private requestTravel(zone: Zone) {
    if (this.trans.phase !== 'none' || zone === this.zone) return
    this.trans = { phase: 'out', t: 0, target: zone }
    this.travelCooldown = 2
  }

  /** Hard swap of surfaces, atmosphere, visible terrain and spawn for a zone. */
  private doTravel(zone: Zone) {
    this.warpRevert() // drop any warp form on zone change
    // The city raid is an Earth-only event; abandon it on any zone change so its
    // banner + objective don't bleed onto the Moon/Mars.
    if (this.raidActive) this.abortCityRaid()
    if (this.vehicles.current) {
      this.player.exitVehicle(this.player.position)
    }
    this.zones.setActive(zone)
    this.systems.setZone(zone) // collectibles (+ future systems) react to the zone
    this.world.cityVisible(zone === 'earth')
    this.world.applyZone(zone)
    // Retune the final colour grade for the zone: neon-noir on Earth, warm on
    // Mars, near-neutral on the Moon.
    const g = ZONE_GRADE[zone]
    this.engine.setGrade(g.tint, g.tintAmt, g.hi, g.vignette)
    this.worldEvents.setZone(zone)
    this.exploration.setActive(zone)
    this.playground.setActive(zone)
    this.dawnShow.setActive(zone)
    this.robotFactory.setActive(zone === 'earth')
    this.hud.zone = zone

    const env = this.zones.env(zone)
    const spawn = zone === 'earth' ? this.world.spawn : env!.spawn
    const ground = zone === 'earth' ? this.world.groundMeshes : env!.groundMeshes
    const colliders = zone === 'earth' ? this.world.colliders : env!.colliders
    const solids = zone === 'earth' ? this.world.solidMeshes : env!.solidMeshes
    this.physics.setSurfaces(ground, colliders)
    this.camera.setSolids(solids)
    // The blob edge + guide bot belong to the Earth city; hide them off-world
    // (their groups live on the scene, not the swappable world group).
    if (this.boundary) this.boundary.group.visible = zone === 'earth'
    if (this.guide) this.guide.group.visible = zone === 'earth'
    // Activate the matching course only after the zone's terrain is the live
    // physics surface, so its rings build/sample on the right ground.
    this.races.forEach((r) => r.setActive(zone))
    // Mechs follow you off-world (pilot your giant robot on Mars/Moon); the cars
    // stay parked on Earth. Missiles can fire in any zone.
    this.vehicles.setZone(zone, spawn)
    this.missiles.setVisible(true)
    this.npcs.setVisible(zone === 'earth')
    this.events.setVisible(zone === 'earth')
    this.citySpectacle.setVisible(zone === 'earth')
    this.patrols.setVisible(zone === 'earth')
    this.sky.setVisible(zone !== 'moon') // ships fly over Earth and Mars

    this.zone = zone
    // Leaving the city clears any wanted level (no police off-world).
    this.heat = 0
    this.heatCalm = 0
    this.player.exitVehicle(new THREE.Vector3(spawn.x, spawn.y, spawn.z))
    this.player.setVisible(true)
    this.camera.snap(this.player.position)
    this.hud.banner = `ENTERING ${zone.toUpperCase()}`
    this.bannerTimer = 2.6
    this.audio.play('portal')
    if (zone !== 'earth') this.world.pushHeadline(`UNIT 7 PILOT TOUCHES DOWN ON ${zone.toUpperCase()}`)
  }

  private startRocketLaunch(rocket: Vehicle) {
    if (this.launch.active || this.trans.phase !== 'none') return
    trackEvent('vehicle_entered', { type: 'rocket' })
    // Earth -> Moon -> Mars -> Earth, matching the journey out and back.
    const order: Zone[] = ['earth', 'moon', 'mars']
    const next = order[(order.indexOf(this.zone) + 1) % order.length]
    this.launch = { active: true, phase: 'ascend', t: 0, target: next, rocket, land: new THREE.Vector3() }
    this.player.enterVehicle() // hide player; "boards" the rocket
    this.hud.banner = `LAUNCH · ${next.toUpperCase()}`
    this.bannerTimer = 3
    this.audio.play('portal')
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
        this.persist()
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
      this.warpRevert()
      this.vehicles.onEnterRocket?.(v) // vehicle_entered fires in startRocketLaunch
    } else {
      this.warpRevert() // step out of the warp form to pilot
      this.player.enterVehicle()
      this.vehicles.enter(v)
      trackEvent('ability_used', { ability: 'vehicle' }) // G = enter
      trackEvent('vehicle_entered', { type: v.kind })
      // Mech / titan boot-up moment: name banner, camera shake + an energy/steam
      // burst so boarding a giant reads as a powered-up reward.
      if (isMech(v.kind) || v.kind === 'titan') {
        this.hud.banner = `${v.name} ONLINE`
        this.bannerTimer = 1.6
        this.camera.shake(1.0)
        vibrate(40)
        this.audio.play('mechOnline')
        this.spawnMechBoot(v.position)
      }
    }
  }

  /** Grapple arm: a press fires a tendril along your current aim (camera
   *  forward); it extends until it hits a building, then reels you in. Holding the
   *  button re-fires the instant the previous grapple ends, so you can chain
   *  swings immediately; releasing lets go (Player keeps your momentum). */
  private updateGrapple() {
    const held = this.input.held.grapple
    const edge = held && !this.grapplePrev
    // Fire on a fresh press; AND auto-re-fire to CHAIN swings the instant a grapple
    // that HIT a target ends while still held. A miss does NOT auto-re-fire - that
    // machine-guns the tendril into open air every frame (a flickery glitch) - so
    // retrying after a miss needs a fresh press.
    if (held && !this.player.grappling && (edge || this.grappleHit)) {
      const cam = this.engine.camera
      cam.getWorldDirection(this.grappleD) // aim = where you're looking
      // Raycast the aim against buildings (with forward-cone auto-aim) so the
      // grapple grabs what you're looking at instead of firing into open air.
      const top = this.physics.grappleTarget(cam.position, this.grappleD, config.grapple.range, this.grappleO)
      if (top !== null) { this.player.fireGrapple(this.grappleO, top); this.grappleHit = true; this.audio.play('ui') }
      else { this.player.fireGrappleMiss(this.grappleD); this.grappleHit = false; if (edge) this.audio.play('ui') } // don't spam the miss chime
      if (edge) trackEvent('ability_used', { ability: 'grapple' })
    } else if (!held && this.player.grappling) {
      this.player.endGrapple()
    }
    this.grapplePrev = held
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
    if (this.mp.tryClaim(sx, sz, this.scratchFwd.x, this.scratchFwd.z, range, 0.45, bestD)) return

    if (best) {
      const award = best.capture()
      // Chain multiplier for rapid captures, plus a point-blank "close call" bonus.
      const chainMul = this.captureCombo.registerCapture()
      const closeCall = bestD < 4
      const mul = this.scoreMul * chainMul * (closeCall ? 1.5 : 1)
      const gained = Math.round(award * mul)
      this.hud.score += gained
      this.addCredits(Math.round(award * 0.5 * chainMul * (closeCall ? 1.5 : 1)))
      this.hud.captured += 1
      trackEvent('npc_captured', { total: this.hud.captured })
      // Juice: a quick cyan ring pop + micro freeze-frame where the target netted.
      this.missiles.shockwave({ x: best.position.x, y: best.position.y, z: best.position.z }, 0x27e7ff, 3, 0.4)
      this.popups.pop(best.position.x, best.position.y + 1.6, best.position.z, `+${gained}`, chainMul > 1 ? '#ffd24a' : '#27e7ff')
      this.engine.triggerHitstop(0.035)
      vibrate(25)
      this.audio.play('capture')
      // Point-blank net refunds a little stamina — rewards taking the risk.
      if (closeCall) this.player.stamina = Math.min(config.player.staminaMax, this.player.stamina + 25)
      // Brief feedback only when it's noteworthy (a chain or a close call).
      if (closeCall || chainMul > 1) {
        this.hud.banner = `${closeCall ? 'CLOSE CALL  ' : ''}${chainMul > 1 ? `CHAIN ×${chainMul.toFixed(1)}  ` : ''}+${gained}`
        this.bannerTimer = 1.1
      }
      this.awardCaptureProgress(1)
      // Let everyone else see the capture happen.
      this.mp.broadcastCapture([best.position.x, best.position.y, best.position.z], award)
    }
  }

  /**
   * Mech weapon: fire a pair of missiles forward from the shoulder pods. Muzzle
   * height + spread scale with the mech's size. Detonation damage is applied in
   * `detonate` when each missile lands.
   */
  private fireMissiles() {
    const v = this.vehicles.current
    if (!v || !isWalker(v.kind)) return // mechs + the free-to-pilot titans
    if (this.missileCooldown > 0) return
    this.missileCooldown = 0.45
    const size = v.size
    this.scratchFwd.set(Math.sin(v.yaw), 0, Math.cos(v.yaw))
    const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw) // camera-right on the ground
    const muzzleY = v.position.y + 4.0 * size
    // Lob the arc with where you're looking: tilt the camera up to throw missiles
    // long onto a far cluster, level/down to fire flat at something close. Uses the
    // camera's world-forward Y (same "aim" the grapple reads), so it's sign-correct
    // without touching the pitch rig. fire() normalizes dir, so Y only sets angle.
    this.engine.camera.getWorldDirection(this.grappleD)
    const lobY = clamp(0.12 + this.grappleD.y * 0.9, -0.3, 1.0)
    // fire() copies origin + clones dir, so reusing these scratch vectors is safe.
    for (const sx of [-1.3, 1.3]) {
      this.grappleO.set(
        v.position.x + rx * sx * size + this.scratchFwd.x * 1.2 * size,
        muzzleY,
        v.position.z + rz * sx * size + this.scratchFwd.z * 1.2 * size,
      )
      this.grappleD.set(this.scratchFwd.x, lobY, this.scratchFwd.z)
      this.missiles.fire(this.grappleO, this.grappleD, 80, 2.8)
    }
    this.hud.banner = 'MISSILES AWAY'
    this.bannerTimer = 0.8
    this.audio.play('fire')
    this.addHeat(config.heat.perMissile) // discharging ordnance in the city draws the law
  }

  /** Per-frame wanted-level bookkeeping (Earth only): tick the bust-immunity
   *  window, accrue heat for reckless high-speed driving, then bleed heat off once
   *  the player has laid low for `decayDelay`. The pursuit AI + bust detection
   *  itself lives in Events.updatePolice, reading the level passed to events.update. */
  private updateHeat(dt: number) {
    if (this.bustImmunity > 0) this.bustImmunity = Math.max(0, this.bustImmunity - dt)
    const v = this.vehicles.current
    const reckless = !!v && (v.kind === 'hovercar' || v.kind === 'speeder') && this.vehicles.currentSpeed > config.heat.recklessSpeed
    if (reckless) this.addHeat(config.heat.recklessPerSec * dt)
    this.heatCalm += dt
    if (this.heatCalm > config.heat.decayDelay && this.heat > 0) {
      this.heat = Math.max(0, this.heat - config.heat.decayPerSec * dt)
    }
  }

  /** Raise the wanted level and reset the cool-down clock. Earth-only crimes call
   *  this; it's clamped to the star cap. */
  private addHeat(n: number) {
    if (this.zone !== 'earth') return
    this.heat = Math.min(config.heat.max, this.heat + n)
    this.heatCalm = 0
  }

  /** Police caught you: a credit fine + a jolt of feedback, then the heat clears.
   *  Deliberately not a game-over — stakes without a hard fail (matches the
   *  sandbox's no-death ethos). A short immunity window prevents instant re-bust. */
  private onBusted() {
    if (this.bustImmunity > 0) return
    const fine = Math.min(this.credits, config.heat.bustCredits)
    if (fine > 0) this.addCredits(-fine)
    this.heat = 0
    this.heatCalm = 0
    this.bustImmunity = config.heat.bustImmunity
    this.scoreMul = 1 // a bust breaks any running score multiplier
    this.hud.banner = fine > 0 ? `BUSTED · -${fine}c` : 'BUSTED'
    this.bannerTimer = 1.6
    this.engine.triggerHitstop(0.12)
    this.camera.shake(0.6)
    this.audio.play('soak')
    vibrate(120)
    trackEvent('player_busted', { fine })
  }

  private addCredits(n: number) {
    this.credits += n
    this.profile.credits = this.credits
    this.hud.credits = this.credits
  }

  private isUnlocked(kind: string): boolean {
    return !MECH_COST[kind] || this.unlocked.has(kind)
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
      this.engine.triggerHitstop(0.07) // STOMP weight: a heavier freeze than a capture
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
    let rawAward = 0
    for (const c of this.capturables) {
      if (!c.alive) continue
      const dx = c.position.x - pos.x
      const dz = c.position.z - pos.z
      if (dx * dx + dz * dz > r2) continue
      rawAward += c.capture()
      this.hud.captured += 1
      hits++
    }
    if (hits > 0) {
      // One chain tick per blast; the multiplier scales the whole payout.
      const mul = this.scoreMul * this.captureCombo.registerCapture()
      const gained = Math.round(rawAward * mul)
      this.hud.score += gained
      this.addCredits(Math.round(rawAward * 0.5 * mul))
      this.popups.pop(pos.x, pos.y + 2, pos.z, `+${gained}${hits > 1 ? ` ×${hits}` : ''}`, '#ffb24a')
      vibrate(40)
      this.awardCaptureProgress(hits)
      // One event per blast (not per target) so a big missile hit can't spam GA.
      trackEvent('npc_captured', { total: this.hud.captured })
    }
    // A blast that reaches the mothership's exposed core damages it.
    if (this.raidActive) {
      const wp = this.events.bossWeakPoint()
      if (wp) {
        const dx = wp.x - pos.x, dy = wp.y - pos.y, dz = wp.z - pos.z
        if (dx * dx + dy * dy + dz * dz < (radius + 5) * (radius + 5)) this.events.damageBoss(1)
      }
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
    const rocket = this.launch.rocket
    const cam = this.engine.camera
    const smooth = (x: number) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t) }

    if (this.launch.phase === 'ascend') {
      if (rocket) {
        rocket.position.y += (4 + this.launch.t * this.launch.t * 9) * dt
        rocket.model.group.position.copy(rocket.position)
        rocket.model.update(dt, 1)
        cam.position.set(rocket.position.x + 16, rocket.position.y + 5, rocket.position.z + 16)
        cam.lookAt(rocket.position.x, rocket.position.y + 2, rocket.position.z)
        this.focus.copy(rocket.position)
      }
      this.hud.fade = Math.max(0, (this.launch.t - 1.5) / 0.6)
      this.world.update(dt, this.focus)
      if (this.launch.t > 2.1) {
        // Arrive: swap worlds, then re-board so the rocket self-lands on the pad.
        this.doTravel(this.launch.target)
        this.player.enterVehicle()
        this.launch.phase = 'descend'
        this.launch.t = 0
        const sp = this.safeSpawn()
        this.launch.land.set(sp.x + 8, this.physics.sampleGround(sp.x + 8, sp.z + 6, 200)?.y ?? sp.y, sp.z + 6)
        if (rocket) {
          rocket.position.set(this.launch.land.x, this.launch.land.y + 95, this.launch.land.z)
          rocket.model.group.position.copy(rocket.position)
          rocket.yaw = 0
          rocket.model.group.rotation.set(0, 0, 0)
        }
        this.hud.fade = 1
      }
    } else {
      // Descend: retro-burn down onto the pad (SpaceX-style final landing burn).
      const k = smooth(Math.min(1, this.launch.t / 3))
      if (rocket) {
        const ease = 1 - (1 - k) * (1 - k) // decelerate into the pad
        rocket.position.y = THREE.MathUtils.lerp(this.launch.land.y + 95, this.launch.land.y, ease)
        rocket.model.group.position.copy(rocket.position)
        rocket.model.update(dt, 1 - k) // throttle eases off as it settles
        cam.position.set(rocket.position.x + 18, this.launch.land.y + 10 + (rocket.position.y - this.launch.land.y) * 0.3, rocket.position.z + 18)
        cam.lookAt(rocket.position.x, rocket.position.y + 4, rocket.position.z)
        this.focus.copy(rocket.position)
      }
      this.hud.fade = Math.max(0, 1 - this.launch.t / 0.6) // fade in on the new world
      this.world.update(dt, this.focus)
      if (this.launch.t > 3.2) {
        if (rocket) {
          rocket.position.y = this.launch.land.y
          rocket.model.group.position.copy(rocket.position)
          rocket.home.copy(rocket.position) // park where it landed
        }
        const sp = this.safeSpawn()
        this.player.exitVehicle(sp)
        this.player.setVisible(true)
        this.camera.snap(this.player.position)
        this.launch.active = false
        this.launch.rocket = null
        this.hud.banner = `ARRIVED · ${this.launch.target.toUpperCase()}`
        this.bannerTimer = 2.4
        this.audio.play('land')
      }
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
        return
      }
    }
    // The central plaza hero ring is the Earth->Mars gateway.
    if (this.zone === 'earth' && this.plazaMars && Math.hypot(px - this.plazaMars.pos.x, pz - this.plazaMars.pos.z) < this.plazaMars.radius) {
      this.requestTravel('mars')
    }
  }

  /**
   * Join the shared world under a username. Safe to call once after start();
   * the game keeps running single-player until/if the connection succeeds, and
   * silently reconnects if the server drops. Remote players appear as tinted
   * robots with name tags.
   */
  connectMultiplayer(username: string, host?: string) {
    if (this.mp.connected) return // already connected/connecting
    this.emitGameStart('multiplayer')
    this.mp.connect(username, host)
  }

  /**
   * Wire the anonymous cloud save. Called by the shell right after construction
   * with the resolved multiplayer host. With a host we get a CloudStore (HTTP
   * transport); with none we get a LocalStore so solo / offline play is unchanged.
   *
   * localStorage remains the source of truth: we seed the cloud envelope from the
   * existing on-device blobs (so a returning player's progress is uploaded, not
   * overwritten by an empty cloud), then kick a sync that reconciles with whatever
   * the cloud already holds via the never-lose merge.
   */
  attachSave(host?: string) {
    this.saveStore = createStore(host ? httpSaveTransport(host) : undefined)
    // Fold current on-device progress into the envelope so the first sync uploads
    // it. MissionSystem.serialize() is the live source for mission idx; fall back
    // to the persisted blob if it isn't available.
    this.saveStore.patch({
      profile: loadProfile(),
      progression: loadProgression(),
      stats: loadStats(),
      missions: this.missions?.serialize?.() ?? loadMissionProgress(),
      callsign: loadCallsign(),
    })
    void this.saveStore.sync()
    // Cache the parental chat flag once the save layer is up.
    this.chatEnabled = isChatEnabled()
    this.hud.chatEnabled = this.chatEnabled
  }

  /**
   * Snapshot every save family into one store patch. Called wherever we used to
   * call saveProfile(this.profile): local persistence is unchanged (we still write
   * the profile blob directly), and the cloud envelope is updated alongside it.
   * The store debounces the actual upload, so calling this on every progress event
   * is cheap and allocation-light.
   */
  private persist() {
    // Local write-through first: localStorage stays the source of truth.
    saveProfile(this.profile)
    this.saveStore?.patch({
      profile: this.profile,
      progression: loadProgression(),
      stats: loadStats(),
      missions: this.missions?.serialize?.() ?? loadMissionProgress(),
      callsign: loadCallsign(),
    })
  }

  /**
   * A chat line arrived from the net. RECEIVE GATE: a kid whose parent has chat
   * disabled never sees other players' lines, even if the room relays them.
   */
  private onNetChat(m: ChatMessage) {
    if (!this.chatEnabled) return
    this.chatSink?.(m)
  }

  /** The callback surface the MultiplayerManager uses to read player state and
   *  push rewards/HUD/audio back into the game, keeping the net glue out of Game. */
  private multiplayerHost(): MultiplayerHost {
    return {
      netState: () => this.buildNetState(),
      selfIdentity: () => ({
        aliens: this.profile.lifetimeCaptured + this.hud.captured,
        level: levelForXp(this.progression.xp),
        rating: this.progression.duelRating,
        badges: this.progression.achievements.length,
        accent: cosmeticById(this.progression.cosmetics.accent).color,
      }),
      callsign: () => loadStats().callsign,
      joinSeed: () => ({ x: this.player.position.x, z: this.player.position.z }),
      zone: () => this.zone,
      banner: (text, secs = 2) => { this.hud.banner = text; this.bannerTimer = secs },
      play: (sfx) => this.audio.play(sfx),
      shockwave: (pos, color, r, dur) => this.missiles.shockwave(pos, color, r, dur),
      applyConfirmedClaim: (award) => {
        const mul = this.captureCombo.registerCapture() // chains across shared captures too
        this.hud.score += Math.round(award * mul)
        this.hud.captured += 1
        trackEvent('npc_captured', { total: this.hud.captured })
        this.addCredits(Math.round(award * 0.5 * mul))
        vibrate(25)
        this.audio.play('capture')
      },
      warpRevert: () => this.warpRevert(),
      setInputLock: (enabled) => this.input.setLockEnabled(enabled),
      consumePause: () => this.input.consumePause(),
      awardXp: (amount) => this.awardXp(amount),
      grantDailyReward: (reward) => this.grantDailyReward(reward),
      refreshProgression: () => this.refreshProgression(),
      onChat: (m) => this.onNetChat(m),
    }
  }

  // --- progression / gamification ---------------------------------------------

  /** Refresh the cached progression snapshot and mark the HUD roster dirty. */
  /** Merge the player into the (already sorted, descending) bot rows, top 10,
   *  into the reused `soloLb` array - reusing row objects so steady state is
   *  allocation-free. */
  private buildSoloLeaderboard(botRows: { name: string; score: number }[]) {
    const lb = this.soloLb
    const set = (i: number, name: string, score: number) => {
      if (lb[i]) { lb[i].name = name; lb[i].score = score }
      else lb[i] = { name, score }
    }
    let n = 0
    let inserted = false
    for (let i = 0; i < botRows.length && n < 10; i++) {
      if (!inserted && this.hud.score >= botRows[i].score) {
        set(n++, this.soloName, this.hud.score)
        inserted = true
        if (n >= 10) break
      }
      set(n++, botRows[i].name, botRows[i].score)
    }
    if (!inserted && n < 10) set(n++, this.soloName, this.hud.score)
    lb.length = n
  }

  private refreshProgression() {
    this.progression = loadProgression()
    this.mp.markProfileDirty()
    this.checkAchievements()
  }

  /** Evaluate achievements against the current state; toast any newly unlocked. */
  private checkAchievements() {
    const stats = loadStats()
    const gamesPlayed = Object.values(stats.games).filter((g) => g.played > 0).length
    const newly = evaluateAchievements({
      level: levelForXp(this.progression.xp),
      captures: this.profile.lifetimeCaptured + this.hud.captured,
      duelWins: this.progression.duelWins,
      bestDuelStreak: this.progression.bestDuelStreak,
      duelRating: this.progression.duelRating,
      loginStreak: this.progression.streak,
      gamesPlayed,
      colorsOwned: this.progression.cosmetics.owned.length,
      dailyCompleted: this.progression.daily.claimed,
      shardsFound: this.profile.shardsFound,
      motherships: this.profile.motherships,
      zonesArchived: this.profile.zonesArchived.length,
    })
    if (newly.length) {
      this.progression = loadProgression() // pick up the newly persisted ids
      this.hud.banner = `★ ${newly[0].name.toUpperCase()}`
      this.bannerTimer = 2.8
      this.audio.play('objective')
      vibrate(50)
    }
  }

  /** Banner + sting when a level boundary is crossed. */
  private flashLevelUp(level: number) {
    this.hud.banner = `PILOT LV ${level}`
    this.bannerTimer = 2.2
    this.audio.play('objective')
    vibrate(60)
  }

  /** Grant the daily-objective reward (credits + the XP was already added). */
  private grantDailyReward(reward: { credits: number; xp: number }) {
    this.addCredits(reward.credits)
    this.hud.banner = `DAILY DONE  +${reward.credits}c`
    this.bannerTimer = 2.6
    this.audio.play('objective')
    vibrate(50)
  }

  /** Award XP (with level-up feedback) and refresh the cached snapshot. */
  private awardXp(amount: number) {
    const r = addXp(amount)
    if (r.leveledUp) this.flashLevelUp(r.level)
    this.refreshProgression()
  }

  /** A data shard was collected: pay out, persist the lifetime count, juice it. */
  private onShardCollected(value: number, x: number, y: number, z: number) {
    this.addCredits(value)
    this.profile.shardsFound += 1
    this.persist()
    const c = this.collectibles.counts()
    this.hud.banner = `DATA SHARD  ${c.found}/${c.total}  +${value}c`
    this.bannerTimer = 1.4
    this.audio.play('capture')
    this.missiles.shockwave({ x, y, z }, 0x8a5cff, 2.2, 0.35)
    this.popups.pop(x, y + 1.2, z, `+${value}c`, '#bfa8ff')
    this.fxPool.puff(x, y, z, { color: 0xbfa8ff, count: 4, spread: 0.8, rise: 2.2, ttl: 0.7, scale: 0.5, opacity: 0.6, additive: true })
    vibrate(12)
    this.awardXp(4) // also refreshes progression -> re-checks shard achievements
    // Clearing every shard in a zone pays a completion bonus + a fanfare. Fires
    // once per field (shards never un-collect), so no need to latch it.
    if (c.total > 0 && c.found === c.total) this.onZoneShardsComplete()
  }

  /** All shards in the current zone collected: bonus credits/XP + a fanfare. */
  private onZoneShardsComplete() {
    const bonus = this.zone === 'earth' ? 500 : 350
    const xp = this.zone === 'earth' ? 200 : 140
    this.addCredits(bonus)
    this.awardXp(xp)
    const where = this.zone === 'earth' ? 'THE CITY' : this.zone.toUpperCase()
    this.hud.banner = `ALL SHARDS — ${where} CLEARED  +${bonus}c`
    this.bannerTimer = 3.5
    this.hud.missionPopup = { title: 'ARCHIVE COMPLETE', body: `Every data shard on ${where.toLowerCase()} recovered. +${bonus} credits, +${xp} XP. Nice sweep, Unit 7.` }
    this.missionPopupTimer = 5
    this.camera.shake(0.6)
    this.audio.play('objective')
    vibrate(80)
    if (!this.profile.zonesArchived.includes(this.zone)) {
      this.profile.zonesArchived.push(this.zone)
      this.persist()
    }
    this.refreshProgression() // unlock Sweep / Completionist
  }

  /** A style combo banked: pay out credits + XP and flash the multiplier. */
  private onStyleBank(credits: number, xp: number, mult: number, _points: number) {
    this.addCredits(credits)
    this.awardXp(xp)
    this.hud.banner = `STYLE x${mult.toFixed(1)}  +${credits}c`
    this.bannerTimer = 1.8
    this.audio.play('objective')
    vibrate(20)
  }

  /** One capture's worth of progress: XP + daily objective. */
  private awardCaptureProgress(n = 1) {
    this.awardXp(5 * n)
    const d = noteDaily('capture', n)
    if (d.completed && d.reward) this.grantDailyReward(d.reward)
    this.refreshProgression()
  }

  /** Equipped trail color (hex int) for duels; defaults to cyan. */
  private equippedTrailColor(): number {
    return cosmeticById(this.progression.cosmetics.trail).color
  }

  /** Buy a cosmetic with credits, then auto-equip it (trail by default). */
  private buyCosmetic(id: string) {
    const c = cosmeticById(id)
    if (this.progression.cosmetics.owned.includes(id)) return // already owned
    if (this.credits < c.cost) {
      this.hud.banner = 'NOT ENOUGH CREDITS'
      this.bannerTimer = 1.8
      this.audio.play('ui')
      return
    }
    this.addCredits(-c.cost)
    ownCosmetic(id)
    equipCosmeticStore('trail', id)
    equipCosmeticStore('accent', id)
    this.refreshProgression()
    this.applyAccentCosmetic()
    this.hud.banner = `UNLOCKED ${c.name.toUpperCase()}`
    this.bannerTimer = 2
    this.audio.play('objective')
    vibrate(40)
  }

  private equipCosmetic(slot: 'trail' | 'accent', id: string) {
    equipCosmeticStore(slot, id)
    this.refreshProgression()
    if (slot === 'accent') this.applyAccentCosmetic()
  }

  /** Recolor the local robot avatar to the equipped accent cosmetic. */
  private applyAccentCosmetic() {
    const color = cosmeticById(this.progression.cosmetics.accent).color
    this.player.setAccent(color)
  }

  /** Snapshot the gamification state for the HUD (level/streak/daily/rank/cosmetics). */
  private buildProgressHud(): ProgressHud {
    const p = this.progression
    const li = levelInfo(p.xp)
    const tier = tierForRating(p.duelRating)
    return {
      level: li.level,
      xpInto: li.into,
      xpSpan: li.span,
      streak: p.streak,
      daily: { kind: p.daily.kind, target: p.daily.target, progress: p.daily.progress, claimed: p.daily.claimed },
      duelRating: p.duelRating,
      duelTier: tier.name,
      duelTierColor: tier.color,
      duelStreak: p.duelStreak,
      credits: this.credits,
      badges: p.achievements.length,
      achievements: [...p.achievements],
      cosmetics: { trail: p.cosmetics.trail, accent: p.cosmetics.accent, owned: [...p.cosmetics.owned] },
    }
  }

  /**
   * Mech boot-up burst: layered energy shockwave rings + rising steam puffs at
   * the mech's feet. Tier-scaled puff count; puffs fade and self-dispose.
   */
  private spawnMechBoot(pos: THREE.Vector3) {
    this.missiles.shockwave({ x: pos.x, y: pos.y + 0.4, z: pos.z }, 0x27e7ff, 7, 0.7)
    this.missiles.shockwave({ x: pos.x, y: pos.y + 0.4, z: pos.z }, 0xff8a1e, 11, 0.95)
    // Rising steam puffs from the pool (no per-spawn material allocation).
    this.fxPool.puff(pos.x, pos.y + 0.6, pos.z, {
      color: 0xcfe6ff,
      count: Math.round(6 * config.tier.fxScale) + 3,
      spread: 3.5,
      rise: 3.2,
      ttl: 1.4,
      scale: 1.9,
      opacity: 0.5,
    })
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

  /** Build the local player's transform for the network broadcast (the manager
   *  throttles + sends it). */
  private buildNetState(): NetState {
    const v = this.vehicles.current
    return {
      p: [this.player.position.x, this.player.position.y, this.player.position.z],
      y: this.input.yaw,
      m: this.player.mode,
      v: v ? v.kind : null,
      z: this.zone,
      s: clamp(this.hud.speed / 30, 0, 1),
      g: this.hud.altitude < 1.2,
    }
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

    // Interactive drop-in owns the camera until you land / skip. The city lives
    // and the sky brightens beneath you during the descent.
    if (this.dropIn) {
      this.dropIn.update(dt)
      // Riding a vehicle down: G bails you out (drop the car, keep skydiving on foot).
      if (this.dropVehicle && this.dropIn.riding && this.input.consumeEdge('enter')) {
        this.dropIn.bail()
        const v = this.dropVehicle
        v.position.copy(v.home); v.velocity.set(0, 0, 0); v.model.group.position.copy(v.home)
        this.vehicles.current = null
        this.dropVehicle = null
        // DropIn's own diver robot is shown by bail(); the player robot stays hidden
        // for the rest of the dive, same as any skydive.
        this.hud.banner = 'BAILED OUT'
        this.bannerTimer = 1.6
        this.audio.play('ui')
        vibrate(30)
      }
      this.world.update(dt, this.world.spawn)
      this.dawnShow.update(dt, this.world.dayFactor)
      this.updateMorningSunrise()
      this.hud.fade = this.dropIn.fade
      const d = this.dropIn.hud
      this.hud.drop = { alt: Math.round(d.alt), speed: Math.round(d.speed), phase: d.phase, hint: d.hint, canDeploy: d.canDeploy, canTrick: d.canTrick, result: d.result, place: d.place, boomCharge: d.boomCharge, combo: d.combo, comboFade: d.comboFade, showJetTip: d.showJetTip, danger: d.danger }
      if (this.dropIn.done) this.finishDrop()
      this.pushHud(dt)
      return
    }

    // Factory intro cinematic owns the camera until it finishes / is skipped.
    if (this.intro) {
      this.intro.update(dt)
      this.world.update(dt, this.introFocus)
      this.hud.fade = this.intro.fade // cinematic drives the black overlay
      if (this.intro.done) this.finishIntro()
      this.pushHud(dt)
      return
    }

    // A live duel owns the screen (overlay UI); freeze the city cheaply behind it.
    if (this.mp.inMatch) {
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
    this.cannonCd = Math.max(0, this.cannonCd - dt)
    this.updateMorningSunrise()
    this.updateWarp(dt)
    this.playClock += dt
    if (this.input.consumeEdge('warp')) this.toggleWarp()

    if (this.launch.active) {
      this.updateLaunch(dt)
      this.pushHud(dt)
      return
    }
    if (this.trans.phase !== 'none') this.updateTransition(dt)

    // Launch pad: you stand on the floating factory and walk/jump off the ledge to
    // start the dive. The player runs the normal on-foot update (below); here we
    // just animate the pad and hand off to the skydive once you're over the edge.
    if (this.launchPad) {
      this.launchPad.update(dt, this.player.position.x, this.player.position.z)
      const p = this.player.position
      // On foot: walk off the ledge -> normal skydive. (Driving off in a vehicle is
      // handled after vehicles.update, below, so the car becomes the diver.)
      if (!this.vehicles.current && this.launchPad.steppedOff(p.x, p.y, p.z)) {
        const off = p.clone()
        this.endLaunchPad()
        this.beginDropIn(off, true) // dive begins where you stepped off, camera eases in
        this.pushHud(dt)
        return
      }
    }

    const onEarth = this.zone === 'earth'
    const piloting = !!this.vehicles.current

    // Held abilities (jetpack / boost) report on the rising edge only.
    this.trackHeldAbilities(piloting)

    if (this.input.consumeEdge('enter')) this.handleEnterExit()
    if (!piloting) {
      if (this.input.consumeEdge('morph')) { this.player.toggleMorph(); trackEvent('ability_used', { ability: 'morph' }) }
      // Parachute: deploy when airborne, or CUT it if it's already out (drop back
      // into free-fall - you can jetpack or re-deploy).
      if (this.input.consumeEdge('chute')) {
        if (this.player.mode === 'parachute') this.player.cutChute()
        else if (this.player.deployChute()) trackEvent('ability_used', { ability: 'parachute' })
      }
      // Pressing jetpack under canopy also cuts it and resumes flight (intuitive).
      if (this.player.mode === 'parachute' && this.input.held.jet) this.player.cutChute()
      if (this.input.consumeEdge('net')) this.fireNet()
      // Grapple arm: hold to fire toward where you aim and zip in; release to let go.
      this.updateGrapple()
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
      // In a mech or titan, CAPTURE / FIRE launches missiles.
      if (this.input.consumeEdge('net')) {
        if (this.vehicles.current && isWalker(this.vehicles.current.kind)) this.fireMissiles()
      }
    }

    this.missileCooldown = Math.max(0, this.missileCooldown - dt)
    const gravity = config.zones[this.zone].gravity
    // Vehicles update in every zone now (mechs are pilotable off-world); gravity
    // feeds the rover's ramp launches (weaker off-world = bigger hops).
    this.vehicles.update(dt, this.input, gravity, this.player.position)

    // Drove a vehicle off the launch-pad edge: the car becomes the diver and falls.
    if (this.launchPad && this.vehicles.current) {
      const v = this.vehicles.current
      const c = this.launchPad.group.position
      if (Math.hypot(v.position.x - c.x, v.position.z - c.z) > this.launchPad.radius - 1) {
        // Undo any ground-snap toward the city far below; start the dive from pad height.
        v.position.y = this.launchPad.topY + v.hoverHeight
        v.model.group.position.copy(v.position)
        this.beginVehicleDrop(v.position.clone())
        this.pushHud(dt)
        return
      }
    }

    if (this.vehicles.current) {
      // Keep vehicles inside the same blob ring (no launch - a fling makes no sense
      // when piloting) and keep the blobs jiggling while you drive near the rim.
      // Not while up on the launch pad - there the edge is the whole point.
      if (this.zone === 'earth' && !this.launchPad) {
        const b = this.boundary.update(dt, this.vehicles.current.position.x, this.vehicles.current.position.z, false)
        if (b) {
          this.vehicles.current.position.x = b.x; this.vehicles.current.position.z = b.z
          // Re-sync the visible mesh too (Vehicles.update already copied the
          // pre-clamp position to it) so the mech doesn't poke past the rim a frame.
          this.vehicles.current.model.group.position.copy(this.vehicles.current.position)
        }
      }
      this.player.object.position.copy(this.vehicles.current.position)
      this.focus.copy(this.vehicles.current.position)
      // Frame the mech around its torso rather than its feet.
      if (isMech(this.vehicles.current.kind)) {
        this.focus.y += this.vehicles.current.size * 3.2
        this.updateMechFx(dt)
      }
    } else {
      this.mechAirborne = false
      // Low-G bubbles scale the player's gravity down locally (floaty triple-hops).
      const pg = gravity * this.playground.lowGFactor(this.zone, this.player.position.x, this.player.position.y, this.player.position.z)
      this.player.update(dt, this.input, this.physics, pg)
      if (this.zone === 'earth' && !this.launchPad) {
        // Bouncy alien-blob edge (replaces the old hard square clamp on Earth): it
        // shoves you back inside the ring and, on foot/flying, flings you up and
        // back toward the arcade. Height-independent, so you can't jetpack over it.
        const canLaunch = this.player.mode === 'robot' || this.player.mode === 'plane'
        const b = this.boundary.update(dt, this.player.position.x, this.player.position.z, canLaunch)
        if (b) {
          this.player.position.x = b.x
          this.player.position.z = b.z
          // Re-anchor render interp to the clamped spot, else the next sim step
          // restores object.position from the pre-clamp rTrue and the player walks
          // straight through the edge (the old square clamp leaned on the y<120
          // physics walls; this must hold at any height to stop the jetpack fly-off).
          this.player.resetInterp()
          if (b.launch) {
            this.player.launchVec(b.vx, b.vy, b.vz)
            this.audio.play('portal'); this.camera.shake(0.6)
            this.hud.banner = 'BOING!'; this.bannerTimer = 0.9; vibrate(30)
          }
        }
      } else {
        const lim = config.world.half - 1
        this.player.position.x = clamp(this.player.position.x, -lim, lim)
        this.player.position.z = clamp(this.player.position.z, -lim, lim)
      }
      this.focus.copy(this.player.position)
      this.checkRecovery(dt)
      // Robot dance: first B press starts move 0; each additional press cycles combos.
      // Moving fast auto-stops so you're not locked in while trying to run.
      if (this.input.consumeEdge('dance')) {
        if (!this.danceToggle) {
          this.danceToggle = true
          this.player.startDance()
        } else {
          this.player.advanceDanceMove()
        }
      }
      if (this.danceToggle && Math.hypot(this.player.velocity.x, this.player.velocity.z) > 4) this.danceToggle = false
      const onFloor = this.playground.onDanceFloor(this.zone, this.player.position.x, this.player.position.z)
      this.player.setDancing(this.danceToggle || onFloor)
      // Hover skateboard (C / BOARD) and bubble gun (V / BUBBLE).
      if (this.input.consumeEdge('board')) this.player.setBoard(!this.player.boarding)
      if (this.input.consumeEdge('bubble')) this.fireBubble()
      // Trampoline bounce pads fling you skyward.
      if (this.player.grounded) {
        const s = this.playground.bouncePadAt(this.zone, this.player.position.x, this.player.position.z)
        if (s > 0) { this.player.launch(s); this.audio.play('portal'); vibrate(20) }
        // Launch cannons: a one-shot fling on a fixed arc (cooldown = fires once).
        if (this.cannonCd <= 0) {
          const v = this.playground.cannonAt(this.zone, this.player.position.x, this.player.position.z)
          if (v) {
            this.player.launchVec(v.x, v.y, v.z)
            this.cannonCd = 1.4
            this.audio.play('portal')
            this.hud.banner = 'LAUNCH!'
            this.bannerTimer = 1.0
            vibrate(35)
          }
        }
      }
      // Updraft columns: ride the rising air upward (works grounded or airborne).
      const lift = this.playground.updraftAt(this.zone, this.player.position.x, this.player.position.y, this.player.position.z)
      if (lift > 0) this.player.rideUpdraft(lift * dt)
      // Mars dust devils double as updrafts: ride one up to the floating ore.
      if (this.zone === 'mars') {
        const dl = this.dustDevils.liftAt(this.player.position.x, this.player.position.y, this.player.position.z)
        if (dl > 0) { this.player.rideUpdraft(dl * dt); this.camera.shake(0.04) }
      }
      if (this.trans.phase === 'none' && this.travelCooldown === 0) this.checkPortals()
    }

    // Let the peaceful morning - sunrise, shuttle arrival, the crew filing into
    // the offices - fully play out before the aliens invade (once). In
    // multiplayer the shared server swarm is the content, so it's suppressed.
    if (onEarth && !this.mp.connected && !this.invasionTriggered && !this.morningSunrise && this.playClock > 45 && this.world.dayFactor >= 0.96) {
      this.invasionTriggered = true
      this.events.startInvasion(this.player.position)
      this.hud.banner = 'ALIEN INVASION'
      this.bannerTimer = 2.4
    }

    // Hero fill light trails the subject so the robot/mech stays readable. On
    // Earth, dim it and warm it toward day so it doesn't fight the noon sun with
    // an unmotivated blue pool; off-world it stays the bright cool fill.
    this.heroLight.position.set(this.focus.x + 2, this.focus.y + 6, this.focus.z + 2)
    if (onEarth) {
      const df = this.world.dayFactor
      this.heroLight.intensity = lerp(22, 7, df)
      this.heroLight.color.setHex(0x9fd8ff).lerp(HERO_DAY_COLOR, df)
    } else if (this.heroLight.intensity !== 22) {
      this.heroLight.intensity = 22
      this.heroLight.color.setHex(0x9fd8ff)
    }
    this.hud.objective = this.launchPad ? 'Step off the edge to skydive' : this.raidActive ? this.raidObjective() : this.missions.update({
      zone: this.zone,
      playerPos: this.player.position,
      captured: this.hud.captured,
      currentVehicle: this.vehicles.current,
      vehicles: this.vehicles.list,
      isUnlocked: (k) => this.isUnlocked(k),
      earthPortals: this.zones.portalsFor('earth'),
      arcadePortals: this.arcadePortals,
      nearestAlien: (x, z) => this.nearestCapturable(x, z),
      groundY: (x, z) => this.physics.sampleGround(x, z, 80)?.y ?? 0,
      onComplete: (title, xp, credits) => {
        this.awardXp(xp)
        if (credits) this.addCredits(credits)
        const reward = credits ? `+${xp} XP  +${credits}c` : `+${xp} XP`
        this.hud.banner = `OBJECTIVE COMPLETE  ${reward}`
        this.bannerTimer = 2
        vibrate(40)
        this.audio.play('objective')
        trackEvent('objective_complete', { objective: title })
        this.world.pushHeadline(`UNIT 7 PILOT COMPLETES "${title}"`)
        saveMissionProgress(this.missions.serialize())
      },
    })

    const ambient = onEarth && !this.launchPad // skip ground crowds while up on the launch pad
    if (this.raidActive) this.updateCityRaid(dt)
    if (onEarth) this.citySpectacle.update(dt)
    if (onEarth) this.updateHeat(dt)
    if (ambient) this.npcs.update(dt, this.player.position, this.engine.camera.position, this.engine.camera.getWorldDirection(this.camFwd))
    if (ambient) this.events.update(dt, this.player.position, this.heat)
    if (ambient) this.patrols.update(dt)
    if (ambient) this.guide.update(dt, this.player.position.x, this.player.position.z)
    this.landingFx.update(dt) // unconditional so the touchdown burst finishes after the hand-off
    this.missiles.update(dt, (x, z) => this.physics.sampleGround(x, z, 200)?.y ?? 0, (pos, r) => this.detonate(pos, r))
    if (this.zone !== 'moon') this.sky.update(dt) // sky traffic on Earth + Mars
    this.updateEffects(dt)
    this.zones.update(dt, this.zone)
    // NOTE: the follow camera + DoF focus are driven per RENDERED frame in
    // renderFrame() (not here in the fixed sim step), so they stay smooth on
    // high-refresh displays. `this.focus` computed above is what it reads.
    this.world.update(dt, this.focus)
    // Neon contrast by time of day: full bloom at night, eased down toward noon
    // so daylight reads warm/calm and night reads as the bright neon city.
    this.engine.setBloomScale((1 - this.world.dayFactor * 0.62) * this.neonBloomMul)
    // Tone-mapping exposure ramp: a touch darker at noon so highlights don't
    // clip, lifted at night so the neon reads. Earth only; off-world holds base.
    this.engine.setExposure(onEarth ? lerp(1.05, 0.92, this.world.dayFactor) : config.render.exposure)

    // Registered systems: pooled FX, and multiplayer (advances remote avatars +
    // the shared swarm and broadcasts our transform). No-ops cleanly when solo.
    this.systems.update(dt)
    // Ambient events + exploration rewards run in every zone.
    this.worldEvents.update(dt, this.focus)
    this.exploration.update(dt, this.zone, this.player.position.x, this.player.position.z)
    this.playground.update(dt)
    this.dawnShow.update(dt, this.world.dayFactor)
    if (onEarth) this.robotFactory.update(dt)
    // Run the time-trial for whatever zone the player is in (Earth city circuit or
    // the off-world courses). Only the active-zone course is visible/built.
    const activeRace = this.races.find((r) => r.zone === this.zone)
    if (activeRace) this.raceHud = activeRace.update(dt, this.player.position.x, this.player.position.z)
    this.updateBubbleShots(dt)

    // District crossing toast: a brief label as you pass between themed sectors,
    // so the map reads as named neighborhoods. Only when nothing else is banner'd.
    if (onEarth) {
      const dn = this.world.districtNameAt(this.focus.x, this.focus.z)
      if (dn !== this.currentDistrict) {
        this.currentDistrict = dn
        if (this.bannerTimer <= 0) { this.hud.banner = `▸ ${dn}`; this.bannerTimer = 1.8 }
      }
    }

    // Arcade: advance the transport beam every frame; only start a new one when
    // on foot, on Earth, not transitioning, and not in/cooling-down a minigame.
    this.arcade.update(dt, {
      canTrigger: onEarth && this.trans.phase === 'none' && !this.inMinigame && this.arcadeCooldown <= 0 && this.player.mode === 'robot',
      playerPos: this.player.position,
      portals: this.arcadePortals,
      onEnter: (kind, pos) => this.enterMinigame(kind, pos),
      onSfx: () => this.audio.play('portal'),
    })
    // Animate the arcade cabinets: pulse their screens (Earth only). Zone
    // cabinets glow even off-world so you can find your way back.
    for (const p of this.arcadePortals) {
      p.group.visible = onEarth
      if (!onEarth) continue
      p.screenMat.emissiveIntensity = 1.3 + Math.sin(_elapsed * 3 + p.pos.x) * 0.35
    }
    // Live SNAKE demo on the arcade tower's plasma screen (Earth only).
    if (onEarth && this.arcadeScreenUpdate) this.arcadeScreenUpdate(dt)
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
        if (this.plazaHub.beamMat) this.plazaHub.beamMat.opacity = 0.1 + Math.sin(_elapsed * 1.5) * 0.03
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

  /**
   * Per-rendered-frame work (decoupled from the 60Hz fixed sim step so it is
   * smooth on 120/144Hz displays). Drains the look input every frame, then
   * advances the follow camera + DoF with the real frame delta. CameraController
   * uses frame-rate-independent damping, so a larger/smaller dt is safe.
   *
   * The camera is skipped while a cinematic / launch / pause / minigame owns or
   * freezes it (those set the camera directly, or there is nothing to follow).
   * Look is still drained in those states so deltas can't pile up and snap later.
   */
  private renderFrame = (frameDt: number) => {
    this.input.drainLook()
    if (this.dropIn || this.intro || this.mp.inMatch || this.paused || this.inMinigame || this.launch.active) {
      // Drop any speed FOV punch so cinematics / menus frame at the base fov.
      if (this.fovBoostCur !== 0) { this.fovBoostCur = 0; this.engine.setFovBoost(0) }
      return
    }
    // Opening establishing cinematic: a slow elevated orbit around the launch pad
    // that shows the level off (the factory tower, the assembly hangar, the
    // rockets, the city + sky) while you decide to play. It hands off to the
    // normal follow camera the instant you move or drag to look.
    if (this.launchPad && this.launchCineT >= 0) {
      const interacted = Math.abs(this.input.moveX) + Math.abs(this.input.moveY) > 0.15 || (this.launchCineT > 0.4 && this.input.sinceLook < 0.12)
      if (interacted || this.launchCineT > 16) {
        this.launchCineT = -1
        this.camera.snap(this.player.position)
      } else {
        this.updateLaunchCinematic(frameDt)
        if (this.fovBoostCur !== 0) { this.fovBoostCur = 0; this.engine.setFovBoost(0) }
        return
      }
    }
    // Smooth the on-foot body between fixed sim steps (no high-refresh stepping),
    // and follow the interpolated position so the camera tracks it exactly.
    if (!this.vehicles.current) {
      this.player.interp(this.engine.alpha)
      this.focus.copy(this.player.position)
    }
    this.camera.update(frameDt, this.input, this.focus, this.buildFollowState())
    // Keep the (desktop-only) depth-of-field focused on the subject.
    this.engine.setFocusDistance(this.engine.camera.position.distanceTo(this.focus))
    // Sprint FOV punch: a subtle widen as speed climbs, eased so it never snaps.
    const sp = this.vehicles.current ? this.vehicles.currentSpeed : this.player.speed
    const maxSp = this.vehicles.current ? 52 : config.player.runSpeed
    const targetBoost = clamp(sp / maxSp, 0, 1) * 5
    this.fovBoostCur = damp(this.fovBoostCur, targetBoost, 6, frameDt)
    this.engine.setFovBoost(this.fovBoostCur)
  }

  /** Drive the opening establishing-orbit: an elevated camera that slowly circles
   *  the launch pad, starting behind the robot looking out over the hangar +
   *  factory tower + city, then panning around to take in the whole level. */
  private updateLaunchCinematic(dt: number) {
    this.launchCineT += dt
    const lp = this.launchPad!
    const c = lp.spawn
    const yaw = lp.spawnYaw
    // Start behind the robot (looking forward over the hangar/factory), then orbit.
    const ang = yaw + Math.PI + this.launchCineT * 0.11
    const r = 34, h = 22
    const cam = this.engine.camera
    cam.position.set(c.x + Math.sin(ang) * r, c.y + h, c.z + Math.cos(ang) * r)
    cam.lookAt(c.x, c.y + 5.5, c.z)
    this.focus.copy(this.player.position)
  }

  /** Nearest live capturable alien to a point, across both the local roamers and
   *  the shared (server-owned) swarm. Drives the capture-objective beacon. */
  private nearestCapturable(x: number, z: number): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null
    let bestD = Infinity
    for (const c of this.capturables) {
      if (!c.alive) continue
      const d = (c.position.x - x) ** 2 + (c.position.z - z) ** 2
      if (d < bestD) { bestD = d; best = c.position }
    }
    const shared = this.mp.nearestSharedAlien(x, z)
    if (shared && (shared.x - x) ** 2 + (shared.z - z) ** 2 < bestD) best = shared
    return best ? best.clone() : null
  }

  /** Assemble the modern-cam follow hints for the current control subject. */
  private buildFollowState(): import('./Camera').FollowState {
    const v = this.vehicles.current
    const idle = this.input.sinceLook > config.camera.autoFollowDelay
    if (v) {
      const sp = Math.hypot(v.velocity.x, v.velocity.z)
      const inv = sp > 0.1 ? 1 / sp : 0
      return {
        // Tall walkers (mechs / titans) need the camera pulled back to frame them.
        distanceScale: isMech(v.kind) || v.kind === 'titan' ? Math.min(9, 1.8 + v.size * 0.55) : 1.8,
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
      // Pull the camera well back during the launch-pad opening so the whole
      // scene (the assembly hangar + the factory tower) reads as an establishing
      // shot and the robot isn't filling the frame.
      distanceScale: this.launchPad ? 2.1 : p.mode === 'plane' ? 1.35 : 1,
      followYaw: p.yaw,
      moveX: p.velocity.x * inv,
      moveZ: p.velocity.z * inv,
      speed01: clamp(sp / config.player.runSpeed, 0, 1),
      // Trail the robot whenever it's moving (even a slow turn) and the look stick
      // is idle, so spinning around with the move stick swings the camera behind
      // you. Grounded, boarding, or gliding all qualify.
      canAutoFollow: idle && sp > 0.8 && onFoot && (p.grounded || p.boarding || p.mode === 'plane'),
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
    // Nearby uncollected data shards (capped) so the radar guides exploration in
    // every zone (Earth's city field and the Moon/Mars fields alike).
    this.collectibles.forEachNearby(px, pz, range, 8, (x, z) => add(x, z, 'powerup'))
    // Rare meteorite fragments are time-limited, so flag them on the Moon radar.
    if (this.zone === 'moon') this.meteorShower.forEachFragment((x, z) => add(x, z, 'powerup'))
    if (this.zone !== 'moon') this.sky.forEach((x, z) => add(x, z, 'ship'))
    for (const p of this.zones.portalsFor(this.zone)) add(p.position.x, p.position.z, 'portal')
    if (this.zone === 'earth') for (const p of this.arcadePortals) add(p.pos.x, p.pos.z, 'portal')
    if (this.zone === 'earth' && this.plazaMars) add(this.plazaMars.pos.x, this.plazaMars.pos.z, 'portal') // Mars gateway
    if (this.zone === 'earth') {
      add(64, 8, 'objective') // race start gate
      add(-110, 64, 'objective') // robot factory
    }
    // During the raid, flag the things you need to find as objective blips: the
    // mothership once it's inbound, or the free mech to board while on foot.
    if (this.raidActive && this.zone === 'earth') {
      const bp = this.events.bossMapPos()
      if (bp) add(bp.x, bp.z, 'objective')
      const inMech = !!this.vehicles.current && isWalker(this.vehicles.current.kind)
      if (!inMech) {
        const mech = this.vehicles.list.find((v) => v.kind === 'mechM')
        if (mech) add(mech.position.x, mech.position.z, 'objective')
      }
    }
    const ot = this.missions.objTarget
    if (ot) add(ot.x, ot.z, 'objective') // guide blip
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
        : cur.kind === 'titan'
        ? `${cur.name} - WASD walk, Space/J rise, H fire, G exit`
        : cur.kind === 'tram'
        ? 'RIDING TRAM - G to hop off'
        : `Press G - Exit ${this.vehicles.currentName}`
    } else if (this.player.mode === 'robot') {
      const near = this.vehicles.nearest(this.player.position)
      if (near) {
        if (isMech(near.kind) && !this.isUnlocked(near.kind)) {
          const cost = MECH_COST[near.kind] ?? 0
          prompt = this.credits >= cost ? `G - Unlock ${near.name} (${cost} CR)` : `${near.name} LOCKED - need ${cost} CR`
        } else if (near.kind === 'rocket') {
          const order: Zone[] = ['earth', 'moon', 'mars']
          const next = order[(order.indexOf(this.zone) + 1) % order.length]
          prompt = `Press G - RIDE TO ${next.toUpperCase()}`
        } else if (near.kind === 'tram') {
          prompt = 'Press G - RIDE TRAM'
        } else {
          prompt = `Press G - ${near.name}`
        }
      } else if (this.zone === 'earth' && !this.arcade.busy) {
        // Walking up to a cabinet pad: name the game and say how to start, so you
        // step on deliberately instead of being surprised by the transport beam.
        let bestKind: MinigameKind | null = null
        let bestD = 5 * 5 // prompt radius (the beam itself triggers at 2.0)
        for (const p of this.arcadePortals) {
          const dx = p.pos.x - this.player.position.x
          const dz = p.pos.z - this.player.position.z
          const d = dx * dx + dz * dz
          if (d < bestD) { bestD = d; bestKind = p.kind }
        }
        if (bestKind) prompt = `STEP ON PAD - ${bestKind.toUpperCase()}`
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
      this.persist()
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
    this.hud.chatEnabled = this.chatEnabled
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
    const mp = this.mp.hudSnapshot()
    this.hud.shards = this.collectibles.counts()
    this.hud.combo = this.traversal.combo()
    this.hud.captureChain = this.captureCombo.hud()
    // Wanted level: ceil so the first crime lights a star immediately. Off-world
    // there are no police, so it always reads clear.
    const heatOn = this.zone === 'earth'
    this.hud.heat.stars = heatOn ? Math.min(config.heat.max, Math.ceil(this.heat)) : 0
    this.hud.heat.wanted = heatOn && this.heat >= config.heat.pursueAt
    // Debug-only perf overlay: live draw calls + GPU memory (spot leaks on switch).
    if (this.debug) {
      const m = this.engine.memoryInfo()
      this.hud.perf = { draws: this.engine.drawCalls, tris: this.engine.triangles, geos: m.geometries, texs: m.textures }
    }
    // Presence: when truly connected, show the real room. When solo, pad it with
    // the cosmetic bots (a stable count that doesn't crash to 1 off-world) and
    // rank YOU among them so the competition reads as real.
    if (this.mp.connected) {
      this.hud.online = mp.online
      this.hud.leaderboard = mp.leaderboard
    } else {
      this.hud.online = 1 + this.bots.rosterSize
      // Merge YOU into the bots' (cached) ranking. Rebuild only when a bot's
      // score changed or your score changed, into a reused array - the HUD polls
      // this 20x/sec and the old spread+sort+slice allocated on every poll.
      const botRows = this.bots.leaderboard()
      if (this.bots.leaderboardVersion !== this.soloLbVersion || this.hud.score !== this.soloLbScore) {
        this.soloLbVersion = this.bots.leaderboardVersion
        this.soloLbScore = this.hud.score
        this.buildSoloLeaderboard(botRows)
      }
      this.hud.leaderboard = this.soloLb
    }
    this.hud.profiles = mp.profiles
    this.hud.challenge = mp.challenge
    this.hud.match = mp.match
    this.hud.progress = this.buildProgressHud()
    this.hud.warp = {
      charge01: Math.min(1, this.warpCharge / Game.WARP_TIME),
      ready: this.warpCharge >= Game.WARP_TIME,
      active: this.warpActive,
      menu: this.warpMenuOpen,
    }
    this.hud.race = this.raceHud

    this.hudListener({ ...this.hud, powerup: this.hud.powerup ? { ...this.hud.powerup } : null })
  }

  dispose() {
    // Session end: report the final summary before tearing anything down.
    this.emitGameOver()
    // Persist session takings (credits + best are already saved live).
    this.profile.lifetimeCaptured += this.hud.captured
    this.profile.credits = this.credits
    this.persist()
    // Best-effort final flush of session takings to the cloud before teardown.
    void this.saveStore?.sync()
    this.clearWarpModel()
    // Tears down registered systems (multiplayer net + renderers, pooled FX).
    this.systems.dispose()
    this.boundary.dispose()
    this.guide.dispose()
    this.landingFx.dispose()
    this.launchPad?.dispose()
    this.worldEvents.dispose()
    this.exploration.dispose()
    this.playground.dispose()
    this.dawnShow.dispose()
    this.robotFactory.dispose()
    this.races.forEach((r) => r.dispose())
    for (const s of this.bubbleShots) this.engine.scene.remove(s.mesh)
    this.bubbleShots = []
    this.bubbleShotGeo.dispose()
    this.bubbleShotMat.dispose()
    this.missions.dispose()
    this.input.dispose()
    this.player.dispose()
    this.vehicles.dispose()
    this.missiles.dispose()
    this.npcs.dispose()
    this.patrols.dispose()
    this.sky.dispose()
    this.zones.dispose()
    this.events.dispose()
    this.citySpectacle.dispose()
    this.intro?.dispose()
    this.dropIn?.dispose()
    this.assets.dispose()
    const m = this.netLine.material as THREE.Material
    this.netLine.geometry.dispose()
    m.dispose()
    this.arcade.dispose()
    this.arcadeGeos.forEach((g) => g.dispose())
    this.arcadeMats.forEach((mm) => mm.dispose())
    this.arcadeTex.forEach((t) => t.dispose())
    this.arcadeRobot?.dispose()
    this.audio.dispose()
    this.engine.dispose()
    this.world.dispose()
  }
}
