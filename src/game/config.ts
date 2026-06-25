import type { AssetQuality, Zone } from './types'
import { TIERS, type QualityTier } from './tiers'

// Central tunables. Engine systems read from here so balancing lives in one place.
export const config = {
  quality: 'high' as AssetQuality,

  // The resolved quality tier every system reads from. Game overwrites this at
  // startup via detectTier(); defaults to the high preset so non-Game callers
  // (tests, asset previews) still have a valid object.
  tier: TIERS.high as QualityTier,

  render: {
    pixelRatioCap: 2,
    exposure: 0.98,
    // Bloom is reserved for genuinely bright emitters, not every lit window.
    // High threshold (0.96) so only hero signs/cores bloom, with a tighter
    // radius and lower strength so the whole city doesn't haze up. Runs at
    // half res (see Engine). The dark-city look comes from cutting emissive
    // coverage (procedural/World), not from cranking bloom.
    bloom: { strength: 0.34, radius: 0.4, threshold: 0.96 }, // strength trimmed (was 0.42) so near-field neon stops blowing out to white
    shadowMapSize: 2048,
    // Frame dt is clamped to this so a backgrounded tab can't fling entities.
    maxFrameDelta: 0.05,
    // Fixed-timestep simulation: physics + game logic always advance in steps of
    // exactly `fixedDelta` regardless of render frame rate, so outcomes are the
    // same at 30/60/144fps (CLAUDE.md's core rule). `maxSubSteps` caps catch-up
    // work per frame to avoid a spiral of death on a hitch.
    fixedDelta: 1 / 60,
    maxSubSteps: 5,
  },

  world: {
    half: 220, // half-extent of the playable district (meters)
    block: 56, // city block pitch
    roadWidth: 16,
    sidewalk: 3,
    drawDistance: 300,
  },

  // Neon-noir palette (Cyberpunk / Mirror's Edge inspired).
  palette: {
    cyan: 0x27e7ff,
    magenta: 0xff2bd0,
    purple: 0x8a5cff,
    orange: 0xff8a1e,
    lime: 0x9bff4d,
    deepBlue: 0x0a1030,
    asphalt: 0x0b0c12, // darker road so wet neon reflections have value to pop against
    concrete: 0x1c1f29,
    glass: 0x0f2233,
    robot: 0xc9d4e3,
    robotTrim: 0x27e7ff,
  },

  player: {
    radius: 0.55,
    height: 1.9,
    eyeHeight: 1.6,
    walkSpeed: 6.5,
    runSpeed: 12,
    accel: 60, // snappier off-the-line response (was 46)
    decel: 52, // crisper stop, less ice-skating (was 34)
    airControl: 0.4,
    airControlJet: 0.65, // snappier steering while the jetpack is actively thrusting
    jumpSpeed: 9.5,
    // Fall faster than you rise so jumps/hops feel grounded, not floaty.
    fallGravityMult: 1.6,
    // Forgiveness window: can still hop just after leaving the ground.
    coyoteTime: 0.12,
    // Forgiveness window: a hop tapped just BEFORE landing still fires on touchdown.
    jumpBuffer: 0.12,
    // Snap onto ground when within this distance below the feet (steps/ramps).
    stepDown: 0.6,
    turnLerp: 16,
    staminaMax: 100,
    staminaDrain: 26, // per second while sprinting
    staminaRegen: 20, // per second while not
    staminaMinToSprint: 8,
  },

  jetpack: {
    thrust: 26,
    maxAscend: 13, // steady cruise cap while holding
    cruiseAscend: 4, // steady climb once the reserve is spent (never runs out)
    pulseBoost: 9, // re-press mid-air for an upward burst that climbs PAST the cruise cap
    fuelMax: 100,
    fuelDrain: 34,
    fuelRegen: 18,
    fuelMinToFly: 4,
  },

  // Grapple arm: hold to shoot a tendril that EXTENDS outward along your aim
  // until it touches a surface, then reels you to it. Release anytime to let go
  // and re-aim. (Spider-Man style hopping around the city.)
  grapple: {
    range: 110, // max reach before a miss retracts (m)
    extendSpeed: 150, // how fast the tendril shoots out (m/s)
    pull: 140, // acceleration toward the anchor once attached (m/s^2)
    maxSpeed: 56, // capped zip speed
    arriveDist: 4.5, // release automatically when this close to the anchor
    maxTime: 5, // safety timeout (s)
  },

  // Summonable hover skateboard (C / mobile BOARD): the robot rides it visibly
  // with a fast, glidey, carving feel and leans into turns.
  hoverboard: {
    speedMul: 1.85, // top speed multiplier over running
    accel: 34,
    decel: 14, // low so you keep momentum / glide
    turnLerp: 7, // looser turn for wide carves
    lean: 0.5, // max roll into a turn (radians)
  },

  // Grind rails: hop onto a neon rail on the hoverboard and slide it. The board
  // locks to the rail, builds a little speed, and launches you off the end (or
  // when you jump). Snap only triggers while boarding and moving.
  grind: {
    minSpeed: 11, // min board speed to latch a rail (and the floor speed once on)
    maxSpeed: 36, // speed cap while grinding (you accelerate up to this)
    accel: 7, // speed gained per second while riding
    snapRadius: 2.6, // how close the board must pass a rail to latch (m)
    boardOffset: 0.9, // ride height above the rail line (m)
  },

  parachute: {
    terminalVelocity: -3, // m/s, never falls faster than this while deployed
    horizontalDrift: 7,
    deployMinAir: 0.2, // must be airborne this long before O deploys
    swayAmount: 0.12,
  },

  plane: {
    speed: 26,
    boostSpeed: 40,
    gravityScale: 0.16, // glides instead of dropping
    lift: 17, // jet/Space climb rate
    bank: 0.55, // roll into turns
    morphLambda: 7, // morph animation speed
  },

  net: {
    range: 9,
    arcHeight: 1.6,
    cooldown: 0.8,
  },

  camera: {
    fov: 62,
    distance: 7.2, // close enough that the robot reads big (Roblox-ish framing)
    minDistance: 2.2,
    // Hard floor the wall-collision pull-in may reach (well below minDistance).
    // Kept just above the camera near plane so a tucked-in camera still renders
    // the world instead of clipping to black against a wall.
    collisionMinDistance: 0.7,
    height: 3.0,
    targetHeight: 1.7,
    // Behind-and-slightly-above chase angle that shows the horizon/city ahead
    // instead of staring down at blank ground (the old 0.38 looked downward).
    startPitch: 0.16,
    followLambda: 9,
    rotateLambda: 16,
    pitchMin: -0.85,
    pitchMax: 1.05, // look further up so tall rockets / portals / towers are visible
    mouseSensitivity: 0.0022,
    touchSensitivity: 0.006,
    collisionPadding: 0.4,
    // Modern action-cam feel: when the player moves and the look stick/mouse has
    // been idle for `autoFollowDelay`, the camera eases its yaw to trail behind
    // the subject's heading. Manual look instantly takes priority again.
    // Snappier so turning the robot swings the camera around behind it quickly
    // once the look stick is idle (was 3.0 / 0.5s, which felt sluggish on a turn).
    autoFollowLambda: 5.5,
    autoFollowDelay: 0.3,
    // Push the look target ahead along movement so you see more of where you go.
    lookAhead: 3.6,
    lookAheadLambda: 6,
    // Pull the camera back when moving fast (sprint / boost).
    speedPullback: 1.28,
    // Collision pull-in eases back out at returnLambda; pulls in fast (but no
    // longer a single-frame snap, which read as a jarring pop on thin obstacles).
    returnLambda: 7,
    collisionInLambda: 24,
    // When a wall directly behind jams the camera in close, tilt the view up by
    // up to this many radians so the subject + scene stay framed instead of the
    // camera shoving down to ground level. Scales with how close it's forced.
    collisionPitchLift: 0.4,
    // Keep the camera at least this far above whatever ground is below it.
    minGroundClearance: 0.6,
  },

  vehicle: {
    hovercar: { accel: 42, maxSpeed: 42, reverse: 14, turn: 1.9, hoverHeight: 1.1, bob: 0.12 },
    speeder: { accel: 56, maxSpeed: 58, reverse: 12, turn: 2.4, hoverHeight: 0.9, bob: 0.1 },
    // Off-world exploration rover. Unlike the hovercars it has real ground +
    // gravity physics (drive 'rover'), so climbing a ramp and clearing the lip
    // launches it into a low-gravity arc. hoverHeight is the wheel clearance;
    // maxLaunch caps the upward speed banked from a steep climb.
    rover: { accel: 38, maxSpeed: 42, reverse: 14, turn: 1.6, hoverHeight: 0.7, maxLaunch: 17 },
    spaceship: { accel: 30, maxSpeed: 50, turn: 1.5, hoverHeight: 2.2 },
    // Three pilotable battle-mechs of growing size. They fly (drive: 'fly') and
    // fire missiles. Bigger = stands taller, turns slower, hits a higher top
    // speed. They park standing on the ground and lift off when piloted, so
    // `hoverHeight` here is just the minimum flight clearance (feet above
    // ground). `size` scales the model + camera framing + missile muzzle.
    mechM: { accel: 34, maxSpeed: 44, turn: 1.7, hoverHeight: 1, size: 1.4 },
    mechL: { accel: 30, maxSpeed: 52, turn: 1.25, hoverHeight: 1.5, size: 3.2 },
    // Colossal: ~50m tall, taller than the surrounding towers. Slow turn, big
    // top speed, and it transforms into a fast jet form.
    mechXL: { accel: 26, maxSpeed: 64, turn: 0.8, hoverHeight: 4, size: 10 },
    // Pilotable giant "titans": the arcade guardian and the walkers that roam the
    // outskirts. Big and weighty but controllable; they wander on their own until
    // you climb in. Drive like the mechs (fly).
    titan: { accel: 24, maxSpeed: 50, turn: 0.9, hoverHeight: 2.5, size: 7 },
    enterRange: 6,
  },

  npc: {
    count: 64,
    walkSpeed: 1.7,
    separationRadius: 2.4,
    separationForce: 6.0, // firmer so the crowd doesn't visibly walk through itself
    wanderRadius: 76, // tighter so the crowd concentrates around the player area
  },

  // City life tuning. Counts are the desktop baseline; the mobile tier scales
  // them by tier.densityScale. Bump `density` to make the whole city busier, or
  // zero out a line to drop that kind of life entirely. One place to tune feel.
  city: {
    density: 1, // global multiplier applied on top of tier.densityScale
    robotRatio: 0.35, // fraction of the street crowd that are humanoid robots
    smallAlienRatio: 0.16, // fraction that are small aliens (the rest are citizens)
    bigAlienChance: 0.18, // chance a spawned alien is a large one
    fleeRadius: 9, // aliens scatter when the player gets this close
    quadrupeds: 4, // four-legged robot walkers patrolling
    mechs: 2, // big mech walkers patrolling slowly
    giants: 0, // the outskirts giants are now the pilotable titans (Vehicles), not ambient patrols
    smallShips: 8, // small ships looping between the towers
    bigShipInterval: 20, // seconds between big-ship flyovers
    police: 3, // police cruisers patrolling staggered beats around the plaza
  },

  // Named districts give the city a mental shape instead of one uniform sprawl.
  // A central core, then four angular sectors radiating out, each with its own
  // facade palette, neon allowance, height profile and density. Buildings reuse
  // the same pooled/merged geometry, so this is colour + tuning, not extra draw
  // calls. `dark` is the fraction of matte (un-lit) towers; `neon` scales the
  // decorative-neon allowance; `heightMul`/`density` shape the silhouette.
  districts: [
    { id: 'core', name: 'PLAZA CORE', neon: 0.55, density: 1.0, heightMul: 1.0, dark: 0.38,
      facades: [0x0c0e15, 0x0f1219, 0x12151f, 0x0a0c12, 0x14181f], accents: [0x27e7ff, 0x8a5cff] },
    { id: 'spires', name: 'CORPORATE SPIRES', neon: 0.7, density: 1.0, heightMul: 1.32, dark: 0.46,
      facades: [0x0a0e15, 0x0c1019, 0x0a1117, 0x0a1a1f, 0x0e1622], accents: [0x27e7ff, 0x8a5cff] },
    { id: 'market', name: 'NEON MARKET', neon: 1.0, density: 1.08, heightMul: 0.78, dark: 0.18,
      facades: [0x161019, 0x1a1410, 0x161021, 0x12101a, 0x1a1014], accents: [0xff2bd0, 0xff8a1e, 0x27e7ff] },
    { id: 'docks', name: 'INDUSTRIAL DOCKS', neon: 0.35, density: 0.95, heightMul: 0.7, dark: 0.55,
      facades: [0x14110c, 0x161310, 0x101410, 0x12130f, 0x171612], accents: [0xff8a1e, 0x9bff4d] },
    { id: 'undercity', name: 'THE UNDERCITY', neon: 0.48, density: 1.0, heightMul: 0.92, dark: 0.5,
      facades: [0x100c16, 0x0e0c14, 0x130f1a, 0x0c0a12, 0x140f1c], accents: [0x8a5cff, 0x9bff4d, 0xff2bd0] },
  ] as District[],

  // Day/night cycle timing (seconds within one full loop). Long enough that the
  // day and the night each SETTLE instead of the old 2-minute strobe. The dawn
  // ramp is kept short so the opening morning still plays out quickly; the long
  // hold between dawnEnd and duskStart is the steady daytime, then a dusk ramp
  // into a long neon night. dayFactor still reaches 1, so the invasion / dawn
  // show / commuter triggers that key off it are unchanged.
  dayNight: {
    cycle: 480, // 8-minute full loop
    dawnStart: 6,
    dawnEnd: 16, // ~10s sunrise ramp (matches the old snappy morning)
    duskStart: 320, // ~5 minutes of full day in between
    duskEnd: 345, // 25s dusk, then ~2.5 minutes of night before the next dawn
  },

  events: {
    spaceshipInterval: 10, // seconds between landing-ship events (more alien life)
    aliensPerShip: 5,
    powerupCount: 16,
    droneCount: 24, // more drones buzzing the skyline
    trafficCount: 22, // busier hovercar traffic streaming the avenues
  },

  // News-ticker headlines (edit here). Reactive "BREAKING" lines are injected at
  // runtime in front of these.
  news: [
    'TESLA OPTIMUS ENTERS PILOT PRODUCTION ON THE FACTORY FLOOR',
    'FIGURE 03 DEMOS DEXTEROUS TWO-HANDED ASSEMBLY',
    'BOSTON DYNAMICS ELECTRIC ATLAS PASSES NEW WORK TRIALS',
    '1X NEO BEGINS LIMITED IN-HOME TRIALS',
    'UNITREE G1 PRICE DROP SPARKS A HOBBYIST WAVE',
    'APPTRONIK APOLLO SCALES WAREHOUSE DEPLOYMENTS',
    'AGILITY DIGIT CLOCKS RECORD CONTINUOUS SHIFT',
    'UNIT 7 ONLINE: CITIZENS WELCOME THEIR NEON GUARDIAN',
  ] as string[],

  // Lightweight objective chain (one active at a time). Drives the HUD objective
  // line + completion banners. Config-driven so the flow is tunable in one place.
  // Moon before Mars: the Moon portal is the one walk-through gate present on
  // Earth (Mars is reachable only via the plaza hero ring), so the first
  // off-world objective points at a portal that actually has a beacon. Each step
  // pays escalating XP/credits so the guided chain is itself a progression hook.
  missions: [
    { id: 'plaza', title: 'Find Portal Plaza', type: 'reach', x: 46, z: 12, radius: 10, xp: 50 },
    { id: 'mech', title: 'Pilot a battle mech', type: 'mech', xp: 75, credits: 40 },
    { id: 'moon', title: 'Travel to the Moon', type: 'zone', zone: 'moon', xp: 100, credits: 50 },
    { id: 'mars', title: 'Travel to Mars', type: 'zone', zone: 'mars', xp: 120, credits: 75 },
    { id: 'capture', title: 'Capture 3 aliens', type: 'capture', count: 3, xp: 130, credits: 60 },
    { id: 'arcade', title: 'Play an arcade game', type: 'minigame', xp: 150, credits: 100 },
  ] as Mission[],

  // Per-zone physics + atmosphere. Skybox/terrain swap on zone change.
  zones: {
    earth: { gravity: -24, fog: 0x070a16, fogNear: 26, fogFar: 240, ground: 0x14161d, ambient: 0x223044, ambientI: 0.5 },
    mars: { gravity: -9.5, fog: 0x3a1206, fogNear: 30, fogFar: 200, ground: 0x7a3a1c, ambient: 0x5a2a14, ambientI: 0.7 },
    moon: { gravity: -4.2, fog: 0x05060a, fogNear: 40, fogFar: 320, ground: 0x6a6a73, ambient: 0x1a1a22, ambientI: 0.35 },
  } satisfies Record<Zone, ZoneCfg>,
}

/** A themed region of the city. The spatial mapping (which sector) lives in
 *  World; these are the per-district look + tuning knobs. */
export interface District {
  id: string
  name: string
  neon: number // decorative-neon allowance (0..1+), scales trim/spine/band chance
  density: number // building keep multiplier (1 = unchanged, <1 = sparser)
  heightMul: number // tower-height multiplier over the radial falloff
  dark: number // fraction of matte, un-lit towers (value contrast)
  facades: number[] // lit-facade base colours (very dark; windows do the glowing)
  accents: number[] // neon accent hues used for trim/spines/roof caps
}

export interface Mission {
  id: string
  title: string
  type: 'reach' | 'mech' | 'zone' | 'capture' | 'minigame'
  x?: number
  z?: number
  radius?: number
  zone?: Zone
  count?: number
  /** XP awarded on completion (defaults applied at the call site if omitted). */
  xp?: number
  /** Credits awarded on completion. */
  credits?: number
}

export interface ZoneCfg {
  gravity: number
  fog: number
  fogNear: number
  fogFar: number
  ground: number
  ambient: number
  ambientI: number
}

export type Config = typeof config
