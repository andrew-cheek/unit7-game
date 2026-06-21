/**
 * Unit 7 — shared-world realtime server (PartyKit).
 *
 * This is NOT part of the game bundle. It deploys separately (`npx partykit
 * deploy`) and the static game (hosted on Netlify) connects to it over a
 * WebSocket. One PartyKit "room" = one shared world; players are identified by
 * the username they send on join.
 *
 * It is a light authoritative relay: it keeps the latest snapshot of every
 * connected player so a newcomer can be told who is already in the world, and
 * it forwards movement + interaction events between everyone. It does not own
 * gameplay entities (aliens, score) yet — that is the next phase.
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
  p: Vec3 // position
  y: number // yaw (radians)
  m: string // player mode: robot | plane | parachute | vehicle
  v: string | null // vehicle kind when piloting, else null
  z: string // zone: earth | mars | moon
  s: number // speed 0..1 (drives remote walk/run animation)
  g: boolean // grounded
}

// Messages the client sends us.
type ClientMsg =
  | { t: 'join'; name: string }
  | ({ t: 'state' } & Omit<PlayerSnapshot, 'id' | 'name'>)
  | { t: 'capture'; p: Vec3; award: number }

export default class WorldServer implements Party.Server {
  // Cap so one room can't be flooded; extra joins are politely refused.
  static readonly MAX_PLAYERS = 60

  private players = new Map<string, PlayerSnapshot>()

  constructor(readonly room: Party.Room) {}

  onClose(conn: Party.Connection) {
    if (this.players.delete(conn.id)) {
      this.room.broadcast(JSON.stringify({ t: 'leave', id: conn.id }))
    }
  }

  onError(conn: Party.Connection) {
    this.onClose(conn)
  }

  onMessage(raw: string, sender: Party.Connection) {
    let msg: ClientMsg
    try {
      msg = JSON.parse(raw)
    } catch {
      return // ignore malformed input
    }

    if (msg.t === 'join') {
      if (this.players.size >= WorldServer.MAX_PLAYERS && !this.players.has(sender.id)) {
        sender.send(JSON.stringify({ t: 'full' }))
        return
      }
      const name = sanitizeName(msg.name)
      const snap: PlayerSnapshot = {
        id: sender.id,
        name,
        p: [0, 0, 0],
        y: 0,
        m: 'robot',
        v: null,
        z: 'earth',
        s: 0,
        g: true,
      }
      this.players.set(sender.id, snap)
      // Tell the newcomer who is already here (everyone but themselves).
      sender.send(
        JSON.stringify({
          t: 'welcome',
          id: sender.id,
          players: [...this.players.values()].filter((p) => p.id !== sender.id),
        }),
      )
      // Tell everyone else a player joined.
      this.room.broadcast(JSON.stringify({ t: 'join', id: sender.id, name }), [sender.id])
      return
    }

    if (msg.t === 'state') {
      const snap = this.players.get(sender.id)
      if (!snap) return // must join first
      snap.p = msg.p
      snap.y = msg.y
      snap.m = msg.m
      snap.v = msg.v
      snap.z = msg.z
      snap.s = msg.s
      snap.g = msg.g
      // Relay the transform to everyone else, tagged with who sent it.
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
  }
}

function sanitizeName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : ''
  // Keep letters, numbers, spaces and a few separators; drop control chars and
  // markup so a name can't break the rendered name tag. Cap the length.
  const cleaned = s
    .replace(/[^\w \-_.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16)
  return cleaned || 'PILOT'
}
