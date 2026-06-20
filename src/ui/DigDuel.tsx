import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'

/**
 * DIG DUEL - an original game in the classic "two tanks digging through dirt"
 * style. The signature feel of that genre, recreated from the mechanics (no
 * original code or assets used):
 *
 *  - You only see a small window around your own tank. The rest of the field is
 *    unknown black - you navigate blind through the tunnels you've carved.
 *  - One ENERGY bar is both your fuel and your health. Driving and especially
 *    digging drains it; firing costs a chunk; getting shot costs a lot. It only
 *    recharges while you sit on your home base, so you must keep returning.
 *  - Tunnels are tank-width; digging is slow and deliberate, cruising open
 *    tunnels is fast. Find the enemy tank and drain its energy to zero.
 *
 * Self-contained canvas game; the city is paused while it runs. onExit returns
 * to Humanoid City.
 */

const COLS = 66
const ROWS = 46
const SIGHT = 7.5 // how far you can see around your tank (cells) - tight, on purpose
const DIG_BRUSH = 1.0 // tank-width tunnels
const MOVE_OPEN = 8 // cells/sec cruising a clear tunnel
const MOVE_DIG = 3.8 // cells/sec chewing fresh dirt
const BULLET_SPEED = 30
const ENERGY_MAX = 100
const HIT_COST = 26 // energy lost per shell hit (~4 hits kills)

type Phase = 'ready' | 'playing' | 'dead' | 'won'
interface Vec { x: number; y: number }
interface Tank { pos: Vec; dir: Vec; energy: number; cooldown: number }
interface Bullet { x: number; y: number; dx: number; dy: number; life: number; mine: boolean }

const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }

export function DigDuel({ onExit, touch }: { onExit: () => void; touch: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [phase, setPhase] = useState<Phase>('ready')
  const [, force] = useState(0)

  const dirt = useRef<Uint8Array>(new Uint8Array(COLS * ROWS)) // 1 = dirt, 0 = dug
  const player = useRef<Tank>(newTank())
  const bot = useRef<Tank>(newTank())
  const bullets = useRef<Bullet[]>([])
  const held = useRef<Vec | null>(null)
  const phaseRef = useRef<Phase>('ready')
  const botBrain = useRef(0)
  const last = useRef(0)
  const pBase = useRef<Vec>({ x: 5, y: ROWS - 5 })
  const bBase = useRef<Vec>({ x: COLS - 6, y: 5 })

  const di = (x: number, y: number) => y * COLS + x
  const inb = (x: number, y: number) => x >= 0 && x < COLS && y >= 0 && y < ROWS
  const isDirt = (x: number, y: number) => !inb(x, y) || dirt.current[di(x, y)] === 1

  const carve = (cx: number, cy: number, r: number) => {
    const r2 = r * r
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (!inb(x, y)) continue
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy <= r2) dirt.current[di(x, y)] = 0
      }
    }
  }

  const reset = useCallback(() => {
    dirt.current.fill(1)
    bullets.current = []
    const pb = pBase.current
    const bb = bBase.current
    player.current = { pos: { x: pb.x, y: pb.y }, dir: DIRS.up, energy: ENERGY_MAX, cooldown: 0 }
    bot.current = { pos: { x: bb.x, y: bb.y }, dir: DIRS.down, energy: ENERGY_MAX, cooldown: 0 }
    carve(pb.x, pb.y, 2.6)
    carve(bb.x, bb.y, 2.6)
    held.current = null
  }, [])

  const finish = (ph: Phase) => { phaseRef.current = ph; setPhase(ph) }
  const start = useCallback(() => { reset(); phaseRef.current = 'playing'; setPhase('playing'); last.current = performance.now() }, [reset])

  const shoot = (t: Tank, mine: boolean) => {
    if (t.energy < 8 || t.cooldown > 0) return
    t.energy -= 7
    t.cooldown = 0.32
    bullets.current.push({ x: t.pos.x + t.dir.x, y: t.pos.y + t.dir.y, dx: t.dir.x, dy: t.dir.y, life: 30, mine })
  }

  // --- input ---
  useEffect(() => {
    const set = (d: Vec) => { held.current = d; player.current.dir = d }
    const onDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp': case 'w': case 'W': set(DIRS.up); break
        case 'ArrowDown': case 's': case 'S': set(DIRS.down); break
        case 'ArrowLeft': case 'a': case 'A': set(DIRS.left); break
        case 'ArrowRight': case 'd': case 'D': set(DIRS.right); break
        case ' ': case 'Enter':
          if (phaseRef.current === 'playing') shoot(player.current, true); else start(); break
        case 'Escape': onExit(); break
      }
    }
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D']
    const onUp = (e: KeyboardEvent) => { if (keys.includes(e.key)) held.current = null }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
  }, [start, onExit])

  // --- loop ---
  useEffect(() => {
    let raf = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - last.current) / 1000 || 0)
      last.current = now
      if (phaseRef.current === 'playing') step(dt)
      draw()
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const driveTank = (t: Tank, dir: Vec | null, dt: number, base: Vec) => {
    const onBase = Math.hypot(t.pos.x - base.x, t.pos.y - base.y) < 2.8
    if (onBase) t.energy = Math.min(ENERGY_MAX, t.energy + 70 * dt) // recharge only at base
    t.cooldown = Math.max(0, t.cooldown - dt)
    if (!dir || t.energy <= 0) return
    const ax = Math.round(t.pos.x + dir.x * 0.8)
    const ay = Math.round(t.pos.y + dir.y * 0.8)
    const digging = isDirt(ax, ay)
    const speed = digging ? MOVE_DIG : MOVE_OPEN
    t.energy -= (digging ? 12 : 3) * dt
    carve(t.pos.x + dir.x, t.pos.y + dir.y, DIG_BRUSH)
    t.pos.x = Math.max(0.5, Math.min(COLS - 1.5, t.pos.x + dir.x * speed * dt))
    t.pos.y = Math.max(0.5, Math.min(ROWS - 1.5, t.pos.y + dir.y * speed * dt))
  }

  const step = (dt: number) => {
    driveTank(player.current, held.current, dt, pBase.current)
    stepBot(dt)

    const p = player.current
    const b = bot.current
    const live: Bullet[] = []
    for (const bl of bullets.current) {
      let alive = true
      const sub = Math.ceil(BULLET_SPEED * dt)
      for (let s = 0; s < sub; s++) {
        bl.x += (bl.dx * BULLET_SPEED * dt) / sub
        bl.y += (bl.dy * BULLET_SPEED * dt) / sub
        bl.life -= 1 / sub
        const cx = Math.round(bl.x)
        const cy = Math.round(bl.y)
        if (!inb(cx, cy) || bl.life <= 0) { alive = false; break }
        if (dirt.current[di(cx, cy)] === 1) dirt.current[di(cx, cy)] = 0 // shells chew dirt a little
        const tgt = bl.mine ? b : p
        if (Math.hypot(bl.x - tgt.pos.x, bl.y - tgt.pos.y) < 1.1) {
          tgt.energy -= HIT_COST
          alive = false
          break
        }
      }
      if (alive) live.push(bl)
    }
    bullets.current = live

    if (p.energy <= 0) return finish('dead')
    if (b.energy <= 0) return finish('won')
    force((n) => n + 1)
  }

  const stepBot = (dt: number) => {
    const b = bot.current
    const p = player.current
    botBrain.current -= dt
    if (botBrain.current <= 0) {
      botBrain.current = 0.3 + Math.random() * 0.3
      const dx = p.pos.x - b.pos.x
      const dy = p.pos.y - b.pos.y
      if (b.energy < 30) {
        const tx = bBase.current.x - b.pos.x
        const ty = bBase.current.y - b.pos.y
        b.dir = Math.abs(tx) > Math.abs(ty) ? (tx > 0 ? DIRS.right : DIRS.left) : (ty > 0 ? DIRS.down : DIRS.up)
      } else if (Math.random() < 0.8) {
        b.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? DIRS.right : DIRS.left) : (dy > 0 ? DIRS.down : DIRS.up)
      } else {
        b.dir = [DIRS.up, DIRS.down, DIRS.left, DIRS.right][Math.floor(Math.random() * 4)]
      }
      const aligned = (Math.abs(dx) < 1.6 && Math.sign(dy) === b.dir.y && b.dir.x === 0) ||
        (Math.abs(dy) < 1.6 && Math.sign(dx) === b.dir.x && b.dir.y === 0)
      if (aligned && Math.hypot(dx, dy) < 16 && Math.random() < 0.7) shoot(b, false)
    }
    driveTank(b, b.dir, dt, bBase.current)
  }

  const draw = () => {
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

    // Everything unknown is black; only the window around the player is drawn.
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)

    const p = player.current
    const r = Math.ceil(SIGHT)
    for (let y = Math.max(0, Math.floor(p.pos.y - r)); y <= Math.min(ROWS - 1, Math.ceil(p.pos.y + r)); y++) {
      for (let x = Math.max(0, Math.floor(p.pos.x - r)); x <= Math.min(COLS - 1, Math.ceil(p.pos.x + r)); x++) {
        const dist = Math.hypot(x - p.pos.x, y - p.pos.y)
        if (dist > SIGHT) continue
        const edge = dist > SIGHT - 1.4 ? 0.5 : 1 // soft vignette at the sight edge
        const dug = dirt.current[di(x, y)] === 0
        ctx.globalAlpha = edge
        ctx.fillStyle = dug ? '#0c1422' : '#3a2c18'
        ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell)
      }
    }
    ctx.globalAlpha = 1

    // Bases (only visible when within the window).
    drawBaseIfSeen(ctx, ox, oy, cell, pBase.current, '#27e7ff', p.pos)
    drawBaseIfSeen(ctx, ox, oy, cell, bBase.current, '#ff2bd0', p.pos)

    // Bullets within view.
    for (const bl of bullets.current) {
      if (Math.hypot(bl.x - p.pos.x, bl.y - p.pos.y) > SIGHT) continue
      ctx.fillStyle = bl.mine ? '#bfefff' : '#ffd0ec'
      ctx.fillRect(ox + bl.x * cell - 1, oy + bl.y * cell - 1, cell * 0.6, cell * 0.6)
    }

    // Tanks (enemy only when inside the window - the whole point of the fog).
    drawTank(ctx, ox, oy, cell, player.current, '#27e7ff')
    if (Math.hypot(bot.current.pos.x - p.pos.x, bot.current.pos.y - p.pos.y) < SIGHT) {
      drawTank(ctx, ox, oy, cell, bot.current, '#ff2bd0')
    }
  }

  return (
    <div style={root}>
      <canvas ref={canvasRef} style={canvasStyle} />

      <div style={titleBar}>
        <span style={{ color: '#ff8a1e', textShadow: '0 0 14px #ff8a1e' }}>DIG</span>
        <span style={{ color: '#9bff4d', textShadow: '0 0 14px #9bff4d' }}> DUEL</span>
      </div>
      <button style={exitBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>

      {phase === 'playing' && (
        <div style={readout}>
          <Meter label="ENERGY" v={player.current.energy / ENERGY_MAX} color="#27e7ff" />
        </div>
      )}

      {phase === 'ready' && (
        <Panel>
          <div style={panelTitle}>DIG DUEL</div>
          <div style={panelText}>You only see what's around you. Dig through the dirt, hunt the enemy tank, and drain its energy. Recharge on your blue base - and don't get caught empty.</div>
          <div style={panelHint}>{touch ? 'Pad to drive, FIRE to shoot' : 'Arrows / WASD drive · SPACE fires'}</div>
          <button style={primaryBtn} onClick={start}>START</button>
        </Panel>
      )}
      {phase === 'dead' && (
        <Panel>
          <div style={{ ...panelTitle, color: '#ff2bd0', textShadow: '0 0 16px #ff2bd0' }}>TANK DESTROYED</div>
          <button style={primaryBtn} onClick={start}>REPLAY</button>
          <button style={ghostBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>
        </Panel>
      )}
      {phase === 'won' && (
        <Panel>
          <div style={{ ...panelTitle, color: '#9bff4d', textShadow: '0 0 16px #9bff4d' }}>ENEMY DESTROYED</div>
          <button style={primaryBtn} onClick={start}>REPLAY</button>
          <button style={ghostBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>
        </Panel>
      )}

      {touch && phase === 'playing' && (
        <>
          <div style={dpad}>
            <DpadBtn label="▲" style={{ gridArea: 'up' }} onPress={() => { held.current = DIRS.up; player.current.dir = DIRS.up }} onRelease={() => { held.current = null }} />
            <DpadBtn label="◀" style={{ gridArea: 'left' }} onPress={() => { held.current = DIRS.left; player.current.dir = DIRS.left }} onRelease={() => { held.current = null }} />
            <DpadBtn label="▶" style={{ gridArea: 'right' }} onPress={() => { held.current = DIRS.right; player.current.dir = DIRS.right }} onRelease={() => { held.current = null }} />
            <DpadBtn label="▼" style={{ gridArea: 'down' }} onPress={() => { held.current = DIRS.down; player.current.dir = DIRS.down }} onRelease={() => { held.current = null }} />
          </div>
          <button style={fireBtn} onPointerDown={(e) => { e.preventDefault(); shoot(player.current, true) }}>FIRE</button>
        </>
      )}
    </div>
  )
}

function newTank(): Tank { return { pos: { x: 0, y: 0 }, dir: DIRS.up, energy: ENERGY_MAX, cooldown: 0 } }

function drawTank(ctx: CanvasRenderingContext2D, ox: number, oy: number, cell: number, t: Tank, color: string) {
  ctx.save()
  ctx.shadowColor = color
  ctx.shadowBlur = 12
  ctx.fillStyle = color
  const s = cell * 1.7
  ctx.fillRect(ox + t.pos.x * cell - s / 2, oy + t.pos.y * cell - s / 2, s, s)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(ox + t.pos.x * cell - cell * 0.22 + t.dir.x * cell * 1.1, oy + t.pos.y * cell - cell * 0.22 + t.dir.y * cell * 1.1, cell * 0.44, cell * 0.44)
  ctx.restore()
}

function drawBaseIfSeen(ctx: CanvasRenderingContext2D, ox: number, oy: number, cell: number, c: Vec, color: string, eye: Vec) {
  if (Math.hypot(c.x - eye.x, c.y - eye.y) > SIGHT + 3) return
  ctx.save()
  ctx.globalAlpha = 0.55
  ctx.shadowColor = color
  ctx.shadowBlur = 16
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.strokeRect(ox + (c.x - 2.6) * cell, oy + (c.y - 2.6) * cell, cell * 5.2, cell * 5.2)
  ctx.restore()
}

function Panel({ children }: { children: React.ReactNode }) { return <div style={panel}>{children}</div> }
function Meter({ label, v, color }: { label: string; v: number; color: string }) {
  return (
    <div style={{ width: 150 }}>
      <div style={{ font: '600 9px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.6)' }}>{label}</div>
      <div style={{ height: 8, background: 'rgba(255,255,255,0.1)', borderRadius: 4, overflow: 'hidden', marginTop: 2 }}>
        <div style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%`, height: '100%', background: color, boxShadow: `0 0 8px ${color}` }} />
      </div>
    </div>
  )
}
function DpadBtn({ label, onPress, onRelease, style }: { label: string; onPress: () => void; onRelease: () => void; style: CSSProperties }) {
  return (
    <button
      style={{ ...dpadBtn, ...style }}
      onPointerDown={(e) => { e.preventDefault(); onPress() }}
      onPointerUp={(e) => { e.preventDefault(); onRelease() }}
      onPointerCancel={onRelease}
      onPointerLeave={onRelease}
    >{label}</button>
  )
}

// --- styles ---
const root: CSSProperties = { position: 'absolute', inset: 0, zIndex: 30, background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', touchAction: 'none' }
const canvasStyle: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' }
const titleBar: CSSProperties = { position: 'absolute', top: 16, left: 0, right: 0, textAlign: 'center', font: '800 22px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.3em', pointerEvents: 'none' }
const exitBtn: CSSProperties = { position: 'absolute', top: 14, right: 14, zIndex: 32, cursor: 'pointer', padding: '8px 14px', font: '700 11px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em', color: 'rgba(223,238,255,0.92)', background: 'rgba(8,12,24,0.7)', border: '1px solid rgba(255,138,30,0.55)', borderRadius: 999 }
const readout: CSSProperties = { position: 'absolute', top: 50, left: 14, zIndex: 31, display: 'flex', flexDirection: 'column', gap: 6 }
const panel: CSSProperties = { position: 'relative', zIndex: 31, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '28px 34px', background: 'rgba(6,9,18,0.85)', border: '1px solid rgba(255,138,30,0.45)', borderRadius: 16, boxShadow: '0 0 40px rgba(255,138,30,0.18)', textAlign: 'center', maxWidth: 360 }
const panelTitle: CSSProperties = { font: '800 30px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.18em', color: '#ff8a1e', textShadow: '0 0 16px #ff8a1e' }
const panelText: CSSProperties = { color: 'rgba(223,238,255,0.8)', fontSize: 13, lineHeight: 1.5 }
const panelHint: CSSProperties = { color: 'rgba(223,238,255,0.5)', fontSize: 11, letterSpacing: '0.08em' }
const primaryBtn: CSSProperties = { marginTop: 4, cursor: 'pointer', padding: '12px 30px', font: '700 15px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.2em', color: '#05060b', background: '#ff8a1e', border: 'none', borderRadius: 999, boxShadow: '0 0 22px rgba(255,138,30,0.6)' }
const ghostBtn: CSSProperties = { cursor: 'pointer', padding: '10px 22px', font: '700 12px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.9)', background: 'transparent', border: '1px solid rgba(223,238,255,0.4)', borderRadius: 999 }
const dpad: CSSProperties = { position: 'absolute', bottom: 28, left: 24, zIndex: 32, display: 'grid', gridTemplateAreas: '". up ." "left . right" ". down ."', gap: 8 }
const dpadBtn: CSSProperties = { width: 56, height: 56, cursor: 'pointer', font: '700 20px/1 ui-monospace, Menlo, monospace', color: '#ff8a1e', background: 'rgba(8,12,24,0.75)', border: '1px solid rgba(255,138,30,0.5)', borderRadius: 12, touchAction: 'none', userSelect: 'none' }
const fireBtn: CSSProperties = { position: 'absolute', bottom: 44, right: 28, zIndex: 32, width: 84, height: 84, cursor: 'pointer', font: '800 16px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.1em', color: '#05060b', background: '#ff8a1e', border: 'none', borderRadius: '50%', boxShadow: '0 0 22px rgba(255,138,30,0.6)', touchAction: 'none', userSelect: 'none' }
