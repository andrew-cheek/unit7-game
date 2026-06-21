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

type ClientMsg =
  | { t: 'join'; name: string }
  | ({ t: 'state' } & Omit<PlayerSnapshot, 'id' | 'name'>)
  | { t: 'capture'; p: Vec3; award: number }
  | { t: 'claim'; id: number }

export default class WorldServer implements Party.Server {
  static readonly MAX_PLAYERS = 60
  static readonly ALIEN_CAP = 14
  static readonly AREA = 150 // aliens wander within +/- this on x/z
  static readonly TICK_MS = 150 // ~6.7Hz simulation broadcast

  private players = new Map<string, PlayerSnapshot>()
  private aliens = new Map<number, Alien>()
  private scores = new Map<string, { name: string; score: number }>()
  private nextAlienId = 1
  private tick: ReturnType<typeof setInterval> | null = null

  constructor(readonly room: Party.Room) {}

  onClose(conn: Party.Connection) {
    this.players.delete(conn.id)
    if (this.scores.delete(conn.id)) {
      this.broadcastScores()
    }
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
      // Newcomer gets the roster, the live scoreboard and the current swarm.
      sender.send(
        JSON.stringify({
          t: 'welcome',
          id: sender.id,
          players: [...this.players.values()].filter((p) => p.id !== sender.id),
          scores: this.boardArray(),
          aliens: this.alienArray(),
        }),
      )
      this.room.broadcast(JSON.stringify({ t: 'join', id: sender.id, name }), [sender.id])
      this.broadcastScores()
      this.startSim()
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
