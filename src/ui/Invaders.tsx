import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { loadHighScore, saveHighScore } from '../game/storage'
import { miniSfx } from './miniSound'

/**
 * Invaders - a neon alien-wave shooter (original implementation of the classic
 * fixed-shooter genre, themed to the city's invasion). Drag to move and the
 * cannon auto-fires; clear the descending waves, dodge their bombs, survive on
 * three lives. Self-contained canvas loop, isolated from the 3D engine. Logic
 * runs in a fixed virtual field that's letterboxed onto the canvas so it plays
 * the same at any resolution. High score persists per device.
 */

const FW = 360
const FH = 560
const HS_KEY = 'invaders'
const ROWS = 5
const COLS = 8

type Phase = 'ready' | 'playing' | 'dead'
interface Alien { x: number; y: number; alive: boolean; row: number }
interface Shot { x: number; y: number }

export function Invaders({ onExit, touch }: { onExit: () => void; touch: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [phase, setPhase] = useState<Phase>('ready')
  const [score, setScore] = useState(0)
  const [lives, setLives] = useState(3)
  const [best, setBest] = useState(() => loadHighScore(HS_KEY))

  const phaseRef = useRef<Phase>('ready')
  const shipX = useRef(FW / 2)
  const targetX = useRef(FW / 2)
  const keyDir = useRef(0)
  const aliens = useRef<Alien[]>([])
  const bullets = useRef<Shot[]>([])
  const bombs = useRef<Shot[]>([])
  const alienVX = useRef(26)
  const fireCd = useRef(0)
  const bombCd = useRef(1.2)
  const wave = useRef(1)
  const scoreRef = useRef(0)
  const livesRef = useRef(3)
  const last = useRef(0)

  const spawnWave = useCallback(() => {
    const arr: Alien[] = []
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        arr.push({ x: 40 + c * 38, y: 60 + r * 32, alive: true, row: r })
      }
    }
    aliens.current = arr
    bullets.current = []
    bombs.current = []
    // Cap the per-wave speed so late waves stay fast-but-playable, not unhittable.
    alienVX.current = Math.min(26 + wave.current * 6, 92)
  }, [])

  const start = useCallback(() => {
    wave.current = 1
    scoreRef.current = 0; setScore(0)
    livesRef.current = 3; setLives(3)
    shipX.current = FW / 2; targetX.current = FW / 2
    spawnWave()
    phaseRef.current = 'playing'; setPhase('playing')
  }, [spawnWave])

  const die = useCallback(() => {
    phaseRef.current = 'dead'; setPhase('dead')
    miniSfx('gameover')
    saveHighScore(HS_KEY, scoreRef.current); setBest(loadHighScore(HS_KEY))
  }, [])

  // input
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a') keyDir.current = -1
      else if (e.key === 'ArrowRight' || e.key === 'd') keyDir.current = 1
      else if (e.key === 'Enter' || e.key === ' ') { if (phaseRef.current !== 'playing') start() }
      else if (e.key === 'Escape') onExit()
    }
    const up = (e: KeyboardEvent) => {
      if ((e.key === 'ArrowLeft' || e.key === 'a') && keyDir.current === -1) keyDir.current = 0
      if ((e.key === 'ArrowRight' || e.key === 'd') && keyDir.current === 1) keyDir.current = 0
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [start, onExit])

  // pointer drag -> move ship (map screen x to field x)
  const dragging = useRef(false)
  const mapX = (clientX: number) => {
    const cv = canvasRef.current
    if (!cv) return targetX.current
    const r = cv.getBoundingClientRect()
    const scale = Math.min(r.width / FW, r.height / FH)
    const ox = (r.width - FW * scale) / 2
    return (clientX - r.left - ox) / scale
  }
  const onDown = (e: React.PointerEvent) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); targetX.current = mapX(e.clientX) }
  const onMove = (e: React.PointerEvent) => { if (dragging.current) targetX.current = mapX(e.clientX) }
  const onUp = () => { dragging.current = false }

  // game loop
  useEffect(() => {
    let raf = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = last.current ? Math.min(0.05, (now - last.current) / 1000) : 0
      last.current = now
      if (phaseRef.current === 'playing') update(dt)
      render()
    }

    const update = (dt: number) => {
      // ship movement
      if (keyDir.current !== 0) shipX.current += keyDir.current * 220 * dt
      else shipX.current += (targetX.current - shipX.current) * Math.min(1, dt * 12)
      shipX.current = Math.max(16, Math.min(FW - 16, shipX.current))

      // auto-fire
      fireCd.current -= dt
      if (fireCd.current <= 0) { bullets.current.push({ x: shipX.current, y: FH - 44 }); fireCd.current = 0.34; miniSfx('shoot') }

      // bullets up
      for (const b of bullets.current) b.y -= 320 * dt
      bullets.current = bullets.current.filter((b) => b.y > -10)

      // aliens move as a block; reverse + drop at edges
      const live = aliens.current.filter((a) => a.alive)
      let minX = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const a of live) { minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x); maxY = Math.max(maxY, a.y) }
      const dx = alienVX.current * dt
      let drop = false
      if (maxX + dx > FW - 16 || minX + dx < 16) { drop = true; alienVX.current *= -1 }
      for (const a of live) { if (drop) a.y += 16; else a.x += dx }

      // alien bombs
      bombCd.current -= dt
      if (bombCd.current <= 0 && live.length) {
        const shooter = live[Math.floor(Math.random() * live.length)]
        bombs.current.push({ x: shooter.x, y: shooter.y })
        bombCd.current = Math.max(0.4, 1.3 - wave.current * 0.08)
      }
      for (const b of bombs.current) b.y += 150 * dt
      bombs.current = bombs.current.filter((b) => b.y < FH + 10)

      // bullet -> alien
      for (const b of bullets.current) {
        for (const a of live) {
          if (a.alive && Math.abs(a.x - b.x) < 15 && Math.abs(a.y - b.y) < 13) {
            a.alive = false; b.y = -100
            scoreRef.current += (ROWS - a.row) * 10; setScore(scoreRef.current)
            miniSfx('hit')
            break
          }
        }
      }
      // bomb -> ship
      for (const b of bombs.current) {
        if (Math.abs(b.x - shipX.current) < 15 && b.y > FH - 52) {
          b.y = FH + 100
          livesRef.current -= 1; setLives(livesRef.current)
          if (livesRef.current <= 0) { die(); return }
        }
      }
      // aliens reach the ship line
      if (maxY > FH - 56) { die(); return }
      // wave cleared
      if (aliens.current.every((a) => !a.alive)) {
        wave.current += 1
        scoreRef.current += 50; setScore(scoreRef.current)
        spawnWave()
      }
    }

    const render = () => {
      const cv = canvasRef.current
      if (!cv) return
      const ctx = cv.getContext('2d')
      if (!ctx) return
      const W = cv.width, H = cv.height
      ctx.fillStyle = '#05060b'; ctx.fillRect(0, 0, W, H)
      const scale = Math.min(W / FW, H / FH)
      const ox = (W - FW * scale) / 2, oy = (H - FH * scale) / 2
      ctx.save(); ctx.translate(ox, oy); ctx.scale(scale, scale)
      ctx.fillStyle = '#080b13'; ctx.fillRect(0, 0, FW, FH)
      ctx.strokeStyle = 'rgba(155,255,77,0.5)'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, FW - 2, FH - 2)
      // aliens
      for (const a of aliens.current) {
        if (!a.alive) continue
        ctx.fillStyle = ['#9bff4d', '#27e7ff', '#ff2bd0', '#ff8a1e', '#8a5cff'][a.row % 5]
        ctx.fillRect(a.x - 11, a.y - 8, 22, 16)
        ctx.fillStyle = '#05060b'
        ctx.fillRect(a.x - 6, a.y - 3, 3, 3); ctx.fillRect(a.x + 3, a.y - 3, 3, 3)
      }
      // bullets
      ctx.fillStyle = '#eaf6ff'
      for (const b of bullets.current) ctx.fillRect(b.x - 1.5, b.y - 8, 3, 12)
      ctx.fillStyle = '#ff2bd0'
      for (const b of bombs.current) ctx.fillRect(b.x - 2, b.y - 6, 4, 12)
      // ship
      ctx.save(); ctx.shadowColor = '#27e7ff'; ctx.shadowBlur = 12; ctx.fillStyle = '#27e7ff'
      const sx = shipX.current, sy = FH - 30
      ctx.beginPath(); ctx.moveTo(sx, sy - 14); ctx.lineTo(sx + 14, sy + 8); ctx.lineTo(sx - 14, sy + 8); ctx.closePath(); ctx.fill()
      ctx.restore()
      ctx.restore()
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [die, spawnWave])

  // crisp backing store
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const fit = () => {
      const r = cv.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      cv.width = Math.max(1, Math.floor(r.width * dpr))
      cv.height = Math.max(1, Math.floor(r.height * dpr))
    }
    fit(); window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  return (
    <div style={root}>
      <canvas ref={canvasRef} style={canvasStyle} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      <div style={titleBar}><span style={{ color: '#9bff4d', textShadow: '0 0 14px #9bff4d' }}>INVADERS</span></div>
      <div style={scorePill}>SCORE {score} · LIVES {lives} · BEST {best}</div>
      <button style={exitBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>
      {phase === 'ready' && (
        <Panel>
          <div style={panelTitle}>INVADERS</div>
          <div style={panelText}>Clear the alien waves. The cannon auto-fires; dodge their bombs.</div>
          <div style={panelHint}>{touch ? 'Drag to move' : 'Arrows / A,D to move'}</div>
          <button style={primaryBtn} onClick={start}>START</button>
        </Panel>
      )}
      {phase === 'dead' && (
        <Panel>
          <div style={{ ...panelTitle, color: '#ff2bd0', textShadow: '0 0 16px #ff2bd0' }}>DEFEATED</div>
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
const scorePill: CSSProperties = { position: 'absolute', top: 50, left: 0, right: 0, textAlign: 'center', font: '700 12px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em', color: 'rgba(223,238,255,0.85)', pointerEvents: 'none' }
const exitBtn: CSSProperties = { position: 'absolute', top: 14, right: 14, zIndex: 32, cursor: 'pointer', padding: '8px 14px', font: '700 11px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em', color: 'rgba(223,238,255,0.92)', background: 'rgba(8,12,24,0.7)', border: '1px solid rgba(155,255,77,0.5)', borderRadius: 999 }
const panel: CSSProperties = { position: 'relative', zIndex: 31, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '28px 34px', background: 'rgba(6,9,18,0.82)', border: '1px solid rgba(155,255,77,0.4)', borderRadius: 16, boxShadow: '0 0 40px rgba(155,255,77,0.16)', textAlign: 'center', maxWidth: 360 }
const panelTitle: CSSProperties = { font: '800 30px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.18em', color: '#9bff4d', textShadow: '0 0 16px #9bff4d' }
const panelText: CSSProperties = { color: 'rgba(223,238,255,0.8)', fontSize: 13, lineHeight: 1.5 }
const panelHint: CSSProperties = { color: 'rgba(223,238,255,0.5)', fontSize: 11, letterSpacing: '0.08em' }
const primaryBtn: CSSProperties = { marginTop: 4, cursor: 'pointer', padding: '12px 30px', font: '700 15px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.2em', color: '#05060b', background: '#9bff4d', border: 'none', borderRadius: 999, boxShadow: '0 0 22px rgba(155,255,77,0.6)' }
const ghostBtn: CSSProperties = { cursor: 'pointer', padding: '10px 22px', font: '700 12px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.9)', background: 'transparent', border: '1px solid rgba(223,238,255,0.4)', borderRadius: 999 }
