import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { miniSfx } from './miniSound'

/**
 * Beam Wars - a self-contained lightcycle / trail minigame (the BeamWars genre):
 * two beams race around an arena leaving solid trails; steer with the arrows /
 * WASD (or the on-screen pad on touch). Run into any trail or the wall and that
 * beam dies. You play a single bot that is competent but beatable. Fully
 * isolated from the 3D engine - it runs its own canvas loop while the city is
 * paused, and calls `onExit` to hand control back to Humanoid City.
 */

const COLS = 64
const ROWS = 40
const TICK_MS = 78 // beam step interval
const BOT_RANDOM = 0 // play the best line every move (no deliberate mistakes)
const SEARCH_DEPTH = 8 // alpha-beta plies (4 moves each for bot + player)

type Phase = 'ready' | 'playing' | 'dead' | 'won'
interface Vec { x: number; y: number }
interface Beam { head: Vec; dir: Vec; next: Vec; alive: boolean }

const PLAYER = 1
const BOT = 2

const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

export function BeamWars({ onExit, touch }: { onExit: () => void; touch: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [phase, setPhase] = useState<Phase>('ready')

  // Mutable game state lives in refs so the tick loop doesn't churn React.
  const grid = useRef<Uint8Array>(new Uint8Array(COLS * ROWS))
  const player = useRef<Beam>(newBeam())
  const bot = useRef<Beam>(newBeam())
  const phaseRef = useRef<Phase>('ready')
  const timer = useRef<number | null>(null)
  // Reusable scratch buffers for the bot's Voronoi search (no per-tick allocs).
  // Generation stamps let each flood skip clearing the whole board first.
  const botDist = useRef<Int16Array>(new Int16Array(COLS * ROWS))
  const playerDist = useRef<Int16Array>(new Int16Array(COLS * ROWS))
  const botStamp = useRef<Int32Array>(new Int32Array(COLS * ROWS))
  const playerStamp = useRef<Int32Array>(new Int32Array(COLS * ROWS))
  const genCounter = useRef(0)
  const bfsQueue = useRef<Int32Array>(new Int32Array(COLS * ROWS))

  const idx = (x: number, y: number) => y * COLS + x
  const free = (x: number, y: number) => x >= 0 && x < COLS && y >= 0 && y < ROWS && grid.current[idx(x, y)] === 0

  const reset = useCallback(() => {
    grid.current.fill(0)
    const p: Beam = { head: { x: Math.floor(COLS * 0.22), y: Math.floor(ROWS / 2) - 4 }, dir: DIRS.right, next: DIRS.right, alive: true }
    const b: Beam = { head: { x: Math.floor(COLS * 0.78), y: Math.floor(ROWS / 2) + 4 }, dir: DIRS.left, next: DIRS.left, alive: true }
    grid.current[idx(p.head.x, p.head.y)] = PLAYER
    grid.current[idx(b.head.x, b.head.y)] = BOT
    player.current = p
    bot.current = b
  }, [])

  const setQueuedDir = useCallback((d: Vec) => {
    const beam = player.current
    if (!beam.alive) return
    // Can't reverse straight back into your own neck.
    if (d.x === -beam.dir.x && d.y === -beam.dir.y) return
    beam.next = d
  }, [])

  // Breadth-first distance fill from (sx,sy) over free cells into `dist`,
  // tagging visited cells with `gen` in `stamp` (so we never clear the board).
  // The source cell is the head: occupied, but we still expand from it.
  const bfsFill = useCallback((sx: number, sy: number, dist: Int16Array, stamp: Int32Array, gen: number) => {
    const q = bfsQueue.current
    const g = grid.current
    let head = 0
    let tail = 0
    const s = idx(sx, sy)
    dist[s] = 0
    stamp[s] = gen
    q[tail++] = s
    while (head < tail) {
      const cur = q[head++]
      const cx = cur % COLS
      const cy = (cur - cx) / COLS
      const d = dist[cur] + 1
      if (cx + 1 < COLS) { const n = cur + 1; if (g[n] === 0 && stamp[n] !== gen) { stamp[n] = gen; dist[n] = d; q[tail++] = n } }
      if (cx - 1 >= 0) { const n = cur - 1; if (g[n] === 0 && stamp[n] !== gen) { stamp[n] = gen; dist[n] = d; q[tail++] = n } }
      if (cy + 1 < ROWS) { const n = cur + COLS; if (g[n] === 0 && stamp[n] !== gen) { stamp[n] = gen; dist[n] = d; q[tail++] = n } }
      if (cy - 1 >= 0) { const n = cur - COLS; if (g[n] === 0 && stamp[n] !== gen) { stamp[n] = gen; dist[n] = d; q[tail++] = n } }
    }
  }, [])

  // Board evaluation. Flood from both heads (Voronoi) to split the board into
  // "whose cell is this", then score each side by how long a snake can actually
  // survive in its territory - not raw area. On a grid a trail alternates
  // colours, so the usable path length of a region is ~2*min(white,black): this
  // is what stops the bot grabbing comb-shaped area it can't traverse and then
  // trapping itself, which is what made it beatable in the endgame.
  const evaluateBoard = useCallback((bx: number, by: number, px: number, py: number) => {
    const bd = botDist.current
    const pd = playerDist.current
    const bs = botStamp.current
    const ps = playerStamp.current
    const genB = ++genCounter.current
    const genP = ++genCounter.current
    bfsFill(bx, by, bd, bs, genB)
    bfsFill(px, py, pd, ps, genP)
    let bw = 0, bb = 0, pw = 0, pb = 0 // bot/player white/black reachable-first cells
    let botReach = 0
    for (let y = 0; y < ROWS; y++) {
      const row = y * COLS
      for (let x = 0; x < COLS; x++) {
        const i = row + x
        const a = bs[i] === genB ? bd[i] : -1
        const c = ps[i] === genP ? pd[i] : -1
        if (a >= 0) botReach++
        const color = (x + y) & 1
        if (a >= 0 && (c < 0 || a < c)) { if (color) bw++; else bb++ }
        else if (c >= 0 && (a < 0 || c < a)) { if (color) pw++; else pb++ }
      }
    }
    if (botReach < 3) return -50000 + botReach // boxed in: effectively dead
    // Traversable-length estimate of each side's territory, plus a small raw-area
    // tiebreak so equal-survival positions still prefer grabbing more ground.
    const botSurv = 2 * Math.min(bw, bb) + 0.05 * (bw + bb)
    const playerSurv = 2 * Math.min(pw, pb) + 0.05 * (pw + pb)
    return botSurv - playerSurv
  }, [bfsFill])

  // Alpha-beta minimax over alternating moves (bot maximizes, player minimizes)
  // with the Voronoi score at the leaves. Trails are laid on the shared grid as
  // we descend and undone on the way out. Modelling the player's replies is what
  // lets the bot set up cut-offs that survive evasion - real expert play.
  const search = useCallback(
    (depth: number, botTurn: boolean, bx: number, by: number, bdx: number, bdy: number, px: number, py: number, pdx: number, pdy: number, alpha: number, beta: number): number => {
      if (depth === 0) return evaluateBoard(bx, by, px, py)
      const g = grid.current
      if (botTurn) {
        // dirs: straight, left, right (never reverse)
        const dirs = [bdx, bdy, bdy, -bdx, -bdy, bdx]
        let best = -Infinity
        let any = false
        for (let k = 0; k < 6; k += 2) {
          const dx = dirs[k]
          const dy = dirs[k + 1]
          const nx = bx + dx
          const ny = by + dy
          if (!free(nx, ny)) continue
          any = true
          const id = idx(nx, ny)
          g[id] = BOT
          const v = search(depth - 1, false, nx, ny, dx, dy, px, py, pdx, pdy, alpha, beta)
          g[id] = 0
          if (v > best) best = v
          if (best > alpha) alpha = best
          if (alpha >= beta) break // prune
        }
        if (!any) return -50000 - depth // trapped; dying sooner is worse
        return best
      } else {
        const dirs = [pdx, pdy, pdy, -pdx, -pdy, pdx]
        let best = Infinity
        let any = false
        for (let k = 0; k < 6; k += 2) {
          const dx = dirs[k]
          const dy = dirs[k + 1]
          const nx = px + dx
          const ny = py + dy
          if (!free(nx, ny)) continue
          any = true
          const id = idx(nx, ny)
          g[id] = PLAYER
          const v = search(depth - 1, true, bx, by, bdx, bdy, nx, ny, dx, dy, alpha, beta)
          g[id] = 0
          if (v < best) best = v
          if (best < beta) beta = best
          if (alpha >= beta) break // prune
        }
        if (!any) return 50000 + depth // player trapped: great for the bot
        return best
      }
    },
    [evaluateBoard],
  )

  // Bot move: alpha-beta search over the next several moves, with a tiny chance
  // of a random (still safe) move so a perfect line can't be memorised.
  const botThink = useCallback(() => {
    const b = bot.current
    if (!b.alive) return
    const p = player.current
    const dirs = [b.dir.x, b.dir.y, b.dir.y, -b.dir.x, -b.dir.y, b.dir.x]
    const safe: Vec[] = []
    for (let k = 0; k < 6; k += 2) {
      const d = { x: dirs[k], y: dirs[k + 1] }
      if (free(b.head.x + d.x, b.head.y + d.y)) safe.push(d)
    }
    if (safe.length === 0) return // doomed; keep going straight
    if (Math.random() < BOT_RANDOM) {
      b.next = safe[Math.floor(Math.random() * safe.length)]
      return
    }
    const g = grid.current
    let best = safe[0]
    let bestScore = -Infinity
    for (const d of safe) {
      const nx = b.head.x + d.x
      const ny = b.head.y + d.y
      const id = idx(nx, ny)
      g[id] = BOT
      let score = search(SEARCH_DEPTH - 1, false, nx, ny, d.x, d.y, p.head.x, p.head.y, p.dir.x, p.dir.y, -Infinity, Infinity)
      g[id] = 0
      if (d.x === b.dir.x && d.y === b.dir.y) score += 0.1 // tie-break: go straight
      if (score > bestScore) {
        bestScore = score
        best = d
      }
    }
    b.next = best
  }, [search])

  const step = useCallback(() => {
    if (phaseRef.current !== 'playing') return
    botThink()
    const p = player.current
    const b = bot.current
    p.dir = p.next
    b.dir = b.next
    const pn = { x: p.head.x + p.dir.x, y: p.head.y + p.dir.y }
    const bn = { x: b.head.x + b.dir.x, y: b.head.y + b.dir.y }
    // Head-on into the same cell is a mutual crash.
    const sameCell = pn.x === bn.x && pn.y === bn.y
    const pDead = !free(pn.x, pn.y) || sameCell
    const bDead = !free(bn.x, bn.y) || sameCell
    if (!pDead) {
      p.head = pn
      grid.current[idx(pn.x, pn.y)] = PLAYER
    }
    if (!bDead) {
      b.head = bn
      grid.current[idx(bn.x, bn.y)] = BOT
    }
    if (pDead) p.alive = false
    if (bDead) b.alive = false
    if (pDead) finish('dead')
    else if (bDead) finish('won')
  }, [botThink])

  const finish = (ph: Phase) => {
    phaseRef.current = ph
    setPhase(ph)
    miniSfx(ph === 'won' ? 'lap' : 'gameover')
    if (timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
  }

  const start = useCallback(() => {
    reset()
    phaseRef.current = 'playing'
    setPhase('playing')
    miniSfx('start')
    if (timer.current) clearInterval(timer.current)
    timer.current = window.setInterval(step, TICK_MS)
  }, [reset, step])

  // --- input ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp': case 'w': case 'W': setQueuedDir(DIRS.up); break
        case 'ArrowDown': case 's': case 'S': setQueuedDir(DIRS.down); break
        case 'ArrowLeft': case 'a': case 'A': setQueuedDir(DIRS.left); break
        case 'ArrowRight': case 'd': case 'D': setQueuedDir(DIRS.right); break
        case 'Enter': case ' ':
          if (phaseRef.current === 'ready') start()
          else if (phaseRef.current === 'dead' || phaseRef.current === 'won') start()
          break
        case 'Escape':
          onExit()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setQueuedDir, start, onExit])

  // --- render loop (decoupled from the tick so motion looks smooth) ---
  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const cv = canvasRef.current
      if (!cv) return
      const ctx = cv.getContext('2d')
      if (!ctx) return
      const W = cv.width
      const H = cv.height
      const cell = Math.floor(Math.min(W / COLS, H / ROWS))
      const aw = cell * COLS
      const ah = cell * ROWS
      const ox = Math.floor((W - aw) / 2)
      const oy = Math.floor((H - ah) / 2)

      ctx.fillStyle = '#05060b'
      ctx.fillRect(0, 0, W, H)
      // arena
      ctx.fillStyle = '#080b13'
      ctx.fillRect(ox, oy, aw, ah)
      ctx.strokeStyle = 'rgba(39,231,255,0.55)'
      ctx.lineWidth = 2
      ctx.strokeRect(ox + 1, oy + 1, aw - 2, ah - 2)

      // trails
      const g = grid.current
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const v = g[y * COLS + x]
          if (!v) continue
          ctx.fillStyle = v === PLAYER ? '#27e7ff' : '#ff2bd0'
          ctx.fillRect(ox + x * cell, oy + y * cell, cell - 1, cell - 1)
        }
      }
      // heads (brighter, glowing)
      const drawHead = (beam: Beam, color: string) => {
        ctx.save()
        ctx.shadowColor = color
        ctx.shadowBlur = 14
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(ox + beam.head.x * cell, oy + beam.head.y * cell, cell - 1, cell - 1)
        ctx.restore()
      }
      drawHead(player.current, '#27e7ff')
      drawHead(bot.current, '#ff2bd0')
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Size the canvas to its box (device-pixel aware) and keep it crisp on resize.
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const fit = () => {
      const r = cv.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      cv.width = Math.max(1, Math.floor(r.width * dpr))
      cv.height = Math.max(1, Math.floor(r.height * dpr))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])

  return (
    <div style={root}>
      <canvas ref={canvasRef} style={canvasStyle} />

      <div style={titleBar}>
        <span style={{ color: '#27e7ff', textShadow: '0 0 14px #27e7ff' }}>BEAM</span>
        <span style={{ color: '#ff2bd0', textShadow: '0 0 14px #ff2bd0' }}> WARS</span>
      </div>
      <button style={exitBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>

      {phase === 'ready' && (
        <Panel>
          <div style={panelTitle}>BEAM WARS</div>
          <div style={panelText}>Steer your beam. Don't hit a trail or the wall. Outlast the bot.</div>
          <div style={panelHint}>{touch ? 'Use the on-screen pad to steer' : 'Arrow keys or WASD to steer'}</div>
          <button style={primaryBtn} onClick={start}>START</button>
        </Panel>
      )}
      {phase === 'dead' && (
        <Panel>
          <div style={{ ...panelTitle, color: '#ff2bd0', textShadow: '0 0 16px #ff2bd0' }}>YOU CRASHED</div>
          <button style={primaryBtn} onClick={start}>REPLAY</button>
          <button style={ghostBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>
        </Panel>
      )}
      {phase === 'won' && (
        <Panel>
          <div style={{ ...panelTitle, color: '#9bff4d', textShadow: '0 0 16px #9bff4d' }}>YOU WIN</div>
          <button style={primaryBtn} onClick={start}>REPLAY</button>
          <button style={ghostBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>
        </Panel>
      )}

      {touch && phase === 'playing' && (
        <div style={dpad}>
          <DpadBtn label="▲" style={{ gridArea: 'up' }} onPress={() => setQueuedDir(DIRS.up)} />
          <DpadBtn label="◀" style={{ gridArea: 'left' }} onPress={() => setQueuedDir(DIRS.left)} />
          <DpadBtn label="▶" style={{ gridArea: 'right' }} onPress={() => setQueuedDir(DIRS.right)} />
          <DpadBtn label="▼" style={{ gridArea: 'down' }} onPress={() => setQueuedDir(DIRS.down)} />
        </div>
      )}
    </div>
  )
}

function newBeam(): Beam {
  return { head: { x: 0, y: 0 }, dir: DIRS.right, next: DIRS.right, alive: true }
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div style={panel}>{children}</div>
}

function DpadBtn({ label, onPress, style }: { label: string; onPress: () => void; style: CSSProperties }) {
  return (
    <button
      style={{ ...dpadBtn, ...style }}
      onPointerDown={(e) => { e.preventDefault(); onPress() }}
    >
      {label}
    </button>
  )
}

// --- styles ---
const root: CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 30, background: '#05060b',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', touchAction: 'none',
}
const canvasStyle: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' }
const titleBar: CSSProperties = {
  position: 'absolute', top: 16, left: 0, right: 0, textAlign: 'center',
  font: '800 22px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.3em', pointerEvents: 'none',
}
const exitBtn: CSSProperties = {
  position: 'absolute', top: 14, right: 14, zIndex: 32, cursor: 'pointer',
  padding: '8px 14px', font: '700 11px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em',
  color: 'rgba(223,238,255,0.92)', background: 'rgba(8,12,24,0.7)',
  border: '1px solid rgba(39,231,255,0.5)', borderRadius: 999,
}
const panel: CSSProperties = {
  position: 'relative', zIndex: 31, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
  padding: '28px 34px', background: 'rgba(6,9,18,0.82)', border: '1px solid rgba(39,231,255,0.4)',
  borderRadius: 16, boxShadow: '0 0 40px rgba(39,231,255,0.18)', textAlign: 'center', maxWidth: 360,
}
const panelTitle: CSSProperties = { font: '800 30px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.18em', color: '#27e7ff', textShadow: '0 0 16px #27e7ff' }
const panelText: CSSProperties = { color: 'rgba(223,238,255,0.8)', fontSize: 13, lineHeight: 1.5 }
const panelHint: CSSProperties = { color: 'rgba(223,238,255,0.5)', fontSize: 11, letterSpacing: '0.08em' }
const primaryBtn: CSSProperties = {
  marginTop: 4, cursor: 'pointer', padding: '12px 30px', font: '700 15px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.2em', color: '#05060b', background: '#27e7ff', border: 'none', borderRadius: 999,
  boxShadow: '0 0 22px rgba(39,231,255,0.6)',
}
const ghostBtn: CSSProperties = {
  cursor: 'pointer', padding: '10px 22px', font: '700 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em', color: 'rgba(223,238,255,0.9)', background: 'transparent',
  border: '1px solid rgba(223,238,255,0.4)', borderRadius: 999,
}
const dpad: CSSProperties = {
  position: 'absolute', bottom: 28, left: '50%', transform: 'translateX(-50%)', zIndex: 32,
  display: 'grid', gridTemplateAreas: '". up ." "left . right" ". down ."', gap: 8,
}
const dpadBtn: CSSProperties = {
  width: 58, height: 58, cursor: 'pointer', font: '700 20px/1 ui-monospace, Menlo, monospace',
  color: '#27e7ff', background: 'rgba(8,12,24,0.75)', border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 12, touchAction: 'none', userSelect: 'none',
}
