/**
 * Unit 7 — shared-world realtime server (PartyKit).
 *
 * This is NOT part of the game bundle. It deploys separately (`npx partykit
 * deploy`) and the static game (hosted on Netlify) connects to it over a
 * WebSocket. One PartyKit "room" = one shared world; players are identified by
 * the username they send on join.
 *
 * Phase 2: the server is now authoritative over the shared content of the
 * world — a swarm of alien targets and the scoreboard. The server spawns and
 * moves the aliens, everyone sees the same ones, and captures are first-claim-
 * wins: the server decides who netted an alien, removes it for everyone, and
 * awards the score. Player movement is still a relay (clients own their own
 * transform).
 *
 * The client talks to this with a plain browser WebSocket (no extra client
 * dependency in the game), so the wire protocol is just JSON. Keep the message
 * shapes here in sync with `src/game/Net.ts`.
 */
import type * as Party from 'partykit/server'

type Vec3 = [number, number, number]

interface PlayerSnapshot {
  id: string
  name: string
  p: Vec3
  y: number
  m: string
  v: string | null
  z: string
  s: number
  g: boolean
}

interface Alien {
  id: number
  x: number
  y: number
  z: number
  vx: number
  vz: number
  big: boolean
}

/** Compact per-game record on the wire: [played, won, lost, best]. */
type WireGames = Record<string, [number, number, number, number]>

interface Profile {
  aliens: number
  level: number
  rating: number
  badges: number
  games: WireGames
}

type Dir = [number, number]

/** A live, server-authoritative Beam Wars duel between two pilots. */
interface Match {
  id: string
  a: string // challenger connection id (side 'a')
  b: string // opponent connection id (side 'b')
  an: string // names (for the result toast)
  bn: string
  grid: Uint8Array // COLS*ROWS, 0 empty / 1 a-trail / 2 b-trail
  aTrail: number; bTrail: number // each pilot's equipped trail color (hex int)
  ax: number; ay: number; adx: number; ady: number; aAlive: boolean; aq: Dir | null
  bx: number; by: number; bdx: number; bdy: number; bAlive: boolean; bq: Dir | null
  loop: ReturnType<typeof setInterval> | null
}

type ClientMsg =
  | { t: 'join'; name: string }
  | ({ t: 'state' } & Omit<PlayerSnapshot, 'id' | 'name'>)
  | { t: 'capture'; p: Vec3; award: number }
  | { t: 'claim'; id: number }
  | { t: 'profile'; aliens: number; games: WireGames; level?: number; rating?: number; badges?: number }
  | { t: 'challenge'; to: string; trail?: number }
  | { t: 'accept'; from: string; trail?: number }
  | { t: 'decline'; from: string }
  | { t: 'matchDir'; dir: Dir }
  | { t: 'matchQuit' }

export default class WorldServer implements Party.Server {
  static readonly MAX_PLAYERS = 60
  static readonly ALIEN_CAP = 14
  static readonly AREA = 150 // aliens wander within +/- this on x/z
  static readonly TICK_MS = 150 // ~6.7Hz simulation broadcast
  // Live Beam Wars duel arena.
  static readonly BW_COLS = 64
  static readonly BW_ROWS = 40
  static readonly BW_TICK_MS = 92 // beam step (a touch slower than solo for the network)
  static readonly BW_START_MS = 1600 // "get ready" beat before beams start moving

  private players = new Map<string, PlayerSnapshot>()
  private aliens = new Map<number, Alien>()
  private scores = new Map<string, { name: string; score: number }>()
  private profiles = new Map<string, Profile>()
  private nextAlienId = 1
  private tick: ReturnType<typeof setInterval> | null = null
  // Challenge handshakes (challengerId -> {target, trail}) and live matches by id.
  private challenges = new Map<string, { to: string; trail: number }>()
  private matches = new Map<string, Match>()
  private inMatch = new Map<string, string>() // connId -> matchId (busy guard)

  constructor(readonly room: Party.Room) {}

  onClose(conn: Party.Connection) {
    this.players.delete(conn.id)
    this.profiles.delete(conn.id)
    this.challenges.delete(conn.id)
    // If they were mid-duel, the opponent wins by forfeit.
    const mid = this.inMatch.get(conn.id)
    if (mid) this.endMatch(mid, conn.id === this.matches.get(mid)?.a ? 'b' : 'a')
    if (this.scores.delete(conn.id)) {
      this.broadcastScores()
    }
    this.broadcastProfiles()
    this.room.broadcast(JSON.stringify({ t: 'leave', id: conn.id }))
    if (this.scores.size === 0) this.stopSim()
  }

  onError(conn: Party.Connection) {
    this.onClose(conn)
  }

  onMessage(raw: string, sender: Party.Connection) {
    let msg: ClientMsg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.t === 'join') {
      if (this.players.size >= WorldServer.MAX_PLAYERS && !this.players.has(sender.id)) {
        sender.send(JSON.stringify({ t: 'full' }))
        return
      }
      const name = sanitizeName(msg.name)
      this.players.set(sender.id, {
        id: sender.id, name, p: [0, 0, 0], y: 0, m: 'robot', v: null, z: 'earth', s: 0, g: true,
      })
      this.scores.set(sender.id, { name, score: 0 })
      this.profiles.set(sender.id, { aliens: 0, level: 1, rating: 1000, badges: 0, games: {} })
      // Newcomer gets the roster, the live scoreboard, the current swarm and
      // the profiles of everyone already here.
      sender.send(
        JSON.stringify({
          t: 'welcome',
          id: sender.id,
          players: [...this.players.values()].filter((p) => p.id !== sender.id),
          scores: this.boardArray(),
          aliens: this.alienArray(),
          profiles: this.profileArray(),
        }),
      )
      this.room.broadcast(JSON.stringify({ t: 'join', id: sender.id, name }), [sender.id])
      this.broadcastScores()
      this.broadcastProfiles()
      this.startSim()
      return
    }

    if (msg.t === 'profile') {
      if (!this.players.has(sender.id)) return
      this.profiles.set(sender.id, {
        aliens: Math.max(0, msg.aliens | 0),
        level: Math.max(1, Math.min(9999, (msg.level as number) | 0 || 1)),
        rating: Math.max(0, Math.min(99999, (msg.rating as number) | 0 || 1000)),
        badges: Math.max(0, Math.min(999, (msg.badges as number) | 0)),
        games: sanitizeGames(msg.games),
      })
      this.broadcastProfiles()
      return
    }

    if (msg.t === 'challenge') {
      const target = this.players.get(msg.to)
      const me = this.players.get(sender.id)
      // Reject if target is gone, is yourself, or either side is busy.
      if (!target || !me || msg.to === sender.id) return
      if (this.inMatch.has(sender.id) || this.inMatch.has(msg.to)) {
        sender.send(JSON.stringify({ t: 'challengeBusy', name: target.name }))
        return
      }
      this.challenges.set(sender.id, { to: msg.to, trail: colorOf(msg.trail) })
      const conn = this.room.getConnection(msg.to)
      conn?.send(JSON.stringify({ t: 'challenged', from: sender.id, name: me.name }))
      return
    }

    if (msg.t === 'decline') {
      // `from` is the challenger; tell them it was declined and drop the offer.
      if (this.challenges.get(msg.from)?.to === sender.id) {
        this.challenges.delete(msg.from)
        const me = this.players.get(sender.id)
        this.room.getConnection(msg.from)?.send(JSON.stringify({ t: 'challengeDeclined', name: me?.name ?? 'PILOT' }))
      }
      return
    }

    if (msg.t === 'accept') {
      // `from` is the challenger; the sender is the target accepting.
      const offer = this.challenges.get(msg.from)
      if (!offer || offer.to !== sender.id) return
      this.challenges.delete(msg.from)
      if (this.inMatch.has(msg.from) || this.inMatch.has(sender.id)) return
      this.startMatch(msg.from, sender.id, offer.trail, colorOf(msg.trail))
      return
    }

    if (msg.t === 'matchDir') {
      const mid = this.inMatch.get(sender.id)
      if (!mid) return
      const m = this.matches.get(mid)
      if (!m) return
      const dir: Dir = [Math.sign(msg.dir?.[0] ?? 0), Math.sign(msg.dir?.[1] ?? 0)]
      if ((dir[0] === 0) === (dir[1] === 0)) return // exactly one axis must be set
      if (sender.id === m.a) m.aq = dir
      else if (sender.id === m.b) m.bq = dir
      return
    }

    if (msg.t === 'matchQuit') {
      const mid = this.inMatch.get(sender.id)
      if (!mid) return
      const m = this.matches.get(mid)
      if (m) this.endMatch(mid, sender.id === m.a ? 'b' : 'a')
      return
    }

    if (msg.t === 'state') {
      const snap = this.players.get(sender.id)
      if (!snap) return
      snap.p = msg.p; snap.y = msg.y; snap.m = msg.m; snap.v = msg.v; snap.z = msg.z; snap.s = msg.s; snap.g = msg.g
      this.room.broadcast(
        JSON.stringify({ t: 'state', id: sender.id, p: msg.p, y: msg.y, m: msg.m, v: msg.v, z: msg.z, s: msg.s, g: msg.g }),
        [sender.id],
      )
      return
    }

    if (msg.t === 'capture') {
      if (!this.players.has(sender.id)) return
      this.room.broadcast(JSON.stringify({ t: 'capture', id: sender.id, p: msg.p, award: msg.award }), [sender.id])
      return
    }

    if (msg.t === 'claim') {
      const alien = this.aliens.get(msg.id)
      if (!alien) return // already taken by someone else — first claim wins
      this.aliens.delete(alien.id)
      const award = alien.big ? 250 : 120
      const entry = this.scores.get(sender.id)
      if (entry) entry.score += award
      // Tell everyone the alien is gone, who got it, and refresh the board.
      this.room.broadcast(JSON.stringify({ t: 'alienGone', id: alien.id, by: sender.id, award }))
      this.broadcastScores()
      return
    }
  }

  // --- shared-world simulation -------------------------------------------------

  private startSim() {
    if (this.tick) return
    this.fillSwarm()
    this.tick = setInterval(() => this.step(), WorldServer.TICK_MS)
  }

  private stopSim() {
    if (this.tick) {
      clearInterval(this.tick)
      this.tick = null
    }
    this.aliens.clear()
  }

  private step() {
    const dt = WorldServer.TICK_MS / 1000
    const A = WorldServer.AREA
    for (const a of this.aliens.values()) {
      a.x += a.vx * dt
      a.z += a.vz * dt
      // Bounce off the edges of the play area.
      if (a.x < -A || a.x > A) { a.vx *= -1; a.x = Math.max(-A, Math.min(A, a.x)) }
      if (a.z < -A || a.z > A) { a.vz *= -1; a.z = Math.max(-A, Math.min(A, a.z)) }
    }
    // Drip new aliens back up to the cap so the world is never empty.
    if (this.aliens.size < WorldServer.ALIEN_CAP && Math.random() < 0.25) this.spawnAlien()
    this.room.broadcast(JSON.stringify({ t: 'aliens', list: this.alienArray() }))
  }

  private fillSwarm() {
    while (this.aliens.size < WorldServer.ALIEN_CAP) this.spawnAlien()
  }

  private spawnAlien() {
    const A = WorldServer.AREA
    const id = this.nextAlienId++
    const ang = Math.random() * Math.PI * 2
    const spd = 1.5 + Math.random() * 2.5
    this.aliens.set(id, {
      id,
      x: (Math.random() * 2 - 1) * A,
      y: 1.0,
      z: (Math.random() * 2 - 1) * A,
      vx: Math.cos(ang) * spd,
      vz: Math.sin(ang) * spd,
      big: Math.random() < 0.18,
    })
  }

  private alienArray(): [number, number, number, number, number][] {
    // [id, x, y, z, big?1:0]
    return [...this.aliens.values()].map((a) => [a.id, round(a.x), a.y, round(a.z), a.big ? 1 : 0])
  }

  private boardArray(): { name: string; score: number }[] {
    return [...this.scores.values()].sort((a, b) => b.score - a.score)
  }

  private broadcastScores() {
    this.room.broadcast(JSON.stringify({ t: 'scores', board: this.boardArray() }))
  }

  // --- live Beam Wars duels ----------------------------------------------------

  private startMatch(aId: string, bId: string, aTrail = 0x27e7ff, bTrail = 0xff2bd0) {
    const C = WorldServer.BW_COLS
    const R = WorldServer.BW_ROWS
    const grid = new Uint8Array(C * R)
    const ax = Math.floor(C * 0.22), ay = Math.floor(R / 2)
    const bx = Math.floor(C * 0.78), by = Math.floor(R / 2)
    grid[ay * C + ax] = 1
    grid[by * C + bx] = 2
    const id = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
    const m: Match = {
      id, a: aId, b: bId,
      an: this.players.get(aId)?.name ?? 'PILOT',
      bn: this.players.get(bId)?.name ?? 'PILOT',
      grid, aTrail, bTrail,
      ax, ay, adx: 1, ady: 0, aAlive: true, aq: null,
      bx, by, bdx: -1, bdy: 0, bAlive: true, bq: null,
      loop: null,
    }
    this.matches.set(id, m)
    this.inMatch.set(aId, id)
    this.inMatch.set(bId, id)
    // Each side learns which beam is theirs, who they face (id for rematch), both
    // start cells, and both trail colors.
    const base = { cols: C, rows: R, a: [ax, ay], b: [bx, by], trailA: aTrail, trailB: bTrail, startIn: WorldServer.BW_START_MS }
    this.room.getConnection(aId)?.send(JSON.stringify({ t: 'matchStart', side: 'a', opp: m.bn, oppId: bId, ...base }))
    this.room.getConnection(bId)?.send(JSON.stringify({ t: 'matchStart', side: 'b', opp: m.an, oppId: aId, ...base }))
    // Begin stepping after the "get ready" beat.
    setTimeout(() => {
      if (this.matches.get(id) !== m) return
      m.loop = setInterval(() => this.stepMatch(m), WorldServer.BW_TICK_MS)
    }, WorldServer.BW_START_MS)
  }

  private stepMatch(m: Match) {
    const C = WorldServer.BW_COLS
    const R = WorldServer.BW_ROWS
    // Apply queued turns (no reversing straight back into your own trail).
    if (m.aq && !(m.aq[0] === -m.adx && m.aq[1] === -m.ady)) { m.adx = m.aq[0]; m.ady = m.aq[1] }
    if (m.bq && !(m.bq[0] === -m.bdx && m.bq[1] === -m.bdy)) { m.bdx = m.bq[0]; m.bdy = m.bq[1] }
    m.aq = null; m.bq = null
    const anx = m.ax + m.adx, any = m.ay + m.ady
    const bnx = m.bx + m.bdx, bny = m.by + m.bdy
    const aHit = anx < 0 || anx >= C || any < 0 || any >= R || m.grid[any * C + anx] !== 0
    const bHit = bnx < 0 || bnx >= C || bny < 0 || bny >= R || m.grid[bny * C + bnx] !== 0
    const headOn = anx === bnx && any === bny
    let aDead = aHit || headOn
    let bDead = bHit || headOn
    if (!aDead) { m.grid[any * C + anx] = 1; m.ax = anx; m.ay = any }
    if (!bDead) { m.grid[bny * C + bnx] = 2; m.bx = bnx; m.by = bny }
    m.aAlive = !aDead
    m.bAlive = !bDead
    this.matchTick(m)
    if (aDead || bDead) {
      this.endMatch(m.id, aDead && bDead ? 'draw' : aDead ? 'b' : 'a')
    }
  }

  private matchTick(m: Match) {
    const payload = JSON.stringify({ t: 'matchTick', a: [m.ax, m.ay], b: [m.bx, m.by], aAlive: m.aAlive, bAlive: m.bAlive })
    this.room.getConnection(m.a)?.send(payload)
    this.room.getConnection(m.b)?.send(payload)
  }

  private endMatch(id: string, winner: 'a' | 'b' | 'draw') {
    const m = this.matches.get(id)
    if (!m) return
    if (m.loop) clearInterval(m.loop)
    this.matches.delete(id)
    this.inMatch.delete(m.a)
    this.inMatch.delete(m.b)
    const payload = JSON.stringify({ t: 'matchEnd', winner })
    this.room.getConnection(m.a)?.send(payload)
    this.room.getConnection(m.b)?.send(payload)
  }

  private profileArray(): { id: string; name: string; aliens: number; level: number; rating: number; badges: number; games: WireGames }[] {
    const out: { id: string; name: string; aliens: number; level: number; rating: number; badges: number; games: WireGames }[] = []
    for (const [id, prof] of this.profiles) {
      const player = this.players.get(id)
      if (!player) continue
      out.push({ id, name: player.name, aliens: prof.aliens, level: prof.level, rating: prof.rating, badges: prof.badges, games: prof.games })
    }
    return out
  }

  private broadcastProfiles() {
    this.room.broadcast(JSON.stringify({ t: 'profiles', list: this.profileArray() }))
  }
}

/** Clamp incoming profile games to a sane, bounded shape (avoid abuse / bloat). */
function sanitizeGames(raw: unknown): WireGames {
  const out: WireGames = {}
  if (!raw || typeof raw !== 'object') return out
  let n = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n++ >= 24) break
    if (!Array.isArray(v)) continue
    const key = String(k).replace(/[^\w]/g, '').slice(0, 16)
    if (!key) continue
    out[key] = [num(v[0]), num(v[1]), num(v[2]), num(v[3])]
  }
  return out
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.min(1e7, Math.floor(n)) : 0
}

/** Clamp an incoming trail color to a valid 24-bit hex int (default cyan). */
function colorOf(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 0xffffff ? Math.floor(n) : 0x27e7ff
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function sanitizeName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : ''
  const cleaned = s
    .replace(/[^\w \-_.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16)
  return cleaned || 'PILOT'
}
