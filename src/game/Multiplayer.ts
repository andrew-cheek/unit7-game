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
import type { ChatMessage, FilterVerdict } from './kidShared'

// Beam Wars duel grid + cadence — mirrors the server (party/server.ts) so a solo
// AI duel plays identically to a networked one.
const BW_COLS = 64
const BW_ROWS = 40
const BW_TICK_MS = 92
const BW_START_MS = 1600

type Dir = [number, number]

/** Local Beam Wars sim state for a solo duel vs an AI (beam A = you, beam B = AI). */
interface LocalDuel {
  grid: Uint8Array // BW_COLS*BW_ROWS, 0 empty / 1 a-trail / 2 b-trail
  ax: number; ay: number; adx: number; ady: number; aAlive: boolean; aq: Dir | null
  bx: number; by: number; bdx: number; bdy: number; bAlive: boolean
}

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
  /** A relayed, already-filtered chat line from another pilot (or self echo). The
   *  host decides whether to surface it per the local parental chat setting. */
  onChat(msg: ChatMessage): void
  /** Our outgoing line was filtered out server-side (gentle "keep it friendly" hint). */
  onChatBlocked?(reason: FilterVerdict['reason']): void
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
  // Solo duel against an AI pilot: a local Beam Wars sim that drives the SAME
  // matchView the networked duel uses, so the BeamWarsLive UI + scoring are shared.
  private local: LocalDuel | null = null
  private localLoop: ReturnType<typeof setInterval> | null = null
  private localStartTimer: ReturnType<typeof setTimeout> | null = null
  private netAccum = 0
  // Deferred profile-publish timers (connect + every reconnect). Tracked so
  // dispose() can cancel them and not fire publishProfile() after teardown.
  private publishTimers = new Set<ReturnType<typeof setTimeout>>()

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

  /** Send a chat line to the room. The server re-filters + rate-limits it and
   *  relays the cleaned text; no-ops cleanly when playing solo. */
  sendChat(text: string) {
    this.net?.sendChat(text)
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
    if (this.net) { this.net.sendChallenge(id, trail); return }
    // Solo: duel a local AI pilot (the roster bots use ids of the form "bot:NAME").
    if (this.matchView) return
    const name = id.startsWith('bot:') ? id.slice(4) : 'RIVAL'
    this.startLocalDuel(name, id, trail || 0x27e7ff)
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
    if (this.local) {
      const d: Dir = [Math.sign(dx), Math.sign(dy)]
      if ((d[0] === 0) !== (d[1] === 0) && this.local.aAlive) this.local.aq = d // exactly one axis
      return
    }
    this.net?.sendMatchDir(dx, dy)
  }
  /** Leave the live duel: forfeit if still running, then hand control back. */
  leaveMatch() {
    if (!this.matchView) return
    if (this.local) this.stopLocal()
    else if (this.matchView.status !== 'over') this.net?.sendMatchQuit()
    this.matchView = null
    this.host.consumePause() // drop any Escape pressed inside the duel view
    this.host.setInputLock(true)
  }
  /** Leave the current duel and immediately re-challenge the same opponent. */
  rematch(trail: number) {
    const oppId = this.matchView?.oppId
    const oppName = this.matchView?.opp ?? 'RIVAL'
    const wasLocal = !!this.local || !this.net
    this.leaveMatch()
    if (!oppId) return
    if (wasLocal) this.startLocalDuel(oppName, oppId, trail || 0x27e7ff)
    else this.net?.sendChallenge(oppId, trail)
  }

  // --- solo AI duel (local Beam Wars) ----------------------------------------

  private stopLocal() {
    if (this.localLoop) { clearInterval(this.localLoop); this.localLoop = null }
    if (this.localStartTimer) { clearTimeout(this.localStartTimer); this.localStartTimer = null }
    this.local = null
  }

  /** Spin up a local Beam Wars duel against an AI pilot. You are beam A (left,
   *  heading right); the AI is beam B. Start cells/headings match the server. */
  private startLocalDuel(oppName: string, oppId: string, myTrail: number) {
    this.stopLocal()
    const C = BW_COLS, R = BW_ROWS
    const grid = new Uint8Array(C * R)
    const ax = Math.floor(C * 0.22), ay = Math.floor(R / 2)
    const bx = Math.floor(C * 0.78), by = Math.floor(R / 2)
    grid[ay * C + ax] = 1
    grid[by * C + bx] = 2
    this.local = { grid, ax, ay, adx: 1, ady: 0, aAlive: true, aq: null, bx, by, bdx: -1, bdy: 0, bAlive: true }
    const oppTrail = 0xff2bd0 // the rival's beam color
    this.host.warpRevert() // duels are robot-only
    this.incomingChallenge = null
    this.matchView = {
      side: 'a', opp: oppName, oppId, cols: C, rows: R,
      a: [ax, ay], b: [bx, by], aAlive: true, bAlive: true, status: 'ready', winner: null, seq: 0,
      trailA: myTrail, trailB: oppTrail, result: null,
    }
    this.host.setInputLock(false)
    this.host.play('ui')
    // Begin stepping after the same "get ready" beat the server uses.
    this.localStartTimer = setTimeout(() => {
      this.localStartTimer = null
      if (!this.local) return
      this.localLoop = setInterval(() => this.stepLocal(), BW_TICK_MS)
    }, BW_START_MS)
  }

  private stepLocal() {
    const L = this.local, m = this.matchView
    if (!L || !m) return
    const C = BW_COLS, R = BW_ROWS
    // AI picks beam B's turn (avoids walls/trails, heads for the most open space).
    const ai = this.aiTurn(L)
    if (ai && !(ai[0] === -L.bdx && ai[1] === -L.bdy)) { L.bdx = ai[0]; L.bdy = ai[1] }
    // Your queued turn (no reversing straight back into your own trail).
    if (L.aq && !(L.aq[0] === -L.adx && L.aq[1] === -L.ady)) { L.adx = L.aq[0]; L.ady = L.aq[1] }
    L.aq = null
    const anx = L.ax + L.adx, any = L.ay + L.ady
    const bnx = L.bx + L.bdx, bny = L.by + L.bdy
    const aHit = anx < 0 || anx >= C || any < 0 || any >= R || L.grid[any * C + anx] !== 0
    const bHit = bnx < 0 || bnx >= C || bny < 0 || bny >= R || L.grid[bny * C + bnx] !== 0
    const headOn = anx === bnx && any === bny
    const aDead = aHit || headOn
    const bDead = bHit || headOn
    if (!aDead) { L.grid[any * C + anx] = 1; L.ax = anx; L.ay = any }
    if (!bDead) { L.grid[bny * C + bnx] = 2; L.bx = bnx; L.by = bny }
    L.aAlive = !aDead; L.bAlive = !bDead
    m.a = [L.ax, L.ay]; m.b = [L.bx, L.by]; m.aAlive = L.aAlive; m.bAlive = L.bAlive
    if (m.status === 'ready') m.status = 'play'
    m.seq += 1
    if (aDead || bDead) this.endLocal(aDead && bDead ? 'draw' : aDead ? 'b' : 'a')
  }

  /** Resolve a finished local duel: same scoring/rewards as a networked match. */
  private endLocal(winner: 'a' | 'b' | 'draw') {
    if (this.localLoop) { clearInterval(this.localLoop); this.localLoop = null }
    this.local = null
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
      this.host.awardXp(20)
    }
    this.host.refreshProgression()
    this.publishProfile()
  }

  /** A decently-skilled light-cycle AI: among the non-reversing moves, keep only
   *  the survivable ones, then prefer the one that leaves the most reachable open
   *  space (a bounded flood fill), with a small bias to keep going straight and a
   *  dash of randomness so it's competent but beatable. */
  private aiTurn(L: LocalDuel): Dir | null {
    const C = BW_COLS, R = BW_ROWS
    const cands: Dir[] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    let best: Dir | null = null
    let bestScore = -1
    for (const d of cands) {
      if (d[0] === -L.bdx && d[1] === -L.bdy) continue // no reversing
      const nx = L.bx + d[0], ny = L.by + d[1]
      if (nx < 0 || nx >= C || ny < 0 || ny >= R || L.grid[ny * C + nx] !== 0) continue // instant death
      let score = this.floodArea(L.grid, nx, ny)
      if (d[0] === L.bdx && d[1] === L.bdy) score += 4 // smoother: lean toward straight
      score += Math.random() * 8 // imperfect, so a sharp player can out-box it
      if (score > bestScore) { bestScore = score; best = d }
    }
    return best
  }

  /** Bounded BFS count of empty cells reachable from (sx,sy) — the AI's "how much
   *  room does this move leave me" heuristic. Capped so it stays cheap at 11Hz. */
  private floodArea(grid: Uint8Array, sx: number, sy: number): number {
    const C = BW_COLS, R = BW_ROWS
    const CAP = 160
    const seen = new Set<number>()
    const queue: number[] = [sy * C + sx]
    seen.add(queue[0])
    let count = 0
    for (let qi = 0; qi < queue.length && count < CAP; qi++) {
      const cell = queue[qi]
      count++
      const cx = cell % C, cy = (cell / C) | 0
      const nbrs = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]
      for (const [nx, ny] of nbrs) {
        if (nx < 0 || nx >= C || ny < 0 || ny >= R) continue
        const ni = ny * C + nx
        if (seen.has(ni) || grid[ni] !== 0) continue
        seen.add(ni)
        queue.push(ni)
      }
    }
    return count
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
          if (!connected) {
            this.online = this.remotePlayers.count + 1
            // The drop invalidates any pending duel UI: clear a stale incoming
            // challenge and leave a frozen match so the HUD doesn't show offline
            // challenges or a match that can no longer receive ticks.
            this.incomingChallenge = null
            if (this.matchView) this.leaveMatch()
          }
          // Re-publish our profile after every (re)connect so a reconnected
          // avatar gets re-tinted/labelled (the join is sent first, so defer
          // briefly to let the server register us before the profile lands).
          else this.deferPublish(300)
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
        onChat: (m) => this.host.onChat(m),
        onChatBlocked: (r) => this.host.onChatBlocked?.(r),
      },
      { host: serverHost },
    )
    // Publish shortly after connecting (lets the socket open + the server register us).
    this.deferPublish(800)
  }

  /** Schedule a profile publish, tracking the timer so dispose() can cancel it. */
  private deferPublish(ms: number) {
    const t = setTimeout(() => {
      this.publishTimers.delete(t)
      this.publishProfile()
    }, ms)
    this.publishTimers.add(t)
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
    // Cancel any deferred publish so it can't fire after teardown.
    for (const t of this.publishTimers) clearTimeout(t)
    this.publishTimers.clear()
    this.stopLocal() // cancel any live solo-duel timers
    this.net?.close()
    this.net = null
    this.remotePlayers.dispose()
    this.sharedAliens.dispose()
  }
}
