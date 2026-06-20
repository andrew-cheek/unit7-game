// Shared types used across the engine and the React HUD layer.

export type Zone = 'earth' | 'mars' | 'moon'
export type AssetQuality = 'low' | 'high'

/** Props consumers (Lovable) can pass to <Unit7Game />. All optional with sane defaults. */
export interface Unit7Config {
  /** Play the factory assembly cinematic before gameplay. Default true. */
  startInIntro?: boolean
  /** 'high' = 2K/4K textures + LODs + MSAA; 'low' = lighter. Default 'high'. */
  quality?: AssetQuality
  /** Which zone to spawn into. Default 'earth'. */
  initialZone?: Zone
}

export type PlayerMode = 'robot' | 'plane' | 'parachute' | 'vehicle'

export type PowerupKind = 'speed' | 'shield' | 'fuel' | 'score'

export type BlipKind = 'building' | 'npc' | 'vehicle' | 'portal' | 'powerup' | 'alien' | 'ship'

/** A radar dot, already transformed into heading-up, normalized [-1,1] space. */
export interface RadarBlip {
  x: number
  y: number
  kind: BlipKind
}

/** Snapshot the engine pushes to the React HUD (throttled ~20Hz). */
export interface HudState {
  mode: PlayerMode
  zone: Zone
  stamina: number // 0..1
  fuel: number // 0..1
  score: number
  best: number // best score this device (persisted)
  captured: number
  speed: number // m/s
  altitude: number // m above ground
  heading: number // camera yaw, radians (for the compass)
  prompt: string | null // contextual action prompt, e.g. "Press G - Hovercar"
  powerup: { kind: PowerupKind; remaining: number } | null
  shield: boolean
  fps: number
  paused: boolean
  lookLocked: boolean // pointer-lock active (desktop)
  loading: boolean
  loadingProgress: number // 0..1
  loadingMsg: string
  intro: boolean
  vehicle: string | null // name of the vehicle currently piloted
  radar: RadarBlip[]
  fade: number // 0..1 black overlay for zone transitions / launch
  banner: string | null // transient center banner (e.g. "ENTERING MARS")
  minigame: MinigameKind | null // non-null while a full-screen minigame is active
}

export type MinigameKind = 'beamwars' | 'digduel'

/** Minimal command surface the HUD / mobile controls use to talk back to the engine. */
export interface GameControls {
  setVirtualMove(x: number, y: number): void // joystick, -1..1
  setVirtualLook(dx: number, dy: number): void // touch look delta (px)
  pressAction(action: GameAction, down: boolean): void
  resume(): void
  pause(): void
  skipIntro(): void
  requestPointerLock(): void
  exitMinigame(): void // leave a minigame and return to the city
  restartIntro(): void // replay the opening cinematic from the start
}

export type GameAction =
  | 'sprint'
  | 'jet'
  | 'net'
  | 'enter'
  | 'boost'
  | 'morph'
  | 'chute'
