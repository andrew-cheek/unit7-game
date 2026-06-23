// Shared-world multiplayer orchestration.
//
// This used to live inline in Game.ts as ~250 lines of glue: the net socket,
// the remote-player and shared-alien renderers, the roster/leaderboard/profile
// state, the duel (challenge + live match) flow, and the 12Hz state broadcast.
// It is pulled out here so the multiplayer domain is one cohesive unit. The
// renderers (Net, RemotePlayers, SharedAliens) were already clean classes; what
// moved is the orchestration between them and the game.
//
// Coupling back into Game goes through one MultiplayerHost callback interface
// (the same pattern Events.onSoak / Race.onFinish already use), so this manager
// never reaches into Game's internals directly. Everything that touches the
// player's score/credits/HUD/audio is a host call; everything that is purely
// roster/duel bookkeeping lives here.

import * as THREE from 'three'
import { Net, type NetState, type NetProfile, type ScoreRow, type WireGames, type MatchSide } from './Net'
import { RemotePlayers } from './RemotePlayers'
import { SharedAliens } from './SharedAliens'
import { recordDuel, noteDaily, tierForRating } from './progression'
import { loadStats, recordGameResult } from './storage'
import { vibrate } from './utils'
import { trackEvent } from '../lib/analytics'
import type { GameSystem } from './System'
import type { Sfx } from './Audio'
import type { MatchView, PlayerProfile, Zone } from './types'

/** Dynamic self-identity the manager needs to publish profiles + build the roster. */
export interface SelfIdentity {
  aliens: number // lifetime + this-session captures
  level: number
  rating: number // duel rank points
  badges: number // achievements unlocked
  accent: number // equipped accent cosmetic color (hex)
}

/** What the manager needs from the game to drive multiplayer. Keeps src/game/Game
 *  free of the net glue while leaving all player-state mutation on the game side. */
export interface MultiplayerHost {
  /** The local player's transform, built fresh each broadcast. */
  netState(): NetState
  /** Live self-identity for profile publishing + the roster's "self" row. */
  selfIdentity(): SelfIdentity
  /** The local callsign chosen at join (falls back to saved callsign / "YOU"). */
  callsign(): string
  /** Player ground position, used to seed a bare join until its first state. */
  joinSeed(): { x: number; z: number }
  /** Active zone (remote avatars + shared aliens are filtered to it). */
  zone(): Zone
  banner(text: string, secs?: number): void
  play(sfx: Sfx): void
  shockwave(pos: { x: number; y: number; z: number }, color: number, r: number, dur: number): void
  /** Credit + score a confirmed claim of a shared (server-owned) alien. */
  applyConfirmedClaim(award: number): void
  warpRevert(): void
  setInputLock(enabled: boolean): void
  /** Drop a stray pause/Escape press (so leaving the duel view doesn't pause). */
  consumePause(): void
  awardXp(amount: number): void
  grantDailyReward(reward: { credits: number; xp: number }): void
  refreshProgression(): void
}

export class MultiplayerManager implements GameSystem {
  private scene: THREE.Scene
  private host: MultiplayerHost
  private net: Net | null = null
  readonly remotePlayers: RemotePlayers
  readonly sharedAliens: SharedAliens

  private username = ''
  private online = 1 // players in the world incl. self (1 = solo)
  private leaderboard: ScoreRow[] = []
  private remoteProfiles: NetProfile[] = []
  private hudProfiles: PlayerProfile[] = []
  private profilesDirty = true
  private incomingChallenge: { fromId: string; name: string } | null = null
  private matchView: MatchView | null = null
  private netAccum = 0

  constructor(scene: THREE.Scene, host: MultiplayerHost) {
    this.scene = scene
    this.host = host
    this.remotePlayers = new RemotePlayers(scene)
    this.sharedAliens = new SharedAliens(scene)
  }

  // --- queries Game reads ----------------------------------------------------

  get connected(): boolean {
    return !!this.net
  }
  get inMatch(): boolean {
    return !!this.matchView
  }
  get playerCount(): number {
    return this.online
  }
  get myId(): string {
    return this.net?.myId ?? ''
  }

  /** Mark the HUD roster stale so it rebuilds on the next snapshot, without any
   *  network send. Cheap; call after any local progression change. */
  markProfileDirty() {
    this.profilesDirty = true
  }

  /** Mark the HUD roster stale so it rebuilds on the next snapshot (and republish
   *  our profile to the room). Call after a local stat change (capture / game). */
  publishProfile() {
    this.profilesDirty = true
    if (!this.net) return
    const id = this.host.selfIdentity()
    const stats = loadStats()
    const games: WireGames = {}
    for (const [game, r] of Object.entries(stats.games)) games[game] = [r.played, r.won, r.lost, r.best]
    this.net.sendProfile(id.aliens, games, id.level, id.rating, id.badges, id.accent)
  }

  /** Snapshot of the multiplayer-owned slice of the HUD. */
  hudSnapshot(): { online: number; leaderboard: ScoreRow[]; profiles: PlayerProfile[]; challenge: { fromId: string; name: string } | null; match: MatchView | null } {
    if (this.profilesDirty) {
      this.hudProfiles = this.buildHudProfiles()
      this.profilesDirty = false
    }
    return {
      online: this.online,
      leaderboard: this.leaderboard,
      profiles: this.hudProfiles,
      challenge: this.incomingChallenge,
      match: this.matchView ? { ...this.matchView } : null,
    }
  }

  /** Nearest shared alien to a point (for the capture-objective beacon). */
  nearestSharedAlien(x: number, z: number): THREE.Vector3 | null {
    return this.sharedAliens.nearestTo(x, z)
  }

  /** Tell the room about a local capture so others see the same ring pop. */
  broadcastCapture(pos: [number, number, number], award: number) {
    this.net?.sendCapture(pos, award)
  }

  /**
   * Try to claim the nearest shared alien in the forward cone, but only if it is
   * at least as close as the best local target. Returns true if a claim was sent
   * (the caller should then stop, letting the server resolve first-claim-wins).
   */
  tryClaim(sx: number, sz: number, fwdX: number, fwdZ: number, range: number, cosCone: number, localBestDist: number): boolean {
    if (!this.net) return false
    const claim = this.sharedAliens.nearestClaimable(sx, sz, fwdX, fwdZ, range, cosCone)
    if (!claim) return false
    const cd = Math.hypot(claim.pos.x - sx, claim.pos.z - sz)
    if (cd <= localBestDist) {
      this.net.sendClaim(claim.id)
      return true
    }
    return false
  }

  // --- duel controls (wired to GameControls) ---------------------------------

  challenge(id: string, trail: number) {
    this.net?.sendChallenge(id, trail)
  }
  accept(trail: number) {
    if (!this.incomingChallenge) return
    this.net?.sendAccept(this.incomingChallenge.fromId, trail)
    this.incomingChallenge = null
  }
  decline() {
    if (!this.incomingChallenge) return
    this.net?.sendDecline(this.incomingChallenge.fromId)
    this.incomingChallenge = null
  }
  matchDir(dx: number, dy: number) {
    this.net?.sendMatchDir(dx, dy)
  }
  /** Leave the live duel: forfeit if still running, then hand control back. */
  leaveMatch() {
    if (!this.matchView) return
    if (this.matchView.status !== 'over') this.net?.sendMatchQuit()
    this.matchView = null
    this.host.consumePause() // drop any Escape pressed inside the duel view
    this.host.setInputLock(true)
  }
  /** Leave the current duel and immediately re-challenge the same opponent. */
  rematch(trail: number) {
    const oppId = this.matchView?.oppId
    this.leaveMatch()
    if (oppId) this.net?.sendChallenge(oppId, trail)
  }

  // --- lifecycle -------------------------------------------------------------

  /**
   * Join the shared world under a username. The game keeps running solo until /
   * if the connection succeeds, and silently reconnects if the server drops.
   */
  connect(username: string, serverHost?: string) {
    if (this.net) return
    this.username = username
    this.net = new Net(
      username,
      {
        onWelcome: (players) => {
          for (const p of players) this.remotePlayers.applySnapshot(p)
          this.online = this.remotePlayers.count + 1
        },
        onJoin: (id, name) => {
          const seed = this.host.joinSeed()
          this.remotePlayers.applySnapshot({ id, name, p: [seed.x, 0, seed.z], y: 0, m: 'robot', v: null, z: this.host.zone(), s: 0, g: true })
          this.online = this.remotePlayers.count + 1
        },
        onLeave: (id) => {
          this.remotePlayers.remove(id)
          this.online = this.remotePlayers.count + 1
        },
        onState: (id, s) => this.remotePlayers.onState(id, s),
        onCapture: (_id, p) => {
          this.host.shockwave({ x: p[0], y: p[1], z: p[2] }, 0x27e7ff, 3, 0.4)
        },
        onStatus: (connected) => {
          if (!connected) this.online = this.remotePlayers.count + 1
        },
        onFull: () => this.host.banner('WORLD FULL — TRY AGAIN', 3),
        onAliens: (list) => this.sharedAliens.sync(list),
        onAlienGone: (id, by, award) => {
          const p = this.sharedAliens.positionOf(id)
          this.sharedAliens.remove(id)
          if (p) this.host.shockwave({ x: p.x, y: p.y, z: p.z }, 0x27e7ff, 3, 0.4)
          if (by === this.net?.myId) {
            this.host.applyConfirmedClaim(award)
            this.publishProfile()
          }
        },
        onScores: (board) => {
          this.leaderboard = board
        },
        onProfiles: (list) => {
          this.remoteProfiles = list
          this.profilesDirty = true
          this.remotePlayers.applyProfiles(
            list.map((p) => ({ id: p.id, name: p.name, accent: p.accent ?? 0x27e7ff, level: p.level ?? 1, tier: tierForRating(p.rating ?? 1000).name })),
          )
        },
        onChallenged: (fromId, name) => {
          if (this.incomingChallenge || this.matchView) return
          this.incomingChallenge = { fromId, name }
          this.host.play('ui')
          vibrate(30)
        },
        onChallengeDeclined: (name) => this.host.banner(`${name} DECLINED`, 2),
        onChallengeBusy: (name) => this.host.banner(`${name} IS BUSY`, 2),
        onMatchStart: (info) => {
          this.host.warpRevert() // duels are robot-only
          this.incomingChallenge = null
          this.matchView = {
            side: info.side, opp: info.opp, oppId: info.oppId, cols: info.cols, rows: info.rows,
            a: info.a, b: info.b, aAlive: true, bAlive: true, status: 'ready', winner: null, seq: 0,
            trailA: info.trailA, trailB: info.trailB, result: null,
          }
          this.host.setInputLock(false)
          this.host.play('ui')
        },
        onMatchTick: (a, b, aAlive, bAlive) => {
          const m = this.matchView
          if (!m) return
          m.a = a; m.b = b; m.aAlive = aAlive; m.bAlive = bAlive
          if (m.status === 'ready') m.status = 'play'
          m.seq += 1
        },
        onMatchEnd: (winner) => {
          const m = this.matchView
          if (!m) return
          m.status = 'over'
          m.winner = winner
          if (winner !== 'draw') {
            const won = winner === m.side
            recordGameResult('beamwars', won ? 'win' : 'loss')
            const r = recordDuel(won)
            m.result = { delta: r.delta, rating: r.rating, tier: r.tier.name, tierColor: r.tier.color, streak: r.streak }
            this.host.awardXp(won ? 60 : 15)
            if (won) {
              const d = noteDaily('duelWins', 1)
              if (d.completed && d.reward) this.host.grantDailyReward(d.reward)
            }
          } else {
            this.host.awardXp(20) // a draw still earns a little
          }
          this.host.refreshProgression()
          this.publishProfile()
        },
      },
      { host: serverHost },
    )
    // Publish shortly after connecting (lets the socket open + the server register us).
    setTimeout(() => this.publishProfile(), 800)
  }

  update(dt: number) {
    const zone = this.host.zone()
    this.remotePlayers.setLocalZone(zone)
    this.remotePlayers.update(dt)
    this.sharedAliens.setVisible(zone === 'earth')
    this.sharedAliens.update(dt)
    if (this.net) {
      this.netAccum += dt
      if (this.netAccum >= 1 / 12) {
        this.netAccum = 0
        this.net.sendState(this.host.netState())
      }
    }
  }

  /** Build the HUD roster: self first, then networked pilots. */
  private buildHudProfiles(): PlayerProfile[] {
    const id = this.host.selfIdentity()
    const stats = loadStats()
    const selfGames = Object.entries(stats.games).map(([game, r]) => ({ game, played: r.played, won: r.won, lost: r.lost, best: r.best }))
    const selfTier = tierForRating(id.rating)
    const self: PlayerProfile = {
      id: this.myId,
      name: this.username || this.host.callsign() || 'YOU',
      self: true,
      aliens: id.aliens,
      level: id.level,
      duelTier: selfTier.name,
      duelTierColor: selfTier.color,
      rating: id.rating,
      badges: id.badges,
      games: selfGames,
    }
    const others: PlayerProfile[] = this.remoteProfiles
      .filter((p) => p.id !== this.myId)
      .map((p) => {
        const t = tierForRating(p.rating ?? 1000)
        return {
          id: p.id,
          name: p.name,
          self: false,
          aliens: p.aliens,
          level: p.level ?? 1,
          duelTier: t.name,
          duelTierColor: t.color,
          rating: p.rating ?? 1000,
          badges: p.badges ?? 0,
          games: Object.entries(p.games).map(([game, tup]) => ({ game, played: tup[0] ?? 0, won: tup[1] ?? 0, lost: tup[2] ?? 0, best: tup[3] ?? 0 })),
        }
      })
    return [self, ...others]
  }

  dispose() {
    this.net?.close()
    this.net = null
    this.remotePlayers.dispose()
    this.sharedAliens.dispose()
  }
}
