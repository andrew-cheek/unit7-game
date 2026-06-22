import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { loadHighScore, saveHighScore } from '../game/storage'
import { miniSfx } from './miniSound'

/**
 * Drive Frenzy — a self-contained physics driving game (a "Drive Mad"-style
 * obstacle course) across 37 medium-difficulty levels. Hold gas to accelerate;
 * crest ramps and jumps send you airborne where gas/brake tilt the car so you
 * land flat. Reach the finish flag without flipping. Its own canvas loop,
 * isolated from the 3D engine; calls onExit to hand control back to the city.
 * Furthest level reached persists per device.
 */

const TOTAL = 37
const HS_KEY = 'drivemad'
const RIDE = 24, WB = 22, WY = 12, R = 12, BL = 46, BH = 16

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
function angDiff(a: number, b: number) { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d }
function mulberry32(a: number) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

interface Seg { x1: number; x2: number; h1?: number; h2?: number; gap?: boolean }
interface Level { segs: Seg[]; startX: number; finishX: number }
interface Car { x: number; y: number; ang: number; vx: number; vy: number; av: number; speed: number; onGround: boolean }
interface Part { x: number; y: number; vx: number; vy: number; life: number; r: number }

function buildLevel(n: number): Level {
  const r = mulberry32(1000 + n * 7), d = Math.min(0.95, 0.32 + n * 0.017), segs: Seg[] = []
  let x = 0, h = 0
  const push = (nx: number, nh: number) => { segs.push({ x1: x, h1: h, x2: nx, h2: nh }); x = nx; h = nh }
  push(220, 0)
  const feats = 5 + Math.floor(n / 3)
  for (let i = 0; i < feats; i++) {
    const p = r(), len = 90 + r() * 70
    if (p < 0.28) { const hh = (38 + r() * 60) * (0.6 + d * 0.6); push(x + len * 0.5, h + hh); push(x + len * 0.5, h) }
    else if (p < 0.48) { const dh = (28 + r() * 55) * (0.5 + d) * (r() < 0.5 ? 1 : -1); push(x + len, h + dh) }
    else if (p < 0.66) { const k = 2 + ((r() * 3) | 0); for (let j = 0; j < k; j++) { const bh = (12 + r() * 18) * (0.6 + d); push(x + 34, h + bh); push(x + 34, h) } }
    else if (p < 0.82) { push(x + 80, h + (30 + r() * 22) * (0.6 + d)); const gw = (70 + r() * 70) * (0.5 + d * 0.5); segs.push({ gap: true, x1: x, x2: x + gw }); x += gw; push(x + 170, h) }
    else if (p < 0.91) { const wh = (24 + r() * 20) * (0.5 + d); push(x + 12, h + wh); push(x + 95, h + wh * 0.2) }
    else { const dr = (30 + r() * 45) * (0.6 + d); push(x + 44, h); push(x + 10, h - dr); push(x + 130, h - dr) }
    push(x + 70 + r() * 40, h)
  }
  push(x + 240, h)
  return { segs, startX: 60, finishX: x - 90 }
}
function groundH(L: Level, x: number): number | null {
  for (const s of L.segs) { if (s.gap) { if (x >= s.x1 && x <= s.x2) return null; continue } if (x >= s.x1 && x <= s.x2) { const t = (x - s.x1) / Math.max(1e-6, s.x2 - s.x1); return s.h1! + (s.h2! - s.h1!) * t } } return 0
}
function gy(L: Level, x: number): number | null { const h = groundH(L, x); return h === null ? null : -h }
function slopeR(L: Level, x: number): number { for (const s of L.segs) { if (!s.gap && x >= s.x1 && x <= s.x2) return Math.atan2(-(s.h2! - s.h1!), (s.x2 - s.x1) || 1e-6) } return 0 }

export function DriveMad({ onExit, touch }: { onExit: () => void; touch: boolean }) {
  const cvRef = useRef<HTMLCanvasElement>(null)
  const [level, setLevel] = useState(1)
  const [best, setBest] = useState(() => loadHighScore(HS_KEY))
  const [msg, setMsg] = useState<{ title: string; body: string; crash: boolean; next: boolean } | null>(null)

  const Lref = useRef<Level>(buildLevel(1))
  const carRef = useRef<Car | null>(null)
  const stateRef = useRef<'play' | 'win' | 'crash'>('play')
  const cam = useRef({ x: 0, y: 0 })
  const parts = useRef<Part[]>([])
  const input = useRef({ gas: false, brake: false })
  const levelRef = useRef(1)
  const loadRef = useRef<(n: number) => void>(() => {})

  useEffect(() => {
    const cv = cvRef.current!
    const ctx = cv.getContext('2d')!
    let raf = 0, last = performance.now(), acc = 0
    let W = 1, H = 1, DPR = 1

    const fit = () => {
      const r = cv.getBoundingClientRect()
      DPR = Math.min(window.devicePixelRatio || 1, 2)
      W = Math.max(1, r.width); H = Math.max(1, r.height)
      cv.width = Math.floor(W * DPR); cv.height = Math.floor(H * DPR)
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    }
    fit(); window.addEventListener('resize', fit)

    const load = (n: number) => {
      const lv = clamp(n, 1, TOTAL)
      levelRef.current = lv; setLevel(lv)
      const L = buildLevel(lv); Lref.current = L
      const g = gy(L, L.startX + 40) || 0
      carRef.current = { x: L.startX + 40, y: g - RIDE, ang: slopeR(L, L.startX + 40), vx: 0, vy: 0, av: 0, speed: 0, onGround: true }
      stateRef.current = 'play'; parts.current = []
      cam.current.x = carRef.current.x - W * 0.34; cam.current.y = carRef.current.y - H * 0.56
      setMsg(null); miniSfx('start')
    }
    loadRef.current = load
    load(levelRef.current)

    const crash = () => { if (stateRef.current !== 'play') return; stateRef.current = 'crash'; miniSfx('gameover'); setMsg({ title: 'CRASHED!', body: 'Ease off the gas and land flat.', crash: true, next: false }) }
    const win = () => {
      if (stateRef.current !== 'play') return; stateRef.current = 'win'; miniSfx('score')
      const lv = levelRef.current
      if (lv > loadHighScore(HS_KEY)) { saveHighScore(HS_KEY, lv); setBest(lv) }
      setMsg({ title: lv >= TOTAL ? 'YOU BEAT ALL 37!' : 'LEVEL COMPLETE', body: lv >= TOTAL ? 'Champion driver.' : 'Nice driving.', crash: false, next: lv < TOTAL })
    }

    const step = (dt: number) => {
      if (stateRef.current !== 'play') return
      const c = carRef.current!, L = Lref.current
      if (c.onGround) {
        const drive = (input.current.gas ? 1 : 0) - (input.current.brake ? 1 : 0)
        if (drive > 0) c.speed += 560 * dt
        else if (drive < 0) c.speed -= 440 * dt
        else c.speed -= Math.sign(c.speed) * Math.min(Math.abs(c.speed), 200 * dt)
        c.speed = clamp(c.speed, -150, 470)
        c.x += c.speed * dt
        const ghr = gy(L, c.x)
        if (ghr === null) { c.onGround = false; c.vx = c.speed; c.vy = c.speed * Math.sin(c.ang) }
        else {
          const sl = slopeR(L, c.x), tgt = ghr - RIDE
          const ah = gy(L, c.x + Math.max(8, c.speed * dt * 2.2))
          if (ah !== null && c.speed > 170 && (ah - RIDE) - c.y > Math.abs(c.speed) * dt * 1.6) { c.onGround = false; c.vx = c.speed * Math.cos(sl); c.vy = c.speed * Math.sin(sl) }
          else { c.y = tgt; c.ang += angDiff(sl + (input.current.gas ? -0.16 : 0) + (input.current.brake ? 0.12 : 0), c.ang) * Math.min(1, 14 * dt) }
        }
        if (c.onGround && input.current.gas && Math.random() < 0.4) parts.current.push({ x: c.x - Math.cos(c.ang) * WB, y: c.y + RIDE - 2, vx: -c.speed * 0.2 - 20, vy: -30 - Math.random() * 40, life: 0.5, r: 2 + Math.random() * 3 })
      } else {
        c.av += ((input.current.brake ? 1 : 0) - (input.current.gas ? 1 : 0)) * 7 * dt
        c.av *= 1 - 0.4 * dt; c.ang += c.av * dt
        c.vy += 1700 * dt; c.x += c.vx * dt; c.y += c.vy * dt
        const ghr = gy(L, c.x)
        if (ghr !== null) { const tgt = ghr - RIDE; if (c.y >= tgt && c.vy >= 0) { const sl = slopeR(L, c.x); if (Math.abs(angDiff(c.ang, sl)) > 1.15) crash(); else { c.onGround = true; c.y = tgt; c.ang = sl; c.av = 0; c.speed = Math.max(c.vx, 80) } } }
      }
      if (Math.abs(angDiff(c.ang, 0)) > 2.3) crash()
      if (c.y > 1600) crash()
      if (c.x > L.finishX) win()
      for (const p of parts.current) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 700 * dt }
      parts.current = parts.current.filter((p) => p.life > 0)
    }

    const rr = (x: number, y: number, w: number, h: number, rad: number) => { ctx.beginPath(); ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad); ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath() }

    const draw = () => {
      const c = carRef.current!, L = Lref.current
      cam.current.x += (c.x - W * 0.34 - cam.current.x) * 0.12
      cam.current.y += (c.y - H * 0.56 - cam.current.y) * 0.12
      const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#0e2b63'); g.addColorStop(0.6, '#23408c'); g.addColorStop(1, '#6f8fd0')
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = 'rgba(18,36,84,0.55)'
      for (let i = 0; i < 9; i++) { const cxp = i * 230 - ((cam.current.x * 0.35) % 230); ctx.beginPath(); ctx.arc(cxp, H * 0.76, 160, Math.PI, 0); ctx.fill() }
      ctx.save(); ctx.translate(-cam.current.x, -cam.current.y)
      let run: number[][] | null = null
      const base = 4000
      const flush = () => {
        if (!run || run.length < 2) { run = null; return }
        ctx.beginPath(); ctx.moveTo(run[0][0], run[0][1]); for (let i = 1; i < run.length; i++) ctx.lineTo(run[i][0], run[i][1])
        ctx.lineTo(run[run.length - 1][0], base); ctx.lineTo(run[0][0], base); ctx.closePath(); ctx.fillStyle = '#2e7d4a'; ctx.fill()
        ctx.beginPath(); ctx.moveTo(run[0][0], run[0][1]); for (let i = 1; i < run.length; i++) ctx.lineTo(run[i][0], run[i][1]); ctx.lineWidth = 6; ctx.strokeStyle = '#1f6f3a'; ctx.stroke(); run = null
      }
      for (const s of L.segs) { if (s.gap) { flush(); continue } if (!run) run = [[s.x1, -s.h1!]]; run.push([s.x2, -s.h2!]) }
      flush()
      const fyr = gy(L, L.finishX) || 0
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(L.finishX, fyr); ctx.lineTo(L.finishX, fyr - 74); ctx.stroke()
      ctx.fillStyle = '#ff2bd0'; ctx.fillRect(L.finishX, fyr - 74, 36, 24)
      ctx.fillStyle = 'rgba(210,225,170,0.7)'
      for (const p of parts.current) { ctx.globalAlpha = Math.max(0, p.life * 1.6); ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill() }
      ctx.globalAlpha = 1
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.ang)
      ctx.fillStyle = '#10131a'
      for (const w of [[-WB, WY], [WB, WY]]) { ctx.beginPath(); ctx.arc(w[0], w[1], R, 0, 7); ctx.fill(); ctx.strokeStyle = '#9fb3c8'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(w[0], w[1], R * 0.5, 0, 7); ctx.stroke() }
      ctx.fillStyle = '#e23b4e'; rr(-BL / 2, -BH / 2, BL, BH, 5); ctx.fill()
      ctx.fillStyle = '#27e7ff'; rr(2, -BH / 2 - 9, BL / 2 - 8, 11, 4); ctx.fill()
      ctx.fillStyle = '#b3263a'; ctx.fillRect(-BL / 2, -2, BL, 4)
      ctx.restore(); ctx.restore()
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const rawDt = Math.min(0.05, (now - last) / 1000); last = now; acc += rawDt
      let i = 0
      while (acc >= 1 / 120 && i++ < 12) { step(1 / 120); acc -= 1 / 120 }
      draw()
    }
    raf = requestAnimationFrame(loop)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'ArrowRight' || e.code === 'KeyD') input.current.gas = true
      else if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.current.brake = true
      else if (e.code === 'KeyR') load(levelRef.current)
      else if (e.code === 'Escape') onExit()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'ArrowRight' || e.code === 'KeyD') input.current.gas = false
      else if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.current.brake = false
    }
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', fit); window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pad = (k: 'gas' | 'brake') => ({
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); input.current[k] = true },
    onPointerUp: (e: React.PointerEvent) => { e.preventDefault(); input.current[k] = false },
    onPointerCancel: () => { input.current[k] = false },
    onPointerLeave: () => { input.current[k] = false },
  })

  return (
    <div style={root}>
      <canvas ref={cvRef} style={canvasStyle} />
      <div style={titleBar}><span style={{ color: '#27e7ff', textShadow: '0 0 14px #27e7ff' }}>DRIVE FRENZY</span></div>
      <div style={scorePill}>LEVEL {level} / {TOTAL} · BEST {best}</div>
      <button style={exitBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>
      {touch && (
        <div style={btns}>
          <div style={padBox} {...pad('brake')}><div style={padDot}>◀</div></div>
          <div style={padBox} {...pad('gas')}><div style={padDot}>▶</div></div>
        </div>
      )}
      <div style={hint}>{touch ? '▶ gas · ◀ brake · (in air: tilt)' : '▶/D gas · ◀/A brake · in air: tilt to land flat · R restart'}</div>
      {msg && (
        <div style={panel}>
          <div style={{ ...panelTitle, color: msg.crash ? '#ff5c7a' : '#9bff4d', textShadow: `0 0 16px ${msg.crash ? '#ff5c7a' : '#9bff4d'}` }}>{msg.title}</div>
          <div style={panelText}>{msg.body}</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            {msg.next && <button style={primaryBtn} onClick={() => loadRef.current(levelRef.current + 1)}>NEXT ▸</button>}
            <button style={primaryBtn} onClick={() => loadRef.current(levelRef.current)}>{msg.crash ? 'RETRY' : 'REPLAY'}</button>
            <button style={ghostBtn} onClick={onExit}>EXIT</button>
          </div>
        </div>
      )}
    </div>
  )
}

const root: CSSProperties = { position: 'absolute', inset: 0, zIndex: 30, background: '#0b1020', overflow: 'hidden', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', touchAction: 'none' }
const canvasStyle: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }
const titleBar: CSSProperties = { position: 'absolute', top: 14, left: 0, right: 0, textAlign: 'center', font: '800 20px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.26em', pointerEvents: 'none' }
const scorePill: CSSProperties = { position: 'absolute', top: 44, left: 0, right: 0, textAlign: 'center', font: '700 12px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.85)', pointerEvents: 'none' }
const hint: CSSProperties = { position: 'absolute', bottom: 8, left: 0, right: 0, textAlign: 'center', font: '600 11px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.08em', color: 'rgba(223,238,255,0.5)', pointerEvents: 'none' }
const exitBtn: CSSProperties = { position: 'absolute', top: 12, right: 12, zIndex: 32, cursor: 'pointer', padding: '8px 14px', font: '700 11px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em', color: 'rgba(223,238,255,0.92)', background: 'rgba(8,12,24,0.7)', border: '1px solid rgba(39,231,255,0.5)', borderRadius: 999 }
const btns: CSSProperties = { position: 'absolute', bottom: 0, left: 0, right: 0, height: '34%', display: 'flex', justifyContent: 'space-between', pointerEvents: 'none' }
const padBox: CSSProperties = { pointerEvents: 'auto', width: '44%', height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 22 }
const padDot: CSSProperties = { width: 84, height: 84, borderRadius: '50%', background: 'rgba(255,255,255,0.12)', border: '2px solid rgba(255,255,255,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, fontWeight: 800, color: '#dff0ff', opacity: 0.55 }
const panel: CSSProperties = { position: 'absolute', inset: 0, zIndex: 31, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: 'rgba(6,10,22,0.6)', textAlign: 'center' }
const panelTitle: CSSProperties = { font: '800 32px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em' }
const panelText: CSSProperties = { color: 'rgba(223,238,255,0.85)', fontSize: 13 }
const primaryBtn: CSSProperties = { cursor: 'pointer', padding: '12px 24px', font: '800 14px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: '#04121a', background: 'linear-gradient(180deg,#5cf0ff,#27e7ff)', border: 'none', borderRadius: 10 }
const ghostBtn: CSSProperties = { cursor: 'pointer', padding: '12px 18px', font: '700 12px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em', color: 'rgba(223,238,255,0.9)', background: 'transparent', border: '1px solid rgba(223,238,255,0.4)', borderRadius: 10 }
