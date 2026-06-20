import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'

/**
 * Tunneler - an original take on the two-tank dig-through-dirt genre: you and a
 * bot tank carve tunnels through a field of dirt, shooting each other through
 * the passages you dig. Energy drains as you move, dig and fire, and refills on
 * your home base; run dry and you're a sitting duck. Limited sight (a headlight
 * around your tank) keeps it tense. Destroy the bot to win. Self-contained
 * canvas game - the city is paused while it runs; onExit returns to Humanoid
 * City. No external assets or code; all procedural.
 */

const COLS = 60
const ROWS = 40
const DIG_BRUSH = 1.4 // tank carves a path a bit wider than itself
const MOVE_OPEN = 9 // cells/sec through an open tunnel
const MOVE_DIG = 4.5 // cells/sec while chewing through fresh dirt
const BULLET_SPEED = 34
const MAX_HP = 5
const ENERGY_MAX = 100

type Phase = 'ready' | 'playing' | 'dead' | 'won'
interface Vec { x: number; y: number }
interface Tank { pos: Vec; dir: Vec; hp: number; energy: number; cooldown: number }
interface Bullet { x: number; y: number; dx: number; dy: number; life: number; mine: boolean }

const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }

export function Tunneler({ onExit, touch }: { onExit: () => void; touch: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [phase, setPhase] = useState<Phase>('ready')
  const [, force] = useState(0) // re-render the HP/energy readout

  const dirt = useRef<Uint8Array>(new Uint8Array(COLS * ROWS)) // 1 = dirt, 0 = dug
  const player = useRef<Tank>(newTank())
  const bot = useRef<Tank>(newTank())
  const bullets = useRef<Bullet[]>([])
  const held = useRef<Vec | null>(null)
  const phaseRef = useRef<Phase>('ready')
  const botBrain = useRef(0)
  const last = useRef(0)
  const playerBase = useRef<Vec>({ x: 5, y: ROWS - 5 })
  const botBase = useRef<Vec>({ x: COLS - 6, y: 5 })

  const di = (x: number, y: number) => y * COLS + x
  const inb = (x: number, y: number) => x >= 0 && x < COLS && y >= 0 && y < ROWS
  const isDirt = (x: number, y: number) => !inb(x, y) || dirt.current[di(x, y)] === 1

  // Carve a circular brush of dirt around a cell; returns how much was dug.
  const carve = (cx: number, cy: number, r: number) => {
    let dug = 0
    const r2 = r * r
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (!inb(x, y)) continue
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy <= r2 && dirt.current[di(x, y)] === 1) {
          dirt.current[di(x, y)] = 0
          dug++
        }
      }
    }
    return dug
  }

  const reset = useCallback(() => {
    dirt.current.fill(1)
    bullets.current = []
    const pb = playerBase.current
    const bb = botBase.current
    player.current = { pos: { x: pb.x, y: pb.y }, dir: DIRS.up, hp: MAX_HP, energy: ENERGY_MAX, cooldown: 0 }
    bot.current = { pos: { x: bb.x, y: bb.y }, dir: DIRS.down, hp: MAX_HP, energy: ENERGY_MAX, cooldown: 0 }
    // Pre-carve the two home bases.
    carve(pb.x, pb.y, 3)
    carve(bb.x, bb.y, 3)
    held.current = null
  }, [])

  const finish = (ph: Phase) => { phaseRef.current = ph; setPhase(ph) }
  const start = useCallback(() => { reset(); phaseRef.current = 'playing'; setPhase('playing'); last.current = performance.now() }, [reset])

  const shoot = (t: Tank, mine: boolean) => {
    if (t.energy < 8 || t.cooldown > 0) return
    t.energy -= 8
    t.cooldown = 0.35
    bullets.current.push({ x: t.pos.x + t.dir.x, y: t.pos.y + t.dir.y, dx: t.dir.x, dy: t.dir.y, life: 26, mine })
  }

  // --- input ---
  useEffect(() => {
    const set = (d: Vec | null) => { held.current = d; if (d) { player.current.dir = d } }
    const onDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp': case 'w': case 'W': set(DIRS.up); break
        case 'ArrowDown': case 's': case 'S': set(DIRS.down); break
        case 'ArrowLeft': case 'a': case 'A': set(DIRS.left); break
        case 'ArrowRight': case 'd': case 'D': set(DIRS.right); break
        case ' ': case 'Enter':
          if (phaseRef.current === 'playing') shoot(player.current, true)
          else start()
          break
        case 'Escape': onExit(); break
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D'].includes(e.key)) held.current = null
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
  }, [start, onExit])

  // --- sim + render loop ---
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

  const driveTank = (t: Tank, dir: Vec | null, dt: number, refuel: Vec) => {
    // Refuel on the home base, otherwise idle-regen a trickle.
    const onBase = Math.hypot(t.pos.x - refuel.x, t.pos.y - refuel.y) < 3.2
    t.energy = Math.min(ENERGY_MAX, t.energy + (onBase ? 60 : 2) * dt)
    t.cooldown = Math.max(0, t.cooldown - dt)
    if (!dir || t.energy <= 0) return
    const ahead = { x: t.pos.x + dir.x * 0.7, y: t.pos.y + dir.y * 0.7 }
    const digging = isDirt(Math.round(ahead.x), Math.round(ahead.y))
    const speed = digging ? MOVE_DIG : MOVE_OPEN
    const nx = t.pos.x + dir.x * speed * dt
    const ny = t.pos.y + dir.y * speed * dt
    // Energy cost: digging is dear, cruising is cheap.
    t.energy -= (digging ? 14 : 3) * dt
    const dug = carve(t.pos.x + dir.x, t.pos.y + dir.y, DIG_BRUSH)
    void dug
    t.pos.x = Math.max(0.5, Math.min(COLS - 1.5, nx))
    t.pos.y = Math.max(0.5, Math.min(ROWS - 1.5, ny))
  }

  const step = (dt: number) => {
    driveTank(player.current, held.current, dt, playerBase.current)
    stepBot(dt)

    // Bullets: dig the dirt they pass and damage a tank they reach.
    const p = player.current
    const b = bot.current
    const live: Bullet[] = []
    for (const bl of bullets.current) {
      let alive = true
      const steps = Math.ceil(BULLET_SPEED * dt)
      for (let s = 0; s < steps; s++) {
        bl.x += (bl.dx * BULLET_SPEED * dt) / steps
        bl.y += (bl.dy * BULLET_SPEED * dt) / steps
        bl.life -= 1 / steps
        const cx = Math.round(bl.x)
        const cy = Math.round(bl.y)
        if (!inb(cx, cy) || bl.life <= 0) { alive = false; break }
        if (dirt.current[di(cx, cy)] === 1) dirt.current[di(cx, cy)] = 0 // shells chew dirt
        const tgt = bl.mine ? b : p
        if (Math.hypot(bl.x - tgt.pos.x, bl.y - tgt.pos.y) < 1.2) {
          tgt.hp -= 1
          alive = false
          break
        }
      }
      if (alive) live.push(bl)
    }
    bullets.current = live

    if (p.hp <= 0) return finish('dead')
    if (b.hp <= 0) return finish('won')
    force((n) => n + 1)
  }

  // Bot: heads toward the player, digging as needed, and fires when lined up.
  // Deliberately imperfect (slow reactions, loose aim) so it's beatable.
  const stepBot = (dt: number) => {
    const b = bot.current
    const p = player.current
    botBrain.current -= dt
    let dir = b.dir
    if (botBrain.current <= 0) {
      botBrain.current = 0.3 + Math.random() * 0.3
      const dx = p.pos.x - b.pos.x
      const dy = p.pos.y - b.pos.y
      // Top up at base if low on energy.
      if (b.energy < 25) {
        const tx = botBase.current.x - b.pos.x
        const ty = botBase.current.y - b.pos.y
        dir = Math.abs(tx) > Math.abs(ty) ? (tx > 0 ? DIRS.right : DIRS.left) : (ty > 0 ? DIRS.down : DIRS.up)
      } else if (Math.random() < 0.8) {
        dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? DIRS.right : DIRS.left) : (dy > 0 ? DIRS.down : DIRS.up)
      } else {
        dir = [DIRS.up, DIRS.down, DIRS.left, DIRS.right][Math.floor(Math.random() * 4)]
      }
      b.dir = dir
      // Fire if roughly aligned with the player on a row/column.
      const aligned = (Math.abs(dx) < 1.5 && Math.sign(dy) === b.dir.y && b.dir.x === 0) ||
        (Math.abs(dy) < 1.5 && Math.sign(dx) === b.dir.x && b.dir.y === 0)
      if (aligned && Math.random() < 0.7) shoot(b, false)
    }
    driveTank(b, b.dir, dt, botBase.current)
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

    ctx.fillStyle = '#05060b'
    ctx.fillRect(0, 0, W, H)

    const p = player.current
    const sight = 8.5 // headlight radius in cells
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const dug = dirt.current[di(x, y)] === 0
        const dist = Math.hypot(x - p.pos.x, y - p.pos.y)
        const lit = dist < sight
        let col: string
        if (dug) col = lit ? '#0d1422' : '#080b12' // tunnel
        else col = lit ? '#3a2c18' : '#140f08' // dirt (lit vs fogged)
        ctx.fillStyle = col
        ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell)
      }
    }

    // Bases.
    drawCellGlow(ctx, ox, oy, cell, playerBase.current, '#27e7ff')
    drawCellGlow(ctx, ox, oy, cell, botBase.current, '#ff2bd0')

    // Bullets.
    for (const bl of bullets.current) {
      ctx.fillStyle = bl.mine ? '#bfefff' : '#ffd0ec'
      ctx.fillRect(ox + bl.x * cell - 1, oy + bl.y * cell - 1, cell * 0.6, cell * 0.6)
    }

    // Tanks.
    drawTank(ctx, ox, oy, cell, player.current, '#27e7ff')
    if (Math.hypot(bot.current.pos.x - p.pos.x, bot.current.pos.y - p.pos.y) < sight + 1) {
      drawTank(ctx, ox, oy, cell, bot.current, '#ff2bd0')
    }
  }

  return (
    <div style={root}>
      <canvas ref={canvasRef} style={canvasStyle} />

      <div style={titleBar}>
        <span style={{ color: '#ff8a1e', textShadow: '0 0 14px #ff8a1e' }}>TUN</span>
        <span style={{ color: '#9bff4d', textShadow: '0 0 14px #9bff4d' }}>NELER</span>
      </div>
      <button style={exitBtn} onClick={onExit}>RETURN TO HUMANOID CITY</button>

      {phase === 'playing' && (
        <div style={readout}>
          <Meter label="HULL" v={player.current.hp / MAX_HP} color="#9bff4d" />
          <Meter label="ENERGY" v={player.current.energy / ENERGY_MAX} color="#27e7ff" />
        </div>
      )}

      {phase === 'ready' && (
        <Panel>
          <div style={panelTitle}>TUNNELER</div>
          <div style={panelText}>Dig tunnels, hunt the enemy tank, and blast it. Refuel on your blue base. Don't run out of energy in the open.</div>
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

function newTank(): Tank { return { pos: { x: 0, y: 0 }, dir: DIRS.up, hp: MAX_HP, energy: ENERGY_MAX, cooldown: 0 } }

function drawTank(ctx: CanvasRenderingContext2D, ox: number, oy: number, cell: number, t: Tank, color: string) {
  ctx.save()
  ctx.shadowColor = color
  ctx.shadowBlur = 12
  ctx.fillStyle = color
  const s = cell * 2.0
  ctx.fillRect(ox + t.pos.x * cell - s / 2, oy + t.pos.y * cell - s / 2, s, s)
  // barrel
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(ox + t.pos.x * cell - cell * 0.25 + t.dir.x * cell, oy + t.pos.y * cell - cell * 0.25 + t.dir.y * cell, cell * 0.5, cell * 0.5)
  ctx.restore()
}

function drawCellGlow(ctx: CanvasRenderingContext2D, ox: number, oy: number, cell: number, c: Vec, color: string) {
  ctx.save()
  ctx.globalAlpha = 0.5
  ctx.shadowColor = color
  ctx.shadowBlur = 16
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.strokeRect(ox + (c.x - 3) * cell, oy + (c.y - 3) * cell, cell * 6, cell * 6)
  ctx.restore()
}

function Panel({ children }: { children: React.ReactNode }) { return <div style={panel}>{children}</div> }
function Meter({ label, v, color }: { label: string; v: number; color: string }) {
  return (
    <div style={{ width: 130 }}>
      <div style={{ font: '600 9px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.6)' }}>{label}</div>
      <div style={{ height: 7, background: 'rgba(255,255,255,0.1)', borderRadius: 4, overflow: 'hidden', marginTop: 2 }}>
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
const root: CSSProperties = { position: 'absolute', inset: 0, zIndex: 30, background: '#05060b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', touchAction: 'none' }
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
