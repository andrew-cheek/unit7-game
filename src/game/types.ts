// Shared types used across the engine and the React HUD layer.

export type Zone = 'earth' | 'mars' | 'moon'
export type AssetQuality = 'low' | 'medium' | 'high'

/** Props consumers (Lovable) can pass to <Unit7Game />. All optional with sane defaults. */
export interface Unit7Config {
  /** Play the factory assembly cinematic before gameplay. Default true. */
  startInIntro?: boolean
  /** Render quality: 'high' (full post), 'medium' (lighter post + density),
   *  'low' (mobile). Auto-detected if omitted; '?tier=low|medium|high' overrides. */
  quality?: AssetQuality
  /** Which zone to spawn into. Default 'earth'. */
  initialZone?: Zone
  /** Show the username / join-world prompt for shared-world multiplayer. Default true. */
  multiplayer?: boolean
  /** Override the realtime server host (else auto: localhost in dev, the deployed PartyKit host in prod). */
  multiplayerHost?: string
}

export type PlayerMode = 'robot' | 'plane' | 'parachute' | 'vehicle'

export type PowerupKind = 'speed' | 'shield' | 'fuel' | 'score'

export type BlipKind = 'building' | 'npc' | 'vehicle' | 'portal' | 'powerup' | 'alien' | 'ship' | 'objective'

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
  credits: number // spendable currency (persisted)
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
  objective: string | null // current active objective text (top-center)
  muted: boolean // game audio muted
  canCapture: boolean // a capturable target is within net range (shows CAPTURE)
  missionPopup: { title: string; body: string } | null // transient intro/mission card
  minigame: MinigameKind | null // non-null while a full-screen minigame is active
  online: number // players in the shared world incl. self (1 = solo / not connected)
  leaderboard: { name: string; score: number }[] // shared-world scoreboard (empty when solo)
  neon: 'low' | 'med' | 'high' // neon density / quality setting
  profiles: PlayerProfile[] // roster of viewable pilot profiles (self first; networked others follow)
}

/**
 * A pilot's viewable profile: identity plus a compact win/loss record per
 * competitive game and lifetime shared-world captures. `self` flags the local
 * player. `id` is the network connection id (empty for the offline self).
 */
export interface PlayerProfile {
  id: string
  name: string
  self: boolean
  aliens: number // lifetime shared-world alien captures
  games: { game: string; played: number; won: number; lost: number; best: number }[]
}

export type MinigameKind = 'beamwars' | 'digduel' | 'merge2048' | 'invaders' | 'snake' | 'raceloop' | 'mecharena' | 'drivemad'

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
  toggleMute(): void // toggle game audio
  cycleNeon(): void // cycle neon density: low -> med -> high
}

export type GameAction =
  | 'sprint'
  | 'jet'
  | 'net'
  | 'enter'
  | 'boost'
  | 'morph'
  | 'chute'
  | 'dance'
  | 'bubble'
  | 'board'
