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
    // Toned down on feedback that the neon was too bright: lower strength + a
    // higher threshold so only genuinely bright sources bloom, not everything.
    // Threshold raised again (0.85 -> 0.92) so dim/mid neon and sub-pixel glints
    // on distant geometry stay below the bloom floor and don't shimmer; only the
    // hero-bright signs blow out. Bloom also runs at half res (see Engine).
    bloom: { strength: 0.5, radius: 0.5, threshold: 0.92 },
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
    asphalt: 0x14161d,
    concrete: 0x2a2d39,
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
    jumpSpeed: 9.5,
    // Fall faster than you rise so jumps/hops feel grounded, not floaty.
    fallGravityMult: 1.6,
    // Forgiveness window: can still hop just after leaving the ground.
    coyoteTime: 0.12,
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
    maxAscend: 13,
    fuelMax: 100,
    fuelDrain: 34,
    fuelRegen: 18,
    fuelMinToFly: 4,
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
    distance: 8.5, // close enough that the robot reads big, not tiny
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
    pitchMax: 0.7,
    mouseSensitivity: 0.0022,
    touchSensitivity: 0.006,
    collisionPadding: 0.4,
    // Modern action-cam feel: when the player moves and the look stick/mouse has
    // been idle for `autoFollowDelay`, the camera eases its yaw to trail behind
    // the subject's heading. Manual look instantly takes priority again.
    autoFollowLambda: 3.0,
    autoFollowDelay: 0.5,
    // Push the look target ahead along movement so you see more of where you go.
    lookAhead: 3.6,
    lookAheadLambda: 6,
    // Pull the camera back when moving fast (sprint / boost).
    speedPullback: 1.28,
    // Collision pull-in eases back out at this rate; snaps in instantly.
    returnLambda: 7,
    // Keep the camera at least this far above whatever ground is below it.
    minGroundClearance: 0.6,
  },

  vehicle: {
    hovercar: { accel: 42, maxSpeed: 42, reverse: 14, turn: 1.9, hoverHeight: 1.1, bob: 0.12 },
    speeder: { accel: 56, maxSpeed: 58, reverse: 12, turn: 2.4, hoverHeight: 0.9, bob: 0.1 },
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
    enterRange: 6,
  },

  npc: {
    count: 46,
    walkSpeed: 1.7,
    separationRadius: 2.2,
    separationForce: 4.0,
    wanderRadius: 90,
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
    giants: 2, // massive walker war-machines on the outskirts
    smallShips: 6, // small ships looping between the towers
    bigShipInterval: 24, // seconds between big-ship flyovers
  },

  events: {
    spaceshipInterval: 16, // seconds between landing-ship events
    aliensPerShip: 4,
    powerupCount: 14,
    droneCount: 12,
    trafficCount: 6,
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
  missions: [
    { id: 'plaza', title: 'Find Portal Plaza', type: 'reach', x: 0, z: 13, radius: 10 },
    { id: 'mech', title: 'Pilot a battle mech', type: 'mech' },
    { id: 'mars', title: 'Travel to Mars', type: 'zone', zone: 'mars' },
    { id: 'moon', title: 'Travel to the Moon', type: 'zone', zone: 'moon' },
    { id: 'capture', title: 'Capture 3 aliens', type: 'capture', count: 3 },
    { id: 'arcade', title: 'Play an arcade game', type: 'minigame' },
  ] as Mission[],

  // Per-zone physics + atmosphere. Skybox/terrain swap on zone change.
  zones: {
    earth: { gravity: -24, fog: 0x070a16, fogNear: 26, fogFar: 240, ground: 0x14161d, ambient: 0x223044, ambientI: 0.5 },
    mars: { gravity: -9.5, fog: 0x3a1206, fogNear: 30, fogFar: 200, ground: 0x7a3a1c, ambient: 0x5a2a14, ambientI: 0.7 },
    moon: { gravity: -4.2, fog: 0x05060a, fogNear: 40, fogFar: 320, ground: 0x6a6a73, ambient: 0x1a1a22, ambientI: 0.35 },
  } satisfies Record<Zone, ZoneCfg>,
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
