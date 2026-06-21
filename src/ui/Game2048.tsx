import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { loadHighScore, saveHighScore } from '../game/storage'
import { miniSfx } from './miniSound'

/**
 * 2048 - a clean-room neon build of the classic sliding-tile puzzle. Swipe or
 * use the arrow keys to merge matching tiles; reach 2048 and keep going for a
 * high score. DOM grid (crisp text, no canvas), isolated from the 3D engine,
 * high score persisted per device.
 */

const N = 4
const HS_KEY = '2048'

type Dir = 'left' | 'right' | 'up' | 'down'

const lineIndices = (dir: Dir): number[][] => {
  const lines: number[][] = []
  for (let i = 0; i < N; i++) {
    const line: number[] = []
    for (let j = 0; j < N; j++) {
      // destination-first ordering per direction
      if (dir === 'left') line.push(i * N + j)
      else if (dir === 'right') line.push(i * N + (N - 1 - j))
      else if (dir === 'up') line.push(j * N + i)
      else line.push((N - 1 - j) * N + i)
    }
    lines.push(line)
  }
  return lines
}

const slide = (vals: number[]): { out: number[]; gained: number; changed: boolean } => {
  const nz = vals.filter((v) => v !== 0)
  const out: number[] = []
  let gained = 0
  for (let i = 0; i < nz.length; i++) {
    if (i + 1 < nz.length && nz[i] === nz[i + 1]) {
      const merged = nz[i] * 2
      out.push(merged)
      gained += merged
      i++ // consume the pair
    } else {
      out.push(nz[i])
    }
  }
  while (out.length < N) out.push(0)
  const changed = out.some((v, k) => v !== vals[k])
  return { out, gained, changed }
}

const spawn = (b: number[]) => {
  const empty = b.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0)
  if (!empty.length) return
  b[empty[Math.floor(Math.random() * empty.length)]] = Math.random() < 0.9 ? 2 : 4
}

const canMove = (b: number[]): boolean => {
  for (let i = 0; i < N * N; i++) {
    if (b[i] === 0) return true
    const r = Math.floor(i / N), c = i % N
    if (c + 1 < N && b[i] === b[i + 1]) return true
    if (r + 1 < N && b[i] === b[i + N]) return true
  }
  return false
}

const TILE: Record<number, { bg: string; fg: string }> = {
  2: { bg: '#16324a', fg: '#bfeaff' },
  4: { bg: '#1d3e5e', fg: '#cdeeff' },
  8: { bg: '#27e7ff', fg: '#05202b' },
  16: { bg: '#1fb6d8', fg: '#04222c' },
  32: { bg: '#8a5cff', fg: '#0b0420' },
  64: { bg: '#b14dff', fg: '#120428' },
  128: { bg: '#ff8a1e', fg: '#241003' },
  256: { bg: '#ff6a1e', fg: '#240a03' },
  512: { bg: '#ff2bd0', fg: '#2a0420' },
  1024: { bg: '#ff4d8a', fg: '#2a0414' },
  2048: { bg: '#9bff4d', fg: '#0c2102' },
}

export function Game2048({ onExit, touch }: { onExit: () => void; touch: boolean }) {
  const [board, setBoard] = useState<number[]>(() => { const b = new Array(N * N).fill(0); spawn(b); spawn(b); return b })
  const [score, setScore] = useState(0)
  const [best, setBest] = useState(() => loadHighScore(HS_KEY))
  const [over, setOver] = useState(false)
  const boardRef = useRef(board)
  const scoreRef = useRef(0)
  boardRef.current = board

  const reset = useCallback(() => {
    const b = new Array(N * N).fill(0); spawn(b); spawn(b)
    scoreRef.current = 0
    setScore(0); setOver(false); setBoard(b)
  }, [])

  const move = useCallback((dir: Dir) => {
    if (over) return
    const b = boardRef.current.slice()
    let moved = false, gained = 0
    for (const line of lineIndices(dir)) {
      const vals = line.map((i) => b[i])
      const { out, gained: g, changed } = slide(vals)
      if (changed) moved = true
      gained += g
      line.forEach((i, k) => (b[i] = out[k]))
    }
    if (!moved) return
    spawn(b)
    scoreRef.current += gained
    setScore(scoreRef.current)
    setBoard(b)
    miniSfx(gained > 0 ? 'score' : 'shoot')
    if (!canMove(b)) {
      setOver(true)
      miniSfx('gameover')
      saveHighScore(HS_KEY, scoreRef.current)
      setBest(loadHighScore(HS_KEY))
    }
  }, [over])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft': case 'a': move('left'); break
        case 'ArrowRight': case 'd': move('right'); break
        case 'ArrowUp': case 'w': move('up'); break
        case 'ArrowDown': case 's': move('down'); break
        case 'Escape': onExit(); break
        case 'Enter': if (over) reset(); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [move, over, reset, onExit])

  // swipe
  const start = useRef<{ x: number; y: number } | null>(null)
  const onDown = (e: React.PointerEvent) => { start.current = { x: e.clientX, y: e.clientY } }
  const onUp = (e: React.PointerEvent) => {
    const s = start.current; start.current = null
    if (!s) return
    const dx = e.clientX - s.x, dy = e.clientY - s.y
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left')
    else move(dy > 0 ? 'down' : 'up')
  }

  return (
    <div style={root}>
      <div style={titleBar}>
        <span style={{ color: '#ff2bd0', textShadow: '0 0 14px #ff2bd0' }}>20</span>
        <span style={{ color: '#27e7ff', textShadow: '0 0 14px #27e7ff' }}>48</span>
      </div>
      <div style={scorePill}>SCORE {score} · BEST {best}</div>
      <button style={exitBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>

      <div style={boardWrap} onPointerDown={onDown} onPointerUp={onUp}>
        <div style={grid}>
          {board.map((v, i) => {
            const t = TILE[v]
            return (
              <div key={i} style={{
                ...cell,
                background: v === 0 ? 'rgba(39,231,255,0.06)' : t?.bg ?? '#9bff4d',
                color: t?.fg ?? '#05060b',
                boxShadow: v ? `0 0 14px ${(t?.bg ?? '#9bff4d')}66` : 'none',
                fontSize: v >= 1024 ? 22 : v >= 128 ? 26 : 30,
              }}>{v || ''}</div>
            )
          })}
        </div>
        {over && (
          <div style={overlay}>
            <div style={{ ...panelTitle, color: '#ff2bd0', textShadow: '0 0 16px #ff2bd0' }}>NO MOVES</div>
            <div style={panelText}>Score {score} · Best {best}</div>
            <button style={primaryBtn} onClick={reset}>PLAY AGAIN</button>
            <button style={ghostBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>
          </div>
        )}
      </div>
      <div style={hint}>{touch ? 'Swipe to merge tiles' : 'Arrow keys / WASD to merge tiles'}</div>
    </div>
  )
}

const root: CSSProperties = { position: 'absolute', inset: 0, zIndex: 30, background: '#05060b', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', touchAction: 'none' }
const titleBar: CSSProperties = { position: 'absolute', top: 16, left: 0, right: 0, textAlign: 'center', font: '800 26px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.2em', pointerEvents: 'none' }
const scorePill: CSSProperties = { position: 'absolute', top: 54, left: 0, right: 0, textAlign: 'center', font: '700 12px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.85)', pointerEvents: 'none' }
const exitBtn: CSSProperties = { position: 'absolute', top: 14, right: 14, zIndex: 32, cursor: 'pointer', padding: '8px 14px', font: '700 11px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em', color: 'rgba(223,238,255,0.92)', background: 'rgba(8,12,24,0.7)', border: '1px solid rgba(39,231,255,0.5)', borderRadius: 999 }
const boardWrap: CSSProperties = { position: 'relative', width: 'min(86vw, 86vh, 420px)', height: 'min(86vw, 86vh, 420px)' }
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: `repeat(${N}, 1fr)`, gridTemplateRows: `repeat(${N}, 1fr)`, gap: 8, width: '100%', height: '100%', padding: 8, background: 'rgba(6,9,18,0.82)', border: '1px solid rgba(39,231,255,0.4)', borderRadius: 14, boxShadow: '0 0 40px rgba(39,231,255,0.16)', boxSizing: 'border-box' }
const cell: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, fontWeight: 800 }
const overlay: CSSProperties = { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: 'rgba(5,6,11,0.86)', borderRadius: 14 }
const hint: CSSProperties = { position: 'absolute', bottom: 24, left: 0, right: 0, textAlign: 'center', color: 'rgba(223,238,255,0.5)', fontSize: 11, letterSpacing: '0.08em', pointerEvents: 'none' }
const panelTitle: CSSProperties = { font: '800 28px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.18em' }
const panelText: CSSProperties = { color: 'rgba(223,238,255,0.8)', fontSize: 13 }
const primaryBtn: CSSProperties = { marginTop: 4, cursor: 'pointer', padding: '12px 30px', font: '700 15px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.2em', color: '#05060b', background: '#27e7ff', border: 'none', borderRadius: 999, boxShadow: '0 0 22px rgba(39,231,255,0.6)' }
const ghostBtn: CSSProperties = { cursor: 'pointer', padding: '10px 22px', font: '700 12px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.9)', background: 'transparent', border: '1px solid rgba(223,238,255,0.4)', borderRadius: 999 }
