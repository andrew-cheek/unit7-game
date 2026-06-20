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
    bloom: { strength: 0.5, radius: 0.5, threshold: 0.85 },
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
    distance: 9.5, // pulled back a touch for a more establishing view
    minDistance: 2.2,
    height: 2.6,
    targetHeight: 1.5,
    // Higher, looking-down-over-the-shoulder default so the city reads as you spawn.
    startPitch: 0.32,
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
    lookAhead: 2.2,
    lookAheadLambda: 6,
    // Pull the camera back when moving fast (sprint / boost).
    speedPullback: 1.22,
    // Collision pull-in eases back out at this rate; snaps in instantly.
    returnLambda: 7,
    // Keep the camera at least this far above whatever ground is below it.
    minGroundClearance: 0.6,
  },

  vehicle: {
    hovercar: { accel: 42, maxSpeed: 42, reverse: 14, turn: 1.9, hoverHeight: 1.1, bob: 0.12 },
    speeder: { accel: 56, maxSpeed: 58, reverse: 12, turn: 2.4, hoverHeight: 0.9, bob: 0.1 },
    spaceship: { accel: 30, maxSpeed: 50, turn: 1.5, hoverHeight: 2.2 },
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

  // Per-zone physics + atmosphere. Skybox/terrain swap on zone change.
  zones: {
    earth: { gravity: -24, fog: 0x070a16, fogNear: 26, fogFar: 240, ground: 0x14161d, ambient: 0x223044, ambientI: 0.5 },
    mars: { gravity: -9.5, fog: 0x3a1206, fogNear: 30, fogFar: 200, ground: 0x7a3a1c, ambient: 0x5a2a14, ambientI: 0.7 },
    moon: { gravity: -4.2, fog: 0x05060a, fogNear: 40, fogFar: 320, ground: 0x6a6a73, ambient: 0x1a1a22, ambientI: 0.35 },
  } satisfies Record<Zone, ZoneCfg>,
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
