import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { miniSfx } from './miniSound'

/**
 * DIG DUEL - a fast top-down tank battle in a bright neon arena. The field is
 * open (you can see the whole fight), with scattered blocks of destructible
 * dirt as cover. Shells and ramming chew through cover, so you can blast or
 * tunnel a flanking route - digging is a tactic, not the whole game. Drive,
 * dodge, line up your shots and destroy the enemy tank before it gets you.
 * Original implementation, no external code/assets. The city is paused while it
 * runs; onExit returns to Humanoid City.
 */

const COLS = 140 // a large underground world; the camera shows only a window
const ROWS = 100
const VIEW = 46 // tiles across the short side of the viewport (higher = zoomed out)
const TUNNELS = 22 // branch tunnels carved at start (lower = more solid dirt)
const TUNNEL_LEN = 170
const DIG_BRUSH = 0.9
const MOVE_OPEN = 4.6 // slow, deliberate
const MOVE_DIG = 2.2

// Retro cave palette (per the agreed rendering spec).
// Dense fine-grain browns tuned to the reference dirt.
const ROCK = { void: '#050505', border: '#0a12c0', base: '#97632f', mid: '#6e4824', dark: '#4a3018', light: '#b9824a', hi: '#c98c4f', edge: '#241710' }

// Deterministic integer hash for stable, non-flickering per-tile pixel texture.
const hash2D = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0
  h = (h ^ (h >> 13)) * 1274126177
  return Math.abs(h ^ (h >> 16))
}
const BULLET_SPEED = 15
const MAX_HP = 6

type Phase = 'ready' | 'playing' | 'dead' | 'won'
interface Vec { x: number; y: number }
interface Tank { pos: Vec; dir: Vec; hp: number; cooldown: number; flash: number }
interface Bullet { x: number; y: number; dx: number; dy: number; life: number; mine: boolean }

const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }
const BUILD = 'DD-8' // bump each deploy; shown on screen to confirm freshness
const PLAYER_COLOR = '#7cff4f' // green tank, like the classic
const BOT_COLOR = '#ff5036'

export function DigDuel({ onExit, touch }: { onExit: () => void; touch: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [phase, setPhase] = useState<Phase>('ready')
  const [, force] = useState(0)

  const dirt = useRef<Uint8Array>(new Uint8Array(COLS * ROWS))
  const noise = useRef<Float32Array>(new Float32Array(COLS * ROWS)) // per-cell dirt speckle
  const player = useRef<Tank>(newTank())
  const bot = useRef<Tank>(newTank())
  const bullets = useRef<Bullet[]>([])
  const held = useRef<Vec | null>(null)
  const phaseRef = useRef<Phase>('ready')
  const botBrain = useRef(0)
  const botStrafe = useRef<Vec | null>(null)
  const last = useRef(0)

  const di = (x: number, y: number) => y * COLS + x
  const inb = (x: number, y: number) => x >= 0 && x < COLS && y >= 0 && y < ROWS
  const isDirt = (x: number, y: number) => inb(x, y) && dirt.current[di(x, y)] === 1

  const blob = (cx: number, cy: number, r: number, v: 0 | 1) => {
    const r2 = r * r
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (inb(x, y) && (x - cx) ** 2 + (y - cy) ** 2 <= r2) dirt.current[di(x, y)] = v
      }
    }
  }

  const reset = useCallback(() => {
    dirt.current.fill(1) // solid dirt field
    bullets.current = []
    for (let i = 0; i < noise.current.length; i++) noise.current[i] = Math.random()
    const cx = (x: number) => Math.max(2, Math.min(COLS - 3, x))
    const cy = (y: number) => Math.max(2, Math.min(ROWS - 3, y))
    const r4 = () => [DIRS.up, DIRS.down, DIRS.left, DIRS.right][Math.floor(Math.random() * 4)]
    // Carve a meandering tunnel from a point toward a target.
    const digTo = (x: number, y: number, tx: number, ty: number) => {
      let guard = 0
      while (Math.hypot(tx - x, ty - y) > 2 && guard++ < 700) {
        blob(x, y, 1.3, 0)
        if (Math.random() < 0.55) x = cx(x + (Math.sign(tx - x) || 1))
        else y = cy(y + (Math.sign(ty - y) || 1))
        if (Math.random() < 0.3) { if (Math.random() < 0.5) x = cx(x + (Math.random() < 0.5 ? 1 : -1)); else y = cy(y + (Math.random() < 0.5 ? 1 : -1)) }
      }
    }
    // Free-wandering branch tunnel (thinner, so the field stays mostly dirt).
    const wander = (x: number, y: number, len: number) => {
      let d = r4()
      for (let i = 0; i < len; i++) { blob(x, y, 1.1, 0); if (Math.random() < 0.2) d = r4(); x = cx(x + d.x); y = cy(y + d.y) }
    }
    const ps = { x: Math.floor(COLS / 2), y: ROWS - 4 }
    const bs = { x: Math.floor(COLS / 2), y: 4 }
    digTo(ps.x, ps.y, bs.x, bs.y) // main artery between the two tanks
    for (let k = 0; k < TUNNELS; k++) wander(cx(4 + Math.random() * (COLS - 8)), cy(4 + Math.random() * (ROWS - 8)), TUNNEL_LEN)
    blob(ps.x, ps.y, 2.4, 0)
    blob(bs.x, bs.y, 2.4, 0)
    player.current = { pos: { ...ps }, dir: DIRS.up, hp: MAX_HP, cooldown: 0, flash: 0 }
    bot.current = { pos: { ...bs }, dir: DIRS.down, hp: MAX_HP, cooldown: 0, flash: 0 }
    held.current = null
    botStrafe.current = null
  }, [])

  const finish = (ph: Phase) => { phaseRef.current = ph; setPhase(ph); miniSfx(ph === 'won' ? 'lap' : 'gameover') }
  const start = useCallback(() => { reset(); phaseRef.current = 'playing'; setPhase('playing'); last.current = performance.now(); miniSfx('start') }, [reset])

  const shoot = (t: Tank, mine: boolean) => {
    if (t.cooldown > 0) return
    t.cooldown = 0.45
    if (mine) miniSfx('shoot')
    bullets.current.push({ x: t.pos.x + t.dir.x, y: t.pos.y + t.dir.y, dx: t.dir.x, dy: t.dir.y, life: COLS, mine })
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

  // Size the canvas backing store to the real device resolution. Without this
  // the canvas stays the default 300x150 and gets stretched to fill the screen,
  // which is what made everything blurry and look zoomed in.
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const fit = () => {
      const r = cv.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      const w = Math.round(r.width * dpr)
      const h = Math.round(r.height * dpr)
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h }
    }
    fit()
    // ResizeObserver fires immediately with the laid-out size, so this is
    // reliable even if the first measure happened before layout.
    const ro = new ResizeObserver(fit)
    ro.observe(cv)
    window.addEventListener('resize', fit)
    return () => { ro.disconnect(); window.removeEventListener('resize', fit) }
  }, [])

  const driveTank = (t: Tank, dir: Vec | null, dt: number) => {
    t.cooldown = Math.max(0, t.cooldown - dt)
    t.flash = Math.max(0, t.flash - dt)
    if (!dir) return
    const digging = isDirt(Math.round(t.pos.x + dir.x * 0.7), Math.round(t.pos.y + dir.y * 0.7))
    const speed = digging ? MOVE_DIG : MOVE_OPEN
    if (digging) blob(t.pos.x + dir.x, t.pos.y + dir.y, DIG_BRUSH, 0) // ram through cover
    t.pos.x = Math.max(0.6, Math.min(COLS - 1.6, t.pos.x + dir.x * speed * dt))
    t.pos.y = Math.max(0.6, Math.min(ROWS - 1.6, t.pos.y + dir.y * speed * dt))
  }

  const step = (dt: number) => {
    driveTank(player.current, held.current, dt)
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
        bl.life -= (BULLET_SPEED * dt) / sub
        const cx = Math.round(bl.x)
        const cy = Math.round(bl.y)
        if (!inb(cx, cy) || bl.life <= 0) { alive = false; break }
        if (dirt.current[di(cx, cy)] === 1) { dirt.current[di(cx, cy)] = 0; alive = false; break } // cover stops shells
        const tgt = bl.mine ? b : p
        if (Math.hypot(bl.x - tgt.pos.x, bl.y - tgt.pos.y) < 1.2) { tgt.hp -= 1; tgt.flash = 0.3; alive = false; break }
      }
      if (alive) live.push(bl)
    }
    bullets.current = live

    if (p.hp <= 0) return finish('dead')
    if (b.hp <= 0) return finish('won')
    force((n) => n + 1)
  }

  // Aggressive bot: closes on the player, strafes to dodge, and fires whenever
  // it lines up. Reaction delay + occasional wandering keep it beatable.
  const stepBot = (dt: number) => {
    const b = bot.current
    const p = player.current
    botBrain.current -= dt
    if (botBrain.current <= 0) {
      botBrain.current = 0.18 + Math.random() * 0.22
      const dx = p.pos.x - b.pos.x
      const dy = p.pos.y - b.pos.y
      const adx = Math.abs(dx)
      const ady = Math.abs(dy)
      // Aim along the dominant axis; sometimes strafe along the other to dodge.
      if (Math.random() < 0.28) {
        b.dir = adx > ady ? (dy > 0 ? DIRS.down : DIRS.up) : (dx > 0 ? DIRS.right : DIRS.left)
      } else {
        b.dir = adx > ady ? (dx > 0 ? DIRS.right : DIRS.left) : (dy > 0 ? DIRS.down : DIRS.up)
      }
      const aligned = (adx < 1.6 && Math.sign(dy) === b.dir.y && b.dir.x === 0) ||
        (ady < 1.6 && Math.sign(dx) === b.dir.x && b.dir.y === 0)
      if (aligned && Math.random() < 0.85) {
        // Face the player to fire.
        b.dir = adx < 1.6 ? (dy > 0 ? DIRS.down : DIRS.up) : (dx > 0 ? DIRS.right : DIRS.left)
        shoot(b, false)
      }
    }
    driveTank(b, b.dir, dt)
  }

  const draw = () => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false // crisp pixels, no blur
    const W = cv.width
    const H = cv.height
    const p = player.current
    const b = bot.current
    const op = (nx: number, ny: number) => nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && dirt.current[ny * COLS + nx] === 0

    // Retro split-screen: thick dark-blue frame + center divider. Each panel is
    // a small camera window into the large map (left = you, right = enemy).
    ctx.fillStyle = ROCK.border
    ctx.fillRect(0, 0, W, H)
    const border = Math.max(8, Math.round(Math.min(W, H) * 0.016))
    // Single full-screen viewport following the player, inside the blue frame.
    const pw = W - border * 2
    const ph = H - border * 2
    const panels = [
      { rx: border, ry: border, cam: p.pos, enemy: b.pos, enemyColor: BOT_COLOR },
    ]

    for (const pan of panels) {
      const rx = pan.rx
      const ry = pan.ry
      ctx.save()
      ctx.beginPath()
      ctx.rect(rx, ry, pw, ph)
      ctx.clip()

      // Reference-scale window: ~VIEW tiles across the short side of the panel.
      const cell = Math.max(6, Math.min(pw, ph) / VIEW)
      const halfW = pw / (2 * cell)
      const halfH = ph / (2 * cell)
      const camX = halfW * 2 >= COLS ? COLS / 2 : Math.max(halfW, Math.min(COLS - halfW, pan.cam.x))
      const camY = halfH * 2 >= ROWS ? ROWS / 2 : Math.max(halfH, Math.min(ROWS - halfH, pan.cam.y))
      const cx0 = rx + pw / 2
      const cy0 = ry + ph / 2
      const sx = (gx: number) => cx0 + (gx - camX) * cell
      const sy = (gy: number) => cy0 + (gy - camY) * cell
      const cs = Math.ceil(cell) + 1
      const half = cs / 2
      const t = Math.max(1, Math.round(cs * 0.2))

      ctx.fillStyle = ROCK.void // tunnels / void (stays black for contrast)
      ctx.fillRect(rx, ry, pw, ph)
      const x0 = Math.max(0, Math.floor(camX - halfW - 1))
      const x1 = Math.min(COLS - 1, Math.ceil(camX + halfW + 1))
      const y0 = Math.max(0, Math.floor(camY - halfH - 1))
      const y1 = Math.min(ROWS - 1, Math.ceil(camY + halfH + 1))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (dirt.current[di(x, y)] === 0) continue // tunnel: leave it black
          // One crisp, integer-snapped fill per tile. The brown band comes from
          // baked per-cell noise, so it reads as fine dirt speckle when zoomed
          // out and never blurs or flickers. Cheap enough for a wide view.
          const px = Math.floor(sx(x))
          const py = Math.floor(sy(y))
          const n = noise.current[di(x, y)]
          ctx.fillStyle = n < 0.5 ? ROCK.base : n < 0.8 ? ROCK.mid : n < 0.92 ? ROCK.dark : ROCK.light
          ctx.fillRect(px, py, cs, cs)
        }
      }

      drawBase(ctx, sx, sy, cell, { x: COLS / 2, y: ROWS - 4 }, PLAYER_COLOR)
      drawBase(ctx, sx, sy, cell, { x: COLS / 2, y: 4 }, BOT_COLOR)

      for (const bl of bullets.current) {
        if (bl.x < x0 || bl.x > x1 || bl.y < y0 || bl.y > y1) continue
        ctx.save()
        ctx.shadowColor = bl.mine ? PLAYER_COLOR : BOT_COLOR
        ctx.shadowBlur = 8
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(sx(bl.x) - cell * 0.18, sy(bl.y) - cell * 0.18, cell * 0.55, cell * 0.55)
        ctx.restore()
      }

      drawTank(ctx, sx, sy, cell, p, PLAYER_COLOR)
      drawTank(ctx, sx, sy, cell, b, BOT_COLOR)

      // Edge arrow to the other vehicle when it's outside this panel's window.
      const e = pan.enemy
      if (e.x < x0 || e.x > x1 || e.y < y0 || e.y > y1) {
        const ang = Math.atan2(e.y - pan.cam.y, e.x - pan.cam.x)
        const rad = Math.min(pw, ph) / 2 - 20
        const ex = cx0 + Math.cos(ang) * rad
        const ey = cy0 + Math.sin(ang) * rad
        ctx.save()
        ctx.translate(ex, ey)
        ctx.rotate(ang)
        ctx.fillStyle = pan.enemyColor
        ctx.shadowColor = pan.enemyColor
        ctx.shadowBlur = 10
        ctx.beginPath()
        ctx.moveTo(12, 0)
        ctx.lineTo(-8, 7)
        ctx.lineTo(-8, -7)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }

      ctx.restore()
    }

    // Damage flash on the player's (left) panel.
    if (p.flash > 0) {
      ctx.save()
      ctx.globalAlpha = Math.min(0.5, p.flash * 2)
      ctx.strokeStyle = '#ff2b3c'
      ctx.lineWidth = 8
      ctx.strokeRect(border, border, pw, ph)
      ctx.restore()
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
      <div style={buildTag}>{BUILD}</div>

      {phase === 'playing' && (
        <div style={readout}>
          <Pips label="YOU" hp={player.current.hp} color={PLAYER_COLOR} />
          <Pips label="ENEMY" hp={bot.current.hp} color={BOT_COLOR} />
        </div>
      )}

      {phase === 'ready' && (
        <Panel>
          <div style={panelTitle}>DIG DUEL</div>
          <div style={panelText}>Tank battle in a neon arena. Blast the enemy tank - the dirt blocks are cover you can shoot or ram straight through. First to lose all hull pips loses.</div>
          <div style={panelHint}>{touch ? 'Pad drives · FIRE shoots' : 'Arrows / WASD drive · SPACE fires'}</div>
          <button style={primaryBtn} onClick={start}>START</button>
        </Panel>
      )}
      {phase === 'dead' && (
        <Panel>
          <div style={{ ...panelTitle, color: '#ff2bd0', textShadow: '0 0 16px #ff2bd0' }}>YOU WERE DESTROYED</div>
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

function newTank(): Tank { return { pos: { x: 0, y: 0 }, dir: DIRS.up, hp: MAX_HP, cooldown: 0, flash: 0 } }

type Proj = (g: number) => number
function drawTank(ctx: CanvasRenderingContext2D, sx: Proj, sy: Proj, cell: number, t: Tank, color: string) {
  ctx.save()
  ctx.shadowColor = color
  ctx.shadowBlur = 14
  ctx.fillStyle = t.flash > 0 ? '#ffffff' : color
  const s = cell * 1.9
  ctx.fillRect(sx(t.pos.x) + cell / 2 - s / 2, sy(t.pos.y) + cell / 2 - s / 2, s, s)
  ctx.fillStyle = '#0a0f1e'
  ctx.fillRect(sx(t.pos.x) + cell / 2 - cell * 0.2 + t.dir.x * cell * 1.15, sy(t.pos.y) + cell / 2 - cell * 0.2 + t.dir.y * cell * 1.15, cell * 0.4, cell * 0.4)
  ctx.restore()
}

function drawBase(ctx: CanvasRenderingContext2D, sx: Proj, sy: Proj, cell: number, c: Vec, color: string) {
  ctx.save()
  ctx.globalAlpha = 0.4
  ctx.shadowColor = color
  ctx.shadowBlur = 14
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.strokeRect(sx(c.x - 2.4), sy(c.y - 2.4), cell * 4.8, cell * 4.8)
  ctx.restore()
}

function Panel({ children }: { children: React.ReactNode }) { return <div style={panel}>{children}</div> }
function Pips({ label, hp, color }: { label: string; hp: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 54, font: '700 10px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em', color: 'rgba(223,238,255,0.7)' }}>{label}</div>
      <div style={{ display: 'flex', gap: 4 }}>
        {Array.from({ length: MAX_HP }).map((_, i) => (
          <div key={i} style={{ width: 12, height: 12, borderRadius: 3, background: i < hp ? color : 'rgba(255,255,255,0.12)', boxShadow: i < hp ? `0 0 8px ${color}` : 'none' }} />
        ))}
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
const root: CSSProperties = { position: 'absolute', inset: 0, zIndex: 30, background: '#0a0f1e', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', touchAction: 'none' }
const canvasStyle: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' }
const titleBar: CSSProperties = { position: 'absolute', top: 16, left: 0, right: 0, textAlign: 'center', font: '800 22px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.3em', pointerEvents: 'none' }
const exitBtn: CSSProperties = { position: 'absolute', top: 14, right: 14, zIndex: 32, cursor: 'pointer', padding: '8px 14px', font: '700 11px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em', color: 'rgba(223,238,255,0.92)', background: 'rgba(8,12,24,0.7)', border: '1px solid rgba(255,138,30,0.55)', borderRadius: 999 }
const buildTag: CSSProperties = { position: 'absolute', bottom: 6, left: 8, zIndex: 32, font: '700 10px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.1em', color: 'rgba(159,216,255,0.7)', pointerEvents: 'none' }
const readout: CSSProperties = { position: 'absolute', top: 50, left: 14, zIndex: 31, display: 'flex', flexDirection: 'column', gap: 8 }
const panel: CSSProperties = { position: 'relative', zIndex: 31, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '28px 34px', background: 'rgba(6,9,18,0.85)', border: '1px solid rgba(255,138,30,0.45)', borderRadius: 16, boxShadow: '0 0 40px rgba(255,138,30,0.18)', textAlign: 'center', maxWidth: 360 }
const panelTitle: CSSProperties = { font: '800 30px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.18em', color: '#ff8a1e', textShadow: '0 0 16px #ff8a1e' }
const panelText: CSSProperties = { color: 'rgba(223,238,255,0.8)', fontSize: 13, lineHeight: 1.5 }
const panelHint: CSSProperties = { color: 'rgba(223,238,255,0.5)', fontSize: 11, letterSpacing: '0.08em' }
const primaryBtn: CSSProperties = { marginTop: 4, cursor: 'pointer', padding: '12px 30px', font: '700 15px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.2em', color: '#05060b', background: '#ff8a1e', border: 'none', borderRadius: 999, boxShadow: '0 0 22px rgba(255,138,30,0.6)' }
const ghostBtn: CSSProperties = { cursor: 'pointer', padding: '10px 22px', font: '700 12px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.9)', background: 'transparent', border: '1px solid rgba(223,238,255,0.4)', borderRadius: 999 }
const dpad: CSSProperties = { position: 'absolute', bottom: 28, left: 24, zIndex: 32, display: 'grid', gridTemplateAreas: '". up ." "left . right" ". down ."', gap: 8 }
const dpadBtn: CSSProperties = { width: 56, height: 56, cursor: 'pointer', font: '700 20px/1 ui-monospace, Menlo, monospace', color: '#ff8a1e', background: 'rgba(8,12,24,0.75)', border: '1px solid rgba(255,138,30,0.5)', borderRadius: 12, touchAction: 'none', userSelect: 'none' }
const fireBtn: CSSProperties = { position: 'absolute', bottom: 44, right: 28, zIndex: 32, width: 84, height: 84, cursor: 'pointer', font: '800 16px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.1em', color: '#05060b', background: '#ff8a1e', border: 'none', borderRadius: '50%', boxShadow: '0 0 22px rgba(255,138,30,0.6)', touchAction: 'none', userSelect: 'none' }
