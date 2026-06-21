import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { loadHighScore, saveHighScore } from '../game/storage'

/**
 * Race Loop - a neon top-down lap racer around a glowing oval. Auto-throttle;
 * you just steer left/right. Stay on the track (off-track = slow), hit the boost
 * arcs, and complete as many laps as you can before the timer runs out. Fixed
 * virtual field letterboxed onto the canvas so it plays the same everywhere.
 */

const FW = 400, FH = 400
const CX = 200, CY = 200, RX = 150, RY = 116
const INNER = 0.62, OUTER = 1.02 // on-track ellipse band (normalized radius)
const HS_KEY = 'raceloop'
const RACE_TIME = 60

type Phase = 'ready' | 'playing' | 'done'

export function RaceLoop({ onExit, touch }: { onExit: () => void; touch: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [phase, setPhase] = useState<Phase>('ready')
  const [laps, setLaps] = useState(0)
  const [timeLeft, setTimeLeft] = useState(RACE_TIME)
  const [best, setBest] = useState(() => loadHighScore(HS_KEY))

  const phaseRef = useRef<Phase>('ready')
  const car = useRef({ x: CX + RX * 0.82, y: CY, heading: Math.PI / 2, speed: 0 })
  const steer = useRef(0) // -1 left, +1 right
  const leftPassed = useRef(false)
  const lapsRef = useRef(0)
  const timeRef = useRef(RACE_TIME)
  const last = useRef(0)

  const ntOf = (x: number, y: number) => Math.hypot((x - CX) / RX, (y - CY) / RY)

  const start = useCallback(() => {
    car.current = { x: CX + RX * 0.82, y: CY, heading: Math.PI / 2, speed: 0 }
    steer.current = 0
    leftPassed.current = false
    lapsRef.current = 0; setLaps(0)
    timeRef.current = RACE_TIME; setTimeLeft(RACE_TIME)
    phaseRef.current = 'playing'; setPhase('playing')
  }, [])

  // input
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a') steer.current = -1
      else if (e.key === 'ArrowRight' || e.key === 'd') steer.current = 1
      else if (e.key === 'Enter' || e.key === ' ') { if (phaseRef.current !== 'playing') start() }
      else if (e.key === 'Escape') onExit()
    }
    const up = (e: KeyboardEvent) => {
      if ((e.key === 'ArrowLeft' || e.key === 'a') && steer.current === -1) steer.current = 0
      if ((e.key === 'ArrowRight' || e.key === 'd') && steer.current === 1) steer.current = 0
    }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [start, onExit])

  // touch: left/right screen halves steer
  const setSteerFromX = (clientX: number) => {
    const cv = canvasRef.current
    if (!cv) return
    const r = cv.getBoundingClientRect()
    steer.current = clientX - r.left < r.width / 2 ? -1 : 1
  }
  const onDown = (e: React.PointerEvent) => setSteerFromX(e.clientX)
  const onMove = (e: React.PointerEvent) => { if (e.pressure > 0 || e.buttons) setSteerFromX(e.clientX) }
  const onUp = () => { steer.current = 0 }

  // loop
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
      timeRef.current -= dt
      if (timeRef.current <= 0) {
        timeRef.current = 0
        phaseRef.current = 'done'; setPhase('done')
        saveHighScore(HS_KEY, lapsRef.current); setBest(loadHighScore(HS_KEY))
        return
      }
      setTimeLeft(Math.ceil(timeRef.current))
      const c = car.current
      const nt = ntOf(c.x, c.y)
      const onTrack = nt > INNER && nt < OUTER
      // boost arc on the back straight (left side of the loop)
      const theta = Math.atan2(c.y - CY, c.x - CX)
      const boosting = onTrack && theta > Math.PI * 0.6
      const maxSpeed = (onTrack ? 165 : 70) * (boosting ? 1.5 : 1)
      c.speed += (maxSpeed - c.speed) * Math.min(1, dt * (onTrack ? 2.2 : 4))
      c.heading += steer.current * 2.6 * dt
      const prevY = c.y
      c.x += Math.cos(c.heading) * c.speed * dt
      c.y += Math.sin(c.heading) * c.speed * dt
      // keep the car from escaping the world
      c.x = Math.max(10, Math.min(FW - 10, c.x)); c.y = Math.max(10, Math.min(FH - 10, c.y))
      // lap: crossing the right-side start line downward, after going round the far side
      if (c.x < CX - RX * 0.3) leftPassed.current = true
      if (c.x > CX && prevY < CY && c.y >= CY && leftPassed.current) {
        lapsRef.current += 1; setLaps(lapsRef.current); leftPassed.current = false
      }
    }

    const render = () => {
      const cv = canvasRef.current
      if (!cv) return
      const ctx = cv.getContext('2d'); if (!ctx) return
      const W = cv.width, H = cv.height
      ctx.fillStyle = '#05060b'; ctx.fillRect(0, 0, W, H)
      const scale = Math.min(W / FW, H / FH)
      const ox = (W - FW * scale) / 2, oy = (H - FH * scale) / 2
      ctx.save(); ctx.translate(ox, oy); ctx.scale(scale, scale)
      // track ring: outer ellipse filled, inner punched out
      ctx.fillStyle = '#10131c'
      ctx.beginPath(); ctx.ellipse(CX, CY, RX * OUTER, RY * OUTER, 0, 0, 7); ctx.fill()
      ctx.fillStyle = '#080b13'
      ctx.beginPath(); ctx.ellipse(CX, CY, RX * INNER, RY * INNER, 0, 0, 7); ctx.fill()
      // glowing rails
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#27e7ff'; ctx.shadowColor = '#27e7ff'; ctx.shadowBlur = 10
      ctx.beginPath(); ctx.ellipse(CX, CY, RX * OUTER, RY * OUTER, 0, 0, 7); ctx.stroke()
      ctx.strokeStyle = '#ff2bd0'; ctx.shadowColor = '#ff2bd0'
      ctx.beginPath(); ctx.ellipse(CX, CY, RX * INNER, RY * INNER, 0, 0, 7); ctx.stroke()
      ctx.shadowBlur = 0
      // start/finish line (right side)
      ctx.strokeStyle = '#eaf6ff'; ctx.lineWidth = 4
      ctx.beginPath(); ctx.moveTo(CX + RX * INNER, CY); ctx.lineTo(CX + RX * OUTER, CY); ctx.stroke()
      // boost arrows on the back straight
      ctx.fillStyle = 'rgba(155,255,77,0.8)'
      for (let i = 0; i < 3; i++) {
        const a = Math.PI * (0.78 + i * 0.12)
        const ax = CX + Math.cos(a) * RX * 0.82, ay = CY + Math.sin(a) * RY * 0.82
        ctx.save(); ctx.translate(ax, ay); ctx.rotate(a + Math.PI / 2)
        ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(5, 4); ctx.lineTo(-5, 4); ctx.closePath(); ctx.fill(); ctx.restore()
      }
      // car
      const c = car.current
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.heading + Math.PI / 2)
      ctx.shadowColor = '#ffd27f'; ctx.shadowBlur = 12; ctx.fillStyle = '#ffd27f'
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(6, 7); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill()
      ctx.restore()
      ctx.restore()
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // crisp backing store
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return
    const fit = () => { const r = cv.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2); cv.width = Math.max(1, Math.floor(r.width * dpr)); cv.height = Math.max(1, Math.floor(r.height * dpr)) }
    fit(); window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  return (
    <div style={root}>
      <canvas ref={canvasRef} style={canvasStyle} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      <div style={titleBar}><span style={{ color: '#ff2bd0', textShadow: '0 0 14px #ff2bd0' }}>RACE</span><span style={{ color: '#27e7ff', textShadow: '0 0 14px #27e7ff' }}> LOOP</span></div>
      <div style={scorePill}>LAPS {laps} · TIME {timeLeft}s · BEST {best}</div>
      <button style={exitBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>
      {phase === 'ready' && (
        <Panel>
          <div style={panelTitle}>RACE LOOP</div>
          <div style={panelText}>Auto-throttle. Steer to hold the track, hit the green boost arrows, bank as many laps as you can in {RACE_TIME}s.</div>
          <div style={panelHint}>{touch ? 'Tap left / right side to steer' : 'Left / Right arrows to steer'}</div>
          <button style={primaryBtn} onClick={start}>START</button>
        </Panel>
      )}
      {phase === 'done' && (
        <Panel>
          <div style={{ ...panelTitle, color: '#9bff4d', textShadow: '0 0 16px #9bff4d' }}>FINISH</div>
          <div style={panelText}>{laps} laps · Best {best}</div>
          <button style={primaryBtn} onClick={start}>RACE AGAIN</button>
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
const exitBtn: CSSProperties = { position: 'absolute', top: 14, right: 14, zIndex: 32, cursor: 'pointer', padding: '8px 14px', font: '700 11px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em', color: 'rgba(223,238,255,0.92)', background: 'rgba(8,12,24,0.7)', border: '1px solid rgba(255,43,208,0.5)', borderRadius: 999 }
const panel: CSSProperties = { position: 'relative', zIndex: 31, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '28px 34px', background: 'rgba(6,9,18,0.82)', border: '1px solid rgba(255,43,208,0.4)', borderRadius: 16, boxShadow: '0 0 40px rgba(255,43,208,0.16)', textAlign: 'center', maxWidth: 360 }
const panelTitle: CSSProperties = { font: '800 30px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.18em', color: '#ff2bd0', textShadow: '0 0 16px #ff2bd0' }
const panelText: CSSProperties = { color: 'rgba(223,238,255,0.8)', fontSize: 13, lineHeight: 1.5 }
const panelHint: CSSProperties = { color: 'rgba(223,238,255,0.5)', fontSize: 11, letterSpacing: '0.08em' }
const primaryBtn: CSSProperties = { marginTop: 4, cursor: 'pointer', padding: '12px 30px', font: '700 15px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.2em', color: '#05060b', background: '#ff2bd0', border: 'none', borderRadius: 999, boxShadow: '0 0 22px rgba(255,43,208,0.6)' }
const ghostBtn: CSSProperties = { cursor: 'pointer', padding: '10px 22px', font: '700 12px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.9)', background: 'transparent', border: '1px solid rgba(223,238,255,0.4)', borderRadius: 999 }
