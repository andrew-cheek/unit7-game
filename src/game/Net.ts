// Client networking for shared-world multiplayer.
//
// Talks to the PartyKit server (party/server.ts) with a plain browser
// WebSocket, so the game bundle gains no extra runtime dependency. PartyKit
// rooms are reachable at `<proto>://<host>/parties/main/<room>`. Keep the
// message shapes in sync with the server.

import type { PlayerMode, Zone } from './types'
import type { ChatMessage, FilterVerdict } from './kidShared'

export type NetVec3 = [number, number, number]

/** Local player state we send up ~12x/sec. */
export interface NetState {
  p: NetVec3
  y: number
  m: PlayerMode
  v: string | null
  z: Zone
  s: number
  g: boolean
}

/** A remote player's snapshot as relayed by the server. */
export interface RemoteSnapshot extends NetState {
  id: string
  name: string
}

/** One alien in the shared swarm: [id, x, y, z, big(1|0)]. */
export type AlienTuple = [number, number, number, number, number]

export interface ScoreRow {
  name: string
  score: number
}

/** Compact per-game record on the wire: [played, won, lost, best]. */
export type WireGames = Record<string, [number, number, number, number]>

/** A pilot's profile as relayed by the server. */
export interface NetProfile {
  id: string
  name: string
  aliens: number
  level: number
  rating: number // duel rank points
  badges: number // achievements unlocked
  accent: number // equipped accent cosmetic color (hex int) - tints the remote avatar
  games: WireGames
}

export interface NetHandlers {
  onWelcome(players: RemoteSnapshot[]): void
  onJoin(id: string, name: string): void
  onLeave(id: string): void
  onState(id: string, s: NetState): void
  onCapture(id: string, p: NetVec3, award: number): void
  onStatus(connected: boolean): void
  onFull?(): void
  // Shared-world (server-authoritative) content.
  onAliens(list: AlienTuple[]): void
  onAlienGone(id: number, by: string, award: number): void
  onScores(board: ScoreRow[]): void
  onProfiles(list: NetProfile[]): void
  // Challenges + live Beam Wars duels.
  onChallenged(fromId: string, name: string): void
  onChallengeDeclined(name: string): void
  onChallengeBusy(name: string): void
  onMatchStart(info: { side: MatchSide; opp: string; oppId: string; cols: number; rows: number; a: [number, number]; b: [number, number]; trailA: number; trailB: number; startIn: number }): void
  onMatchTick(a: [number, number], b: [number, number], aAlive: boolean, bAlive: boolean): void
  onMatchEnd(winner: MatchSide | 'draw'): void
  // Kid-safe typed chat (server re-filters + relays). Only fires when the room
  // has chat enabled; each client decides whether to render it per parental gate.
  onChat(msg: ChatMessage): void
  onChatBlocked?(reason: FilterVerdict['reason']): void
}

export type MatchSide = 'a' | 'b'

/**
 * Resolve the realtime host. Priority: explicit arg, then `?mp=` query override
 * (handy for testing against a deployed server), then localhost dev default,
 * then the configured production host. The production host is set once you have
 * deployed PartyKit (`npx partykit deploy` prints it, e.g.
 * `unit7-world.<your-account>.partykit.dev`).
 */
export function resolveHost(explicit?: string): string {
  if (explicit) return explicit
  if (typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search).get('mp')
    if (q) return q
    const h = location.hostname
    if (h === 'localhost' || h === '127.0.0.1') return '127.0.0.1:1999'
  }
  return PROD_HOST
}

// Production realtime host. Defaults to the deployed PartyKit host; override per
// build with the `VITE_PARTYKIT_HOST` env var (Netlify: Site settings ->
// environment variables) if the server moves.
const ENV_HOST = (import.meta.env?.VITE_PARTYKIT_HOST as string | undefined)?.trim()
export const PROD_HOST = ENV_HOST || 'party.humanoidrobots.com'
/** A real production host is configured (not a placeholder). */
export const HAS_PROD_HOST = !!PROD_HOST

/** A stable per-browser id, persisted in localStorage, so a reconnecting player
 *  reclaims their server-side score row instead of being treated as brand new. */
function clientUid(): string {
  try {
    if (typeof localStorage === 'undefined') return ''
    let u = localStorage.getItem('u7_uid')
    if (!u) {
      u = 'u' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
      localStorage.setItem('u7_uid', u)
    }
    return u
  } catch {
    return ''
  }
}

export class Net {
  private ws: WebSocket | null = null
  private url: string
  private name: string
  private handlers: NetHandlers
  private closed = false
  private retry = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private uid = clientUid()
  /** Our own connection id (known after `welcome`); used to spot our own claims. */
  myId = ''

  constructor(name: string, handlers: NetHandlers, opts: { host?: string; room?: string } = {}) {
    this.name = name
    this.handlers = handlers
    const host = resolveHost(opts.host)
    const room = opts.room ?? 'main'
    const secure = !/^(localhost|127\.0\.0\.1)/.test(host)
    const proto = secure ? 'wss' : 'ws'
    this.url = `${proto}://${host}/parties/main/${encodeURIComponent(room)}`
    this.connect()
  }

  private connect() {
    if (this.closed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.handlers.onStatus(true)
      this.send({ t: 'join', name: this.name, uid: this.uid })
    }
    ws.onmessage = (ev) => this.onMessage(ev.data)
    ws.onclose = () => {
      this.handlers.onStatus(false)
      this.ws = null
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose fires after onerror; let it handle the reconnect.
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleReconnect() {
    if (this.closed || this.retryTimer) return
    // Exponential backoff, capped, so a missing/unreachable server doesn't spin.
    const delay = Math.min(16000, 1000 * 2 ** this.retry)
    this.retry += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private onMessage(data: unknown) {
    if (typeof data !== 'string') return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    switch (msg.t) {
      case 'welcome':
        this.myId = (msg.id as string) ?? ''
        this.handlers.onWelcome((msg.players as RemoteSnapshot[]) ?? [])
        if (msg.scores) this.handlers.onScores(msg.scores as ScoreRow[])
        if (msg.aliens) this.handlers.onAliens(msg.aliens as AlienTuple[])
        if (msg.profiles) this.handlers.onProfiles(msg.profiles as NetProfile[])
        break
      case 'aliens':
        this.handlers.onAliens((msg.list as AlienTuple[]) ?? [])
        break
      case 'alienGone':
        this.handlers.onAlienGone(msg.id as number, (msg.by as string) ?? '', (msg.award as number) ?? 0)
        break
      case 'scores':
        this.handlers.onScores((msg.board as ScoreRow[]) ?? [])
        break
      case 'profiles':
        this.handlers.onProfiles((msg.list as NetProfile[]) ?? [])
        break
      case 'challenged':
        this.handlers.onChallenged(msg.from as string, (msg.name as string) ?? 'PILOT')
        break
      case 'challengeDeclined':
        this.handlers.onChallengeDeclined((msg.name as string) ?? 'PILOT')
        break
      case 'challengeBusy':
        this.handlers.onChallengeBusy((msg.name as string) ?? 'PILOT')
        break
      case 'matchStart':
        this.handlers.onMatchStart({
          side: msg.side as MatchSide,
          opp: (msg.opp as string) ?? 'PILOT',
          oppId: (msg.oppId as string) ?? '',
          cols: (msg.cols as number) ?? 64,
          rows: (msg.rows as number) ?? 40,
          a: (msg.a as [number, number]) ?? [0, 0],
          b: (msg.b as [number, number]) ?? [0, 0],
          trailA: (msg.trailA as number) ?? 0x27e7ff,
          trailB: (msg.trailB as number) ?? 0xff2bd0,
          startIn: (msg.startIn as number) ?? 1600,
        })
        break
      case 'matchTick':
        this.handlers.onMatchTick(msg.a as [number, number], msg.b as [number, number], !!msg.aAlive, !!msg.bAlive)
        break
      case 'matchEnd':
        this.handlers.onMatchEnd(msg.winner as MatchSide | 'draw')
        break
      case 'join':
        this.handlers.onJoin(msg.id as string, msg.name as string)
        break
      case 'leave':
        this.handlers.onLeave(msg.id as string)
        break
      case 'state':
        this.handlers.onState(msg.id as string, msg as unknown as NetState)
        break
      case 'capture':
        this.handlers.onCapture(msg.id as string, msg.p as NetVec3, (msg.award as number) ?? 0)
        break
      case 'full':
        this.handlers.onFull?.()
        break
      case 'chat':
        // The wire uses `ts` for the timestamp because `t` is the message-type
        // discriminator; map `ts` -> ChatMessage.t here.
        this.handlers.onChat({ id: msg.id as string, name: msg.name as string, text: msg.text as string, t: (msg.ts as number) ?? 0 })
        break
      case 'chatBlocked':
        this.handlers.onChatBlocked?.(msg.reason as FilterVerdict['reason'])
        break
    }
  }

  private send(obj: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    }
  }

  sendState(s: NetState) {
    this.send({ t: 'state', ...s })
  }

  sendCapture(p: NetVec3, award: number) {
    this.send({ t: 'capture', p, award })
  }

  /** Send a chat line. The server re-filters it and relays the cleaned text (or
   *  replies with `chatBlocked`); raw input never reaches another player. */
  sendChat(text: string) {
    this.send({ t: 'chat', text })
  }

  /** Try to claim a shared alien; the server decides first-claim-wins. */
  sendClaim(id: number) {
    this.send({ t: 'claim', id })
  }

  /** Publish our profile (captures, level, duel rating, badges, accent, per-game W/L) to the room. */
  sendProfile(aliens: number, games: WireGames, level: number, rating: number, badges: number, accent: number) {
    this.send({ t: 'profile', aliens, games, level, rating, badges, accent })
  }

  /** Challenge another pilot (by connection id) to a live Beam Wars duel. */
  sendChallenge(to: string, trail = 0x27e7ff) {
    this.send({ t: 'challenge', to, trail })
  }

  /** Accept / decline a duel offer from challenger `fromId`. */
  sendAccept(fromId: string, trail = 0x27e7ff) {
    this.send({ t: 'accept', from: fromId, trail })
  }

  sendDecline(fromId: string) {
    this.send({ t: 'decline', from: fromId })
  }

  /** Steer our beam in the active duel. */
  sendMatchDir(dx: number, dy: number) {
    this.send({ t: 'matchDir', dir: [dx, dy] })
  }

  /** Forfeit / leave the active duel. */
  sendMatchQuit() {
    this.send({ t: 'matchQuit' })
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  close() {
    this.closed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }
}
