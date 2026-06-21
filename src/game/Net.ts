// Client networking for shared-world multiplayer.
//
// Talks to the PartyKit server (party/server.ts) with a plain browser
// WebSocket, so the game bundle gains no extra runtime dependency. PartyKit
// rooms are reachable at `<proto>://<host>/parties/main/<room>`. Keep the
// message shapes in sync with the server.

import type { PlayerMode, Zone } from './types'

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
}

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

// TODO: set this to your deployed PartyKit host after `npx partykit deploy`.
// Until then, multiplayer only connects on localhost dev or with a `?mp=host`
// override, and the game runs fine single-player.
export const PROD_HOST = 'unit7-world.PARTYKIT_ACCOUNT.partykit.dev'

export class Net {
  private ws: WebSocket | null = null
  private url: string
  private name: string
  private handlers: NetHandlers
  private closed = false
  private retry = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
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
      this.send({ t: 'join', name: this.name })
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

  /** Try to claim a shared alien; the server decides first-claim-wins. */
  sendClaim(id: number) {
    this.send({ t: 'claim', id })
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
