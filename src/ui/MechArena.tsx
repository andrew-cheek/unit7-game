import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { loadHighScore, saveHighScore } from '../game/storage'
import { miniSfx } from './miniSound'

/**
 * Mech Arena - a neon top-down arena where you pilot a mech against waves of
 * target drones. Drag (or WASD) to move; the mech auto-fires at the nearest
 * drone. Destroy them for score; if one reaches you it costs a life (3). Waves
 * escalate. Fixed virtual field letterboxed onto the canvas. High score persists.
 */

const FW = 400, FH = 400
const HS_KEY = 'mecharena'

type Phase = 'ready' | 'playing' | 'dead'
interface Drone { x: number; y: number; hp: number; alive: boolean }
interface Bolt { x: number; y: number; vx: number; vy: number }

export function MechArena({ onExit, touch }: { onExit: () => void; touch: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [phase, setPhase] = useState<Phase>('ready')
  const [score, setScore] = useState(0)
  const [lives, setLives] = useState(3)
  const [best, setBest] = useState(() => loadHighScore(HS_KEY))

  const phaseRef = useRef<Phase>('ready')
  const mech = useRef({ x: FW / 2, y: FH / 2 })
  const target = useRef({ x: FW / 2, y: FH / 2 })
  const keys = useRef({ x: 0, y: 0 })
  const drones = useRef<Drone[]>([])
  const bolts = useRef<Bolt[]>([])
  const fireCd = useRef(0)
  const spawnCd = useRef(1)
  const elapsed = useRef(0)
  const scoreRef = useRef(0)
  const livesRef = useRef(3)
  const last = useRef(0)

  const start = useCallback(() => {
    mech.current = { x: FW / 2, y: FH / 2 }; target.current = { x: FW / 2, y: FH / 2 }
    drones.current = []; bolts.current = []
    fireCd.current = 0; spawnCd.current = 1; elapsed.current = 0
    scoreRef.current = 0; setScore(0)
    livesRef.current = 3; setLives(3)
    phaseRef.current = 'playing'; setPhase('playing')
  }, [])

  const die = useCallback(() => {
    phaseRef.current = 'dead'; setPhase('dead')
    miniSfx('gameover')
    saveHighScore(HS_KEY, scoreRef.current); setBest(loadHighScore(HS_KEY))
  }, [])

  // input
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'a' || e.key === 'ArrowLeft') keys.current.x = -1
      else if (e.key === 'd' || e.key === 'ArrowRight') keys.current.x = 1
      else if (e.key === 'w' || e.key === 'ArrowUp') keys.current.y = -1
      else if (e.key === 's' || e.key === 'ArrowDown') keys.current.y = 1
      else if (e.key === 'Enter' || e.key === ' ') { if (phaseRef.current !== 'playing') start() }
      else if (e.key === 'Escape') onExit()
    }
    const up = (e: KeyboardEvent) => {
      if ((e.key === 'a' || e.key === 'ArrowLeft') && keys.current.x === -1) keys.current.x = 0
      if ((e.key === 'd' || e.key === 'ArrowRight') && keys.current.x === 1) keys.current.x = 0
      if ((e.key === 'w' || e.key === 'ArrowUp') && keys.current.y === -1) keys.current.y = 0
      if ((e.key === 's' || e.key === 'ArrowDown') && keys.current.y === 1) keys.current.y = 0
    }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [start, onExit])

  const dragging = useRef(false)
  const mapPt = (cx: number, cy: number) => {
    const cv = canvasRef.current; if (!cv) return target.current
    const r = cv.getBoundingClientRect()
    const scale = Math.min(r.width / FW, r.height / FH)
    const ox = (r.width - FW * scale) / 2, oy = (r.height - FH * scale) / 2
    return { x: (cx - r.left - ox) / scale, y: (cy - r.top - oy) / scale }
  }
  const onDown = (e: React.PointerEvent) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); target.current = mapPt(e.clientX, e.clientY) }
  const onMove = (e: React.PointerEvent) => { if (dragging.current) target.current = mapPt(e.clientX, e.clientY) }
  const onUp = () => { dragging.current = false }

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
      elapsed.current += dt
      const m = mech.current
      // movement: keyboard takes priority, else ease toward drag target
      if (keys.current.x || keys.current.y) {
        const len = Math.hypot(keys.current.x, keys.current.y) || 1
        m.x += (keys.current.x / len) * 200 * dt
        m.y += (keys.current.y / len) * 200 * dt
      } else {
        m.x += (target.current.x - m.x) * Math.min(1, dt * 9)
        m.y += (target.current.y - m.y) * Math.min(1, dt * 9)
      }
      m.x = Math.max(16, Math.min(FW - 16, m.x)); m.y = Math.max(16, Math.min(FH - 16, m.y))

      // spawn drones from edges, faster over time
      spawnCd.current -= dt
      if (spawnCd.current <= 0) {
        spawnCd.current = Math.max(0.35, 1.3 - elapsed.current * 0.02)
        const edge = Math.floor(Math.random() * 4)
        const x = edge === 0 ? 8 : edge === 1 ? FW - 8 : Math.random() * FW
        const y = edge === 2 ? 8 : edge === 3 ? FH - 8 : Math.random() * FH
        drones.current.push({ x, y, hp: 1, alive: true })
      }
      // drones home in on the mech
      for (const d of drones.current) {
        if (!d.alive) continue
        const dx = m.x - d.x, dy = m.y - d.y
        const dd = Math.hypot(dx, dy) || 1
        d.x += (dx / dd) * 58 * dt; d.y += (dy / dd) * 58 * dt
        if (dd < 16) { d.alive = false; livesRef.current -= 1; setLives(livesRef.current); if (livesRef.current <= 0) { die(); return } }
      }
      // auto-fire at nearest drone
      fireCd.current -= dt
      if (fireCd.current <= 0) {
        let best: Drone | null = null, bd = 1e9
        for (const d of drones.current) { if (!d.alive) continue; const q = (d.x - m.x) ** 2 + (d.y - m.y) ** 2; if (q < bd) { bd = q; best = d } }
        if (best) {
          fireCd.current = 0.22
          const dx = best.x - m.x, dy = best.y - m.y, dd = Math.hypot(dx, dy) || 1
          bolts.current.push({ x: m.x, y: m.y, vx: (dx / dd) * 380, vy: (dy / dd) * 380 })
          miniSfx('shoot')
        }
      }
      for (const b of bolts.current) { b.x += b.vx * dt; b.y += b.vy * dt }
      bolts.current = bolts.current.filter((b) => b.x > -10 && b.x < FW + 10 && b.y > -10 && b.y < FH + 10)
      // bolt -> drone
      for (const b of bolts.current) {
        for (const d of drones.current) {
          if (d.alive && Math.abs(d.x - b.x) < 12 && Math.abs(d.y - b.y) < 12) {
            d.alive = false; b.x = -100
            scoreRef.current += 10; setScore(scoreRef.current)
            miniSfx('hit')
            break
          }
        }
      }
      drones.current = drones.current.filter((d) => d.alive)
    }

    const render = () => {
      const cv = canvasRef.current; if (!cv) return
      const ctx = cv.getContext('2d'); if (!ctx) return
      const W = cv.width, H = cv.height
      ctx.fillStyle = '#05060b'; ctx.fillRect(0, 0, W, H)
      const scale = Math.min(W / FW, H / FH)
      const ox = (W - FW * scale) / 2, oy = (H - FH * scale) / 2
      ctx.save(); ctx.translate(ox, oy); ctx.scale(scale, scale)
      ctx.fillStyle = '#080b13'; ctx.fillRect(0, 0, FW, FH)
      // arena grid
      ctx.strokeStyle = 'rgba(255,138,30,0.12)'; ctx.lineWidth = 1
      for (let i = 40; i < FW; i += 40) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, FH); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(FW, i); ctx.stroke() }
      ctx.strokeStyle = '#ff8a1e'; ctx.lineWidth = 2.5; ctx.strokeRect(2, 2, FW - 4, FH - 4)
      // drones
      for (const d of drones.current) {
        ctx.fillStyle = '#ff2bd0'
        ctx.beginPath(); ctx.moveTo(d.x, d.y - 8); ctx.lineTo(d.x + 8, d.y); ctx.lineTo(d.x, d.y + 8); ctx.lineTo(d.x - 8, d.y); ctx.closePath(); ctx.fill()
      }
      // bolts
      ctx.fillStyle = '#27e7ff'
      for (const b of bolts.current) ctx.fillRect(b.x - 2, b.y - 2, 4, 4)
      // mech
      const m = mech.current
      ctx.save(); ctx.shadowColor = '#27e7ff'; ctx.shadowBlur = 12; ctx.fillStyle = '#27e7ff'
      ctx.fillRect(m.x - 9, m.y - 9, 18, 18)
      ctx.fillStyle = '#eaf6ff'; ctx.fillRect(m.x - 4, m.y - 11, 8, 4)
      ctx.restore()
      ctx.restore()
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [die])

  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return
    const fit = () => { const r = cv.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2); cv.width = Math.max(1, Math.floor(r.width * dpr)); cv.height = Math.max(1, Math.floor(r.height * dpr)) }
    fit(); window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  return (
    <div style={root}>
      <canvas ref={canvasRef} style={canvasStyle} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      <div style={titleBar}><span style={{ color: '#ff8a1e', textShadow: '0 0 14px #ff8a1e' }}>MECH</span><span style={{ color: '#27e7ff', textShadow: '0 0 14px #27e7ff' }}> ARENA</span></div>
      <div style={scorePill}>SCORE {score} · LIVES {lives} · BEST {best}</div>
      <button style={exitBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>
      {phase === 'ready' && (
        <Panel>
          <div style={panelTitle}>MECH ARENA</div>
          <div style={panelText}>Pilot the mech against waves of target drones. Auto-fire locks the nearest drone; don't let them reach you.</div>
          <div style={panelHint}>{touch ? 'Drag to move' : 'WASD / Arrows to move'}</div>
          <button style={primaryBtn} onClick={start}>START</button>
        </Panel>
      )}
      {phase === 'dead' && (
        <Panel>
          <div style={{ ...panelTitle, color: '#ff2bd0', textShadow: '0 0 16px #ff2bd0' }}>OVERRUN</div>
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
const exitBtn: CSSProperties = { position: 'absolute', top: 14, right: 14, zIndex: 32, cursor: 'pointer', padding: '8px 14px', font: '700 11px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em', color: 'rgba(223,238,255,0.92)', background: 'rgba(8,12,24,0.7)', border: '1px solid rgba(255,138,30,0.5)', borderRadius: 999 }
const panel: CSSProperties = { position: 'relative', zIndex: 31, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '28px 34px', background: 'rgba(6,9,18,0.82)', border: '1px solid rgba(255,138,30,0.4)', borderRadius: 16, boxShadow: '0 0 40px rgba(255,138,30,0.16)', textAlign: 'center', maxWidth: 360 }
const panelTitle: CSSProperties = { font: '800 30px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.18em', color: '#ff8a1e', textShadow: '0 0 16px #ff8a1e' }
const panelText: CSSProperties = { color: 'rgba(223,238,255,0.8)', fontSize: 13, lineHeight: 1.5 }
const panelHint: CSSProperties = { color: 'rgba(223,238,255,0.5)', fontSize: 11, letterSpacing: '0.08em' }
const primaryBtn: CSSProperties = { marginTop: 4, cursor: 'pointer', padding: '12px 30px', font: '700 15px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.2em', color: '#05060b', background: '#ff8a1e', border: 'none', borderRadius: 999, boxShadow: '0 0 22px rgba(255,138,30,0.6)' }
const ghostBtn: CSSProperties = { cursor: 'pointer', padding: '10px 22px', font: '700 12px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.9)', background: 'transparent', border: '1px solid rgba(223,238,255,0.4)', borderRadius: 999 }
