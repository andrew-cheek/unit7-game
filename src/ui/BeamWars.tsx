import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'

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
const BOT_RANDOM = 0.06 // chance the bot makes a non-optimal (but safe) move
const FLOOD_CAP = 80 // max cells the bot's space-check explores (keeps it cheap)

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

  // Flood-fill the open space reachable from (sx,sy), capped at FLOOD_CAP cells.
  // This is what stops the bot driving itself into a pocket it can't escape -
  // the main thing that made the old one-cell-lookahead bot feel braindead.
  const floodCount = useCallback((sx: number, sy: number) => {
    if (!free(sx, sy)) return 0
    const seen = new Uint8Array(COLS * ROWS)
    const stack = [sx, sy]
    seen[idx(sx, sy)] = 1
    let count = 0
    while (stack.length && count < FLOOD_CAP) {
      const y = stack.pop() as number
      const x = stack.pop() as number
      count++
      const nbrs = [x + 1, y, x - 1, y, x, y + 1, x, y - 1]
      for (let i = 0; i < nbrs.length; i += 2) {
        const nx = nbrs[i]
        const ny = nbrs[i + 1]
        if (free(nx, ny) && !seen[idx(nx, ny)]) {
          seen[idx(nx, ny)] = 1
          stack.push(nx, ny)
        }
      }
    }
    return count
  }, [])

  // Bot picks among straight / left / right: avoids instant death, prefers the
  // option with the most reachable open space, and leans toward the player when
  // it's close (a light cut-off instinct). Still turns "dumb" a small fraction
  // of the time so it stays beatable.
  const botThink = useCallback(() => {
    const b = bot.current
    if (!b.alive) return
    const straight = b.dir
    const left = { x: b.dir.y, y: -b.dir.x }
    const right = { x: -b.dir.y, y: b.dir.x }
    const options = [straight, left, right]
    const safe = options.filter((o) => free(b.head.x + o.x, b.head.y + o.y))
    if (safe.length === 0) return // doomed; keep going straight
    if (Math.random() < BOT_RANDOM) {
      b.next = safe[Math.floor(Math.random() * safe.length)]
      return
    }
    const p = player.current
    let best = safe[0]
    let bestScore = -Infinity
    for (const o of safe) {
      const nx = b.head.x + o.x
      const ny = b.head.y + o.y
      // Reachable open space is the dominant term: don't trap yourself.
      let s = floodCount(nx, ny)
      // Slight bias to keep going straight so it reads as purposeful.
      if (o === straight) s += 2
      // Mild aggression: nudge toward the player's head when reasonably near,
      // so it sometimes cuts you off. Weak enough that space always wins.
      const dist = Math.abs(nx - p.head.x) + Math.abs(ny - p.head.y)
      if (dist < 14) s += (14 - dist) * 0.25
      if (s > bestScore) {
        bestScore = s
        best = o
      }
    }
    b.next = best
  }, [floodCount])

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
    if (timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
  }

  const start = useCallback(() => {
    reset()
    phaseRef.current = 'playing'
    setPhase('playing')
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
