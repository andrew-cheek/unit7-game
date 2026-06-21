import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { loadHighScore, saveHighScore } from '../game/storage'
import { miniSfx } from './miniSound'

/**
 * Snake - a self-contained neon take on the classic. Steer a growing data-worm
 * around the arena eating nodes; hitting a wall or yourself ends the run. Arrows
 * / WASD or swipe to turn. Isolated from the 3D engine (its own canvas loop) and
 * calls onExit to hand control back to the city. High score persists per device.
 */

const COLS = 26
const ROWS = 26
const HS_KEY = 'snake'

type Phase = 'ready' | 'playing' | 'dead'
interface Vec { x: number; y: number }

const DIRS = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
}

export function Snake({ onExit, touch }: { onExit: () => void; touch: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [phase, setPhase] = useState<Phase>('ready')
  const [score, setScore] = useState(0)
  const [best, setBest] = useState(() => loadHighScore(HS_KEY))

  const snake = useRef<Vec[]>([])
  const dir = useRef<Vec>(DIRS.right)
  const next = useRef<Vec>(DIRS.right)
  const food = useRef<Vec>({ x: 0, y: 0 })
  const phaseRef = useRef<Phase>('ready')
  const scoreRef = useRef(0)
  const timer = useRef<number | null>(null)
  const stepMs = useRef(130)

  const placeFood = () => {
    for (;;) {
      const f = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) }
      if (!snake.current.some((s) => s.x === f.x && s.y === f.y)) { food.current = f; return }
    }
  }

  const setDir = useCallback((d: Vec) => {
    const cur = dir.current
    if (d.x === -cur.x && d.y === -cur.y) return // no reversing
    next.current = d
  }, [])

  const stop = useCallback(() => { if (timer.current) { clearInterval(timer.current); timer.current = null } }, [])

  const tick = useCallback(() => {
    if (phaseRef.current !== 'playing') return
    dir.current = next.current
    const head = snake.current[0]
    const nx = head.x + dir.current.x
    const ny = head.y + dir.current.y
    // Wall or self collision ends the run.
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS || snake.current.some((s) => s.x === nx && s.y === ny)) {
      phaseRef.current = 'dead'
      setPhase('dead')
      stop()
      miniSfx('gameover')
      saveHighScore(HS_KEY, scoreRef.current)
      setBest(loadHighScore(HS_KEY))
      return
    }
    snake.current.unshift({ x: nx, y: ny })
    if (nx === food.current.x && ny === food.current.y) {
      scoreRef.current += 10
      setScore(scoreRef.current)
      miniSfx('score')
      placeFood()
      // Speed up gently as the worm grows.
      stepMs.current = Math.max(60, 130 - snake.current.length * 1.5)
      stop()
      timer.current = window.setInterval(tick, stepMs.current)
    } else {
      snake.current.pop()
    }
  }, [stop])

  const start = useCallback(() => {
    snake.current = [{ x: 8, y: 13 }, { x: 7, y: 13 }, { x: 6, y: 13 }]
    dir.current = DIRS.right
    next.current = DIRS.right
    stepMs.current = 130
    scoreRef.current = 0
    setScore(0)
    placeFood()
    phaseRef.current = 'playing'
    setPhase('playing')
    miniSfx('start')
    stop()
    timer.current = window.setInterval(tick, stepMs.current)
  }, [stop, tick])

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp': case 'w': case 'W': setDir(DIRS.up); break
        case 'ArrowDown': case 's': case 'S': setDir(DIRS.down); break
        case 'ArrowLeft': case 'a': case 'A': setDir(DIRS.left); break
        case 'ArrowRight': case 'd': case 'D': setDir(DIRS.right); break
        case 'Enter': case ' ': if (phaseRef.current !== 'playing') start(); break
        case 'Escape': onExit(); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setDir, start, onExit])

  // swipe to steer
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => { touchStart.current = { x: e.clientX, y: e.clientY } }
  const onPointerUp = (e: React.PointerEvent) => {
    const s = touchStart.current
    touchStart.current = null
    if (!s) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return
    if (Math.abs(dx) > Math.abs(dy)) setDir(dx > 0 ? DIRS.right : DIRS.left)
    else setDir(dy > 0 ? DIRS.down : DIRS.up)
  }

  // render loop
  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const cv = canvasRef.current
      if (!cv) return
      const ctx = cv.getContext('2d')
      if (!ctx) return
      const W = cv.width, H = cv.height
      const cell = Math.floor(Math.min(W / COLS, H / ROWS))
      const aw = cell * COLS, ah = cell * ROWS
      const ox = Math.floor((W - aw) / 2), oy = Math.floor((H - ah) / 2)
      ctx.fillStyle = '#05060b'; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#080b13'; ctx.fillRect(ox, oy, aw, ah)
      ctx.strokeStyle = 'rgba(138,92,255,0.55)'; ctx.lineWidth = 2; ctx.strokeRect(ox + 1, oy + 1, aw - 2, ah - 2)
      // food
      ctx.save(); ctx.shadowColor = '#ff2bd0'; ctx.shadowBlur = 14; ctx.fillStyle = '#ff2bd0'
      ctx.fillRect(ox + food.current.x * cell + 1, oy + food.current.y * cell + 1, cell - 2, cell - 2); ctx.restore()
      // snake
      const body = snake.current
      for (let i = 0; i < body.length; i++) {
        ctx.fillStyle = i === 0 ? '#ffffff' : '#9bff4d'
        ctx.fillRect(ox + body[i].x * cell, oy + body[i].y * cell, cell - 1, cell - 1)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  // crisp backing store sized to the element
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
      <canvas ref={canvasRef} style={canvasStyle} onPointerDown={onPointerDown} onPointerUp={onPointerUp} />
      <div style={titleBar}><span style={{ color: '#8a5cff', textShadow: '0 0 14px #8a5cff' }}>SNAKE</span></div>
      <div style={scorePill}>SCORE {score} · BEST {best}</div>
      <button style={exitBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>
      {phase === 'ready' && (
        <Panel>
          <div style={panelTitle}>SNAKE</div>
          <div style={panelText}>Eat the nodes, grow, and don't bite yourself or the wall.</div>
          <div style={panelHint}>{touch ? 'Swipe to steer' : 'Arrows / WASD to steer'}</div>
          <button style={primaryBtn} onClick={start}>START</button>
        </Panel>
      )}
      {phase === 'dead' && (
        <Panel>
          <div style={{ ...panelTitle, color: '#ff2bd0', textShadow: '0 0 16px #ff2bd0' }}>GAME OVER</div>
          <div style={panelText}>Score {score} · Best {best}</div>
          <button style={primaryBtn} onClick={start}>REPLAY</button>
          <button style={ghostBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>
        </Panel>
      )}
    </div>
  )
}

function Panel({ children }: { children: React.ReactNode }) { return <div style={panel}>{children}</div> }

const root: CSSProperties = { position: 'absolute', inset: 0, zIndex: 30, background: '#05060b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', touchAction: 'none' }
const canvasStyle: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' }
const titleBar: CSSProperties = { position: 'absolute', top: 16, left: 0, right: 0, textAlign: 'center', font: '800 22px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.3em', pointerEvents: 'none' }
const scorePill: CSSProperties = { position: 'absolute', top: 50, left: 0, right: 0, textAlign: 'center', font: '700 12px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.85)', pointerEvents: 'none' }
const exitBtn: CSSProperties = { position: 'absolute', top: 14, right: 14, zIndex: 32, cursor: 'pointer', padding: '8px 14px', font: '700 11px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em', color: 'rgba(223,238,255,0.92)', background: 'rgba(8,12,24,0.7)', border: '1px solid rgba(138,92,255,0.5)', borderRadius: 999 }
const panel: CSSProperties = { position: 'relative', zIndex: 31, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '28px 34px', background: 'rgba(6,9,18,0.82)', border: '1px solid rgba(138,92,255,0.4)', borderRadius: 16, boxShadow: '0 0 40px rgba(138,92,255,0.18)', textAlign: 'center', maxWidth: 360 }
const panelTitle: CSSProperties = { font: '800 30px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.18em', color: '#8a5cff', textShadow: '0 0 16px #8a5cff' }
const panelText: CSSProperties = { color: 'rgba(223,238,255,0.8)', fontSize: 13, lineHeight: 1.5 }
const panelHint: CSSProperties = { color: 'rgba(223,238,255,0.5)', fontSize: 11, letterSpacing: '0.08em' }
const primaryBtn: CSSProperties = { marginTop: 4, cursor: 'pointer', padding: '12px 30px', font: '700 15px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.2em', color: '#05060b', background: '#8a5cff', border: 'none', borderRadius: 999, boxShadow: '0 0 22px rgba(138,92,255,0.6)' }
const ghostBtn: CSSProperties = { cursor: 'pointer', padding: '10px 22px', font: '700 12px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.9)', background: 'transparent', border: '1px solid rgba(223,238,255,0.4)', borderRadius: 999 }
