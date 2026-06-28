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
  accent: number
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
  startTimer: ReturnType<typeof setTimeout> | null
}

type ClientMsg =
  | { t: 'join'; name: string; uid?: string }
  | ({ t: 'state' } & Omit<PlayerSnapshot, 'id' | 'name'>)
  | { t: 'capture'; p: Vec3; award: number }
  | { t: 'claim'; id: number }
  | { t: 'profile'; aliens: number; games: WireGames; level?: number; rating?: number; badges?: number; accent?: number }
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
  static readonly MAX_MSG_BYTES = 8192 // reject oversized inbound frames before parsing
  static readonly IDLE_TIMEOUT_MS = 30000 // reap players we haven't heard from in 30s
  static readonly REAP_MS = 10000 // stale-player sweep cadence
  static readonly MAX_STRIKES = 6 // boot a connection after this many clearly-malicious frames
  // Message types no honest client ever sends. Probing for any of these is the
  // tell of someone fishing for a cheat backdoor, so each one earns a strike.
  static readonly HONEYPOT = new Set(['admin', 'godmode', 'setscore', 'set_score', 'give_credits', 'op', 'cheat'])

  private players = new Map<string, PlayerSnapshot>()
  private aliens = new Map<number, Alien>()
  private scores = new Map<string, { name: string; score: number }>()
  private profiles = new Map<string, Profile>()
  private nextAlienId = 1
  private tick: ReturnType<typeof setInterval> | null = null
  private reaper: ReturnType<typeof setInterval> | null = null
  // Per-connection liveness + token-bucket rate limiting (anti-flood / anti-ghost).
  private lastSeen = new Map<string, number>()
  private buckets = new Map<string, { state: number; profile: number; misc: number; ts: number }>()
  // Per-connection strike count for clearly-hostile frames (oversized, garbage
  // JSON, no/invalid type, or a honeypot probe). Separate from flood control:
  // these aren't "too many" messages, they're the wrong kind entirely.
  private strikes = new Map<string, number>()
  // Stable client identity (persisted client-side) so a reconnecting player
  // reclaims their score row instead of duplicating it.
  private connUid = new Map<string, string>() // conn.id -> client uid
  private uidConn = new Map<string, string>() // client uid -> current conn.id
  // Challenge handshakes (challengerId -> {target, trail}) and live matches by id.
  private challenges = new Map<string, { to: string; trail: number }>()
  private matches = new Map<string, Match>()
  private inMatch = new Map<string, string>() // connId -> matchId (busy guard)

  constructor(readonly room: Party.Room) {}

  onClose(conn: Party.Connection) {
    this.removePlayer(conn.id)
  }

  onError(conn: Party.Connection) {
    this.removePlayer(conn.id)
  }

  /** Fully evict a player by connection id. Called on close/error AND by the
   *  stale-player sweep (for clients that vanish without a clean WS close). */
  private removePlayer(id: string) {
    this.players.delete(id)
    this.profiles.delete(id)
    this.lastSeen.delete(id)
    this.buckets.delete(id)
    this.strikes.delete(id)
    const uid = this.connUid.get(id)
    if (uid && this.uidConn.get(uid) === id) this.uidConn.delete(uid)
    this.connUid.delete(id)
    // Drop any pending challenge this player owned, and any challenge aimed *at*
    // them (otherwise a stale offer keeps the challenger flagged as busy).
    this.challenges.delete(id)
    for (const [from, offer] of this.challenges) {
      if (offer.to === id) this.challenges.delete(from)
    }
    // If they were mid-duel, the opponent wins by forfeit.
    const mid = this.inMatch.get(id)
    if (mid) this.endMatch(mid, id === this.matches.get(mid)?.a ? 'b' : 'a')
    if (this.scores.delete(id)) {
      this.broadcastScores()
    }
    this.broadcastProfiles()
    this.room.broadcast(JSON.stringify({ t: 'leave', id }))
    if (this.scores.size === 0) this.stopSim()
  }

  /** Token-bucket rate limit per connection + message class, so one socket can't
   *  flood the room (each state/profile triggers a full broadcast). Returns false
   *  to silently drop the message. */
  private allow(id: string, kind: 'state' | 'profile' | 'misc'): boolean {
    const now = Date.now()
    let b = this.buckets.get(id)
    if (!b) { b = { state: 30, profile: 5, misc: 40, ts: now }; this.buckets.set(id, b) }
    const dt = Math.max(0, (now - b.ts) / 1000)
    b.ts = now
    b.state = Math.min(30, b.state + dt * 20) // ~20/s sustained (client sends ~12/s)
    b.profile = Math.min(5, b.profile + dt * 3) // ~3/s sustained
    b.misc = Math.min(40, b.misc + dt * 30) // join/claim/challenge/duel input
    if (b[kind] < 1) return false
    b[kind] -= 1
    return true
  }

  /** Record one strike against a connection for a clearly-malicious frame. Once a
   *  socket trips MAX_STRIKES it gets shown the door and fully evicted. Returns
   *  true if the connection was booted (caller should stop touching it). */
  private strike(id: string, sender?: Party.Connection): boolean {
    const n = (this.strikes.get(id) ?? 0) + 1
    this.strikes.set(id, n)
    if (n < WorldServer.MAX_STRIKES) return false
    // Six probes in, we stop being polite. Close the socket (no-op if it already
    // hung up) and tear the player down.
    try { (sender ?? this.room.getConnection(id))?.close() } catch { /* already closed */ }
    this.removePlayer(id)
    return true
  }

  /** Evict players we haven't heard from within IDLE_TIMEOUT_MS - backstops every
   *  case where onClose/onError doesn't fire (backgrounded mobile, dropped TCP). */
  private sweepIdle() {
    const now = Date.now()
    for (const id of [...this.players.keys()]) {
      if (now - (this.lastSeen.get(id) ?? 0) > WorldServer.IDLE_TIMEOUT_MS) {
        try { this.room.getConnection(id)?.close() } catch { /* already gone */ }
        this.removePlayer(id)
      }
    }
  }

  onMessage(raw: string, sender: Party.Connection) {
    // So you opened the WebSocket in devtools and started typing JSON at it. Bold.
    // Heads up before you waste an afternoon: there's no admin command, the aliens
    // can't be bribed, and "t":"give_me_credits" just gets dropped on the floor a
    // few lines down. The username field is the only place you can be creative and
    // even that gets sanitized. Go beat my high score the honest way.
    // Reject oversized frames before parsing (cheap DoS guard) — and count it as a
    // strike, since well-behaved clients never send 8KB+ frames.
    if (typeof raw !== 'string' || raw.length > WorldServer.MAX_MSG_BYTES) { this.strike(sender.id, sender); return }
    let msg: ClientMsg
    try {
      msg = JSON.parse(raw)
    } catch {
      // Garbage that isn't even JSON is a strike, not an honest hiccup.
      this.strike(sender.id, sender)
      return
    }
    if (typeof msg !== 'object' || msg === null || typeof (msg as { t?: unknown }).t !== 'string') { this.strike(sender.id, sender); return }
    // Honeypot tripwire: these message types exist nowhere in the real client.
    // Anyone sending one is fishing for a backdoor, so strike and drop on the floor.
    if (WorldServer.HONEYPOT.has(msg.t.toLowerCase())) {
      console.log(`[honeypot] ${sender.id} probed for "${msg.t}"`)
      this.strike(sender.id, sender)
      return
    }
    // Liveness + per-connection flood control.
    this.lastSeen.set(sender.id, Date.now())
    const kind = msg.t === 'state' ? 'state' : msg.t === 'profile' ? 'profile' : 'misc'
    if (!this.allow(sender.id, kind)) return

    if (msg.t === 'join') {
      // Reclaim a stale ghost from this client's previous connection (same uid):
      // carry its score over so a reconnect doesn't reset to 0 or duplicate a row.
      const uid = typeof msg.uid === 'string' ? msg.uid.replace(/[^\w-]/g, '').slice(0, 40) : ''
      let carriedScore = 0
      if (uid) {
        const prev = this.uidConn.get(uid)
        if (prev && prev !== sender.id && this.players.has(prev)) {
          carriedScore = this.scores.get(prev)?.score ?? 0
          try { this.room.getConnection(prev)?.close() } catch { /* already gone */ }
          this.removePlayer(prev)
        }
      }
      if (this.players.size >= WorldServer.MAX_PLAYERS && !this.players.has(sender.id)) {
        sender.send(JSON.stringify({ t: 'full' }))
        return
      }
      const name = sanitizeName(msg.name)
      this.players.set(sender.id, {
        id: sender.id, name, p: [0, 0, 0], y: 0, m: 'robot', v: null, z: 'earth', s: 0, g: true,
      })
      this.scores.set(sender.id, { name, score: carriedScore })
      if (uid) { this.connUid.set(sender.id, uid); this.uidConn.set(uid, sender.id) }
      this.profiles.set(sender.id, { aliens: 0, level: 1, rating: 1000, badges: 0, accent: 0x27e7ff, games: {} })
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
      // These are vanity stats for the pilots roster, not the authoritative
      // scoreboard — but a client can still lie about them, so clamp every number
      // into a sane finite range (NaN/Infinity fall back to the floor).
      this.profiles.set(sender.id, {
        aliens: Math.floor(clampFinite(msg.aliens, 0, 100000, 0)),
        level: Math.floor(clampFinite(msg.level, 0, 999, 1)),
        rating: Math.floor(clampFinite(msg.rating, 0, 100000, 1000)),
        badges: Math.floor(clampFinite(msg.badges, 0, 1000, 0)),
        accent: colorOf(msg.accent),
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
      // Validate/clamp before trusting client transform: reject non-finite or
      // wildly out-of-bounds positions so one bad/hostile client can't poison the
      // relay (NaN propagating into everyone's scene, teleport spam, etc.).
      const p = vec3(msg.p)
      if (!p) return
      snap.p = p
      snap.y = clampFinite(msg.y, -Math.PI * 2, Math.PI * 2, 0)
      snap.m = tag(msg.m, 'robot')
      snap.v = msg.v == null ? null : tag(msg.v, 'car')
      snap.z = tag(msg.z, 'earth')
      snap.s = clampFinite(msg.s, 0, 1e4, 0)
      snap.g = !!msg.g
      this.room.broadcast(
        JSON.stringify({ t: 'state', id: sender.id, p: snap.p, y: snap.y, m: snap.m, v: snap.v, z: snap.z, s: snap.s, g: snap.g }),
        [sender.id],
      )
      return
    }

    if (msg.t === 'capture') {
      if (!this.players.has(sender.id)) return
      // Validate the FX position (clients ignore `award`, so don't forward it).
      const cp = vec3(msg.p)
      if (!cp) return
      this.room.broadcast(JSON.stringify({ t: 'capture', id: sender.id, p: cp }), [sender.id])
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
    this.reaper = setInterval(() => this.sweepIdle(), WorldServer.REAP_MS)
  }

  private stopSim() {
    if (this.tick) {
      clearInterval(this.tick)
      this.tick = null
    }
    if (this.reaper) {
      clearInterval(this.reaper)
      this.reaper = null
    }
    this.nextAlienId = 1
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
      startTimer: null,
    }
    this.matches.set(id, m)
    this.inMatch.set(aId, id)
    this.inMatch.set(bId, id)
    // Each side learns which beam is theirs, who they face (id for rematch), both
    // start cells, and both trail colors.
    const base = { cols: C, rows: R, a: [ax, ay], b: [bx, by], trailA: aTrail, trailB: bTrail, startIn: WorldServer.BW_START_MS }
    this.room.getConnection(aId)?.send(JSON.stringify({ t: 'matchStart', side: 'a', opp: m.bn, oppId: bId, ...base }))
    this.room.getConnection(bId)?.send(JSON.stringify({ t: 'matchStart', side: 'b', opp: m.an, oppId: aId, ...base }))
    // Begin stepping after the "get ready" beat. Track the handle so a forfeit
    // during the beat (endMatch) cancels it instead of starting a loop for a
    // match that no longer exists.
    m.startTimer = setTimeout(() => {
      m.startTimer = null
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
    if (m.startTimer) clearTimeout(m.startTimer)
    this.matches.delete(id)
    this.inMatch.delete(m.a)
    this.inMatch.delete(m.b)
    const payload = JSON.stringify({ t: 'matchEnd', winner })
    this.room.getConnection(m.a)?.send(payload)
    this.room.getConnection(m.b)?.send(payload)
  }

  private profileArray(): { id: string; name: string; aliens: number; level: number; rating: number; badges: number; accent: number; games: WireGames }[] {
    const out: { id: string; name: string; aliens: number; level: number; rating: number; badges: number; accent: number; games: WireGames }[] = []
    for (const [id, prof] of this.profiles) {
      const player = this.players.get(id)
      if (!player) continue
      out.push({ id, name: player.name, aliens: prof.aliens, level: prof.level, rating: prof.rating, badges: prof.badges, accent: prof.accent, games: prof.games })
    }
    return out
  }

  private broadcastProfiles() {
    this.room.broadcast(JSON.stringify({ t: 'profiles', list: this.profileArray() }))
  }
}

/** Clamp incoming profile games to a sane, bounded shape (avoid abuse / bloat). */
function sanitizeGames(raw: unknown): WireGames {
  // Null-prototype target so a key like "__proto__" becomes a plain own property
  // instead of touching the prototype chain (prototype-pollution safety).
  const out = Object.create(null) as WireGames
  if (!raw || typeof raw !== 'object') return out
  let n = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n++ >= 24) break
    if (!Array.isArray(v)) continue
    const key = String(k).replace(/[^\w]/g, '').slice(0, 16)
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') continue
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

/** A finite number clamped to [lo, hi], else the fallback. */
function clampFinite(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

/** Validate a wire Vec3: all-finite and within the world bounds, else null. */
function vec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null
  const LIMIT = 1e5 // generous: covers Earth/Moon/Mars zones, rejects garbage
  const out: number[] = []
  for (const c of v) {
    const n = Number(c)
    if (!Number.isFinite(n) || Math.abs(n) > LIMIT) return null
    out.push(n)
  }
  return out as Vec3
}

/** Short, safe enum-ish string tag (model/vehicle/zone id) with a fallback. */
function tag(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.replace(/[^\w-]/g, '').slice(0, 16) : ''
  return s || fallback
}

function sanitizeName(raw: unknown): string {
  // Yes, this is where your "'); DROP TABLE pilots; --" goes to die. There's no
  // table either. It's a Map. In RAM. On a server that forgets everything when it
  // naps. You named yourself "PILOT" and you're going to like it.
  const s = typeof raw === 'string' ? raw : ''
  const cleaned = s
    .replace(/[^\w \-_.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16)
  return cleaned || 'PILOT'
}
