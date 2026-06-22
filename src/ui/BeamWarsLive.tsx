import { useEffect, useRef, type CSSProperties } from 'react'
import type { MatchView } from '../game/types'
import { miniSfx } from './miniSound'

/**
 * Live Beam Wars duel view: a thin client over a server-authoritative match.
 * The PartyKit server owns the grid + collisions and streams both beam heads
 * each tick (MatchView, refreshed via `seq`); this view accumulates the trails
 * for rendering and sends our steering inputs back. No local simulation, so the
 * two players always agree on the outcome. Your beam is cyan, the rival magenta.
 */
const hexCss = (n: number) => '#' + (n & 0xffffff).toString(16).padStart(6, '0')

export function BeamWarsLive({
  match,
  touch,
  onDir,
  onQuit,
  onRematch,
}: {
  match: MatchView
  touch: boolean
  onDir: (dx: number, dy: number) => void
  onQuit: () => void
  onRematch: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const trailA = useRef<Set<number>>(new Set())
  const trailB = useRef<Set<number>>(new Set())
  const seenSeq = useRef(-1)
  const endedRef = useRef(false)

  const { cols, rows, side } = match
  const idx = (x: number, y: number) => y * cols + x

  // Accumulate trail cells as the server advances the beams.
  useEffect(() => {
    if (match.seq === seenSeq.current) return
    seenSeq.current = match.seq
    trailA.current.add(idx(match.a[0], match.a[1]))
    trailB.current.add(idx(match.b[0], match.b[1]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.seq])

  // Seed the start cells once on mount (the 'get ready' frame).
  useEffect(() => {
    trailA.current.add(idx(match.a[0], match.a[1]))
    trailB.current.add(idx(match.b[0], match.b[1]))
    miniSfx('start')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Result sting once, when the duel resolves.
  useEffect(() => {
    if (match.status === 'over' && !endedRef.current) {
      endedRef.current = true
      const won = match.winner === side
      miniSfx(won ? 'lap' : 'gameover')
    }
  }, [match.status, match.winner, side])

  // --- input ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp': case 'w': case 'W': onDir(0, -1); break
        case 'ArrowDown': case 's': case 'S': onDir(0, 1); break
        case 'ArrowLeft': case 'a': case 'A': onDir(-1, 0); break
        case 'ArrowRight': case 'd': case 'D': onDir(1, 0); break
        case 'Escape': onQuit(); break
        default: return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDir, onQuit])

  // --- render loop ---
  useEffect(() => {
    let raf = 0
    const colA = hexCss(match.trailA)
    const colB = hexCss(match.trailB)
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const cv = canvasRef.current
      if (!cv) return
      const ctx = cv.getContext('2d')
      if (!ctx) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const maxW = Math.min(window.innerWidth - 40, 900)
      const maxH = Math.min(window.innerHeight - 150, 620)
      const cell = Math.max(4, Math.floor(Math.min(maxW / cols, maxH / rows)))
      const w = cell * cols
      const h = cell * rows
      if (cv.width !== w * dpr || cv.height !== h * dpr) {
        cv.width = w * dpr
        cv.height = h * dpr
        cv.style.width = w + 'px'
        cv.style.height = h + 'px'
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#05060b'
      ctx.fillRect(0, 0, w, h)
      // arena border
      ctx.strokeStyle = 'rgba(120,150,200,0.35)'
      ctx.lineWidth = 2
      ctx.strokeRect(1, 1, w - 2, h - 2)
      const paint = (set: Set<number>, color: string) => {
        ctx.fillStyle = color
        for (const c of set) {
          const x = c % cols
          const y = (c - x) / cols
          ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1)
        }
      }
      ctx.globalAlpha = 0.85
      paint(trailA.current, colA)
      paint(trailB.current, colB)
      ctx.globalAlpha = 1
      // heads (brighter)
      const head = (hx: number, hy: number, color: string, alive: boolean) => {
        ctx.fillStyle = alive ? '#ffffff' : color
        ctx.shadowColor = color
        ctx.shadowBlur = 14
        ctx.fillRect(hx * cell - 1, hy * cell - 1, cell + 1, cell + 1)
        ctx.shadowBlur = 0
      }
      head(match.a[0], match.a[1], colA, match.aAlive)
      head(match.b[0], match.b[1], colB, match.bAlive)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [cols, rows, side, match])

  const won = match.winner === side
  const resultText = match.winner === 'draw' ? 'DRAW' : won ? 'YOU WIN' : 'DEFEATED'
  const resultColor = match.winner === 'draw' ? '#ffd24a' : won ? '#9bff4d' : '#ff2bd0'
  const ourColor = hexCss(side === 'a' ? match.trailA : match.trailB)
  const rivalColor = hexCss(side === 'a' ? match.trailB : match.trailA)
  const r = match.result

  return (
    <div style={root}>
      <div style={topBar}>
        <span style={{ color: ourColor, fontWeight: 800 }}>YOU</span>
        <span style={{ color: 'rgba(223,238,255,0.6)' }}>BEAM WARS DUEL</span>
        <span style={{ color: rivalColor, fontWeight: 800 }}>{match.opp}</span>
      </div>
      <canvas ref={canvasRef} style={{ borderRadius: 8, boxShadow: '0 0 30px rgba(39,231,255,0.2)' }} />

      {match.status === 'ready' && (
        <div style={overlay}>
          <div style={{ ...bigText, color: ourColor }}>GET READY</div>
          <div style={subText}>facing {match.opp}</div>
        </div>
      )}
      {match.status === 'over' && (
        <div style={overlay}>
          <div style={{ ...bigText, color: resultColor }}>{resultText}</div>
          {r && (
            <div style={subText}>
              <span style={{ color: r.delta >= 0 ? '#9bff4d' : '#ff5c5c' }}>{r.delta >= 0 ? '+' : ''}{r.delta} RP</span>
              {'  ·  '}
              <span style={{ color: r.tierColor }}>{r.tier}</span>
              {r.streak > 1 ? `  ·  ${r.streak} WIN STREAK` : ''}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button style={rematchBtn} onClick={onRematch}>REMATCH ↺</button>
            <button style={ghostBtn} onClick={onQuit}>RETURN TO CITY</button>
          </div>
        </div>
      )}

      {match.status !== 'over' && (
        <button style={exitBtn} onClick={onQuit}>FORFEIT</button>
      )}

      {touch && match.status !== 'over' && (
        <div style={pad}>
          <button style={{ ...padBtn, gridArea: 'up' }} onPointerDown={() => onDir(0, -1)}>▲</button>
          <button style={{ ...padBtn, gridArea: 'left' }} onPointerDown={() => onDir(-1, 0)}>◀</button>
          <button style={{ ...padBtn, gridArea: 'right' }} onPointerDown={() => onDir(1, 0)}>▶</button>
          <button style={{ ...padBtn, gridArea: 'down' }} onPointerDown={() => onDir(0, 1)}>▼</button>
        </div>
      )}
    </div>
  )
}

const root: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 45,
  background: '#05060b',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  touchAction: 'none',
}
const topBar: CSSProperties = {
  display: 'flex',
  gap: 24,
  alignItems: 'center',
  font: '700 13px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
}
const overlay: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 18,
  background: 'rgba(3,5,12,0.55)',
}
const bigText: CSSProperties = {
  font: '800 42px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  textShadow: '0 0 22px rgba(39,231,255,0.5)',
}
const subText: CSSProperties = {
  font: '600 13px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
  color: 'rgba(223,238,255,0.7)',
}
const exitBtn: CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '8px 14px',
  background: 'rgba(6,10,22,0.8)',
  border: '1px solid rgba(255,43,208,0.5)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.92)',
  font: '700 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
}
const ghostBtn: CSSProperties = {
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '12px 22px',
  background: 'rgba(6,10,22,0.8)',
  border: '1px solid rgba(39,231,255,0.6)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.95)',
  font: '700 13px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
}
const rematchBtn: CSSProperties = {
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '12px 22px',
  background: 'linear-gradient(180deg,#5cf0ff,#27e7ff)',
  border: 'none',
  borderRadius: 999,
  color: '#04121a',
  font: '800 13px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
}
const pad: CSSProperties = {
  position: 'absolute',
  bottom: 24,
  right: 24,
  display: 'grid',
  gridTemplateAreas: '". up ." "left . right" ". down ."',
  gap: 8,
}
const padBtn: CSSProperties = {
  width: 60,
  height: 60,
  pointerEvents: 'auto',
  cursor: 'pointer',
  background: 'rgba(8,14,30,0.82)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 12,
  color: '#dff0ff',
  font: '700 20px/1 ui-monospace, Menlo, monospace',
}
