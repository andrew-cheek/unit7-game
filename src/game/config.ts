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
    exposure: 1.05,
    bloom: { strength: 0.85, radius: 0.55, threshold: 0.78 },
    shadowMapSize: 2048,
    // Frame dt is clamped to this so a backgrounded tab can't fling entities.
    maxFrameDelta: 0.05,
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
    range: 14,
    arcHeight: 4,
    cooldown: 0.8,
  },

  camera: {
    fov: 62,
    distance: 8,
    minDistance: 2.2,
    height: 2.6,
    targetHeight: 1.5,
    followLambda: 9,
    rotateLambda: 16,
    pitchMin: -0.85,
    pitchMax: 0.62,
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

  events: {
    spaceshipInterval: 22, // seconds between landing-ship events
    aliensPerShip: 3,
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
