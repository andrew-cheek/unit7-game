import { type CSSProperties } from 'react'
import type { BlipKind, HudState } from '../game/types'

const NEON = {
  cyan: '#27e7ff',
  magenta: '#ff2bd0',
  purple: '#8a5cff',
  orange: '#ff8a1e',
  lime: '#9bff4d',
  text: 'rgba(223,238,255,0.92)',
  dim: 'rgba(223,238,255,0.55)',
}

const BLIP_COLOR: Record<BlipKind, string> = {
  building: 'rgba(150,170,200,0.5)',
  npc: NEON.lime,
  vehicle: NEON.orange,
  portal: NEON.purple,
  powerup: NEON.cyan,
  alien: NEON.magenta,
  ship: '#ffffff',
  objective: NEON.lime,
}

export function HUD({ hud, touch, onRestart, onToggleMute }: { hud: HudState; touch: boolean; onRestart: () => void; onToggleMute: () => void }) {
  return (
    <div style={wrap}>
      {/* top-left restart (replays the opening cinematic) */}
      <button style={restartBtn} onClick={onRestart}>RESTART ↺</button>
      <button style={muteBtn} onClick={onToggleMute}>{hud.muted ? 'SOUND OFF' : 'SOUND ON'}</button>

      {/* top-left meters */}
      <div style={{ ...panel, top: 52, left: 14 }}>
        <Logo />
        <Bar label="STAMINA" value={hud.stamina} color={NEON.lime} />
        <Bar label="FUEL" value={hud.fuel} color={NEON.cyan} />
        {hud.powerup && (
          <div style={{ ...chip, color: NEON.cyan, borderColor: NEON.cyan }}>
            {hud.powerup.kind.toUpperCase()} {Math.ceil(hud.powerup.remaining)}s
          </div>
        )}
        {hud.shield && <div style={{ ...chip, color: NEON.purple, borderColor: NEON.purple }}>SHIELD</div>}
      </div>

      {/* top-right stats + radar */}
      <div style={{ ...panel, top: 14, right: 14, alignItems: 'flex-end' }}>
        <Radar hud={hud} />
        <div style={statRow}>
          <Stat label="ZONE" value={hud.zone.toUpperCase()} color={NEON.magenta} />
          <Stat label="SCORE" value={String(hud.score)} color={NEON.cyan} />
          <Stat label="CREDITS" value={String(hud.credits)} color={NEON.orange} />
          <Stat label="CAUGHT" value={String(hud.captured)} color={NEON.lime} />
        </div>
        <div style={statRow}>
          <Stat label="BEST" value={String(hud.best)} color={NEON.purple} />
          <Stat label="SPEED" value={`${hud.speed.toFixed(0)} m/s`} color={NEON.text} />
          {hud.altitude > 1 && <Stat label="ALT" value={`${hud.altitude.toFixed(0)} m`} color={NEON.text} />}
          <Stat label="FPS" value={String(hud.fps)} color={hud.fps >= 50 ? NEON.lime : hud.fps >= 30 ? NEON.orange : NEON.magenta} />
        </div>
      </div>

      {/* current objective (top-center, persistent + readable) */}
      {hud.objective && !hud.minigame && (
        <div style={objectiveStyle}>
          <span style={{ color: NEON.dim, marginRight: 8 }}>OBJECTIVE</span>
          <span style={{ color: NEON.lime }}>{hud.objective}</span>
        </div>
      )}

      {/* contextual prompt */}
      {hud.prompt && (
        <div style={promptStyle}>
          <span style={{ color: NEON.cyan }}>{hud.prompt}</span>
        </div>
      )}

      {/* zone-transition / launch fade + banner */}
      {hud.fade > 0.001 && (
        <div style={{ position: 'absolute', inset: 0, background: '#000', opacity: hud.fade, transition: 'opacity 0.08s linear' }} />
      )}
      {hud.banner && (
        <div style={bannerStyle}>{hud.banner}</div>
      )}

      {/* intro / mission card */}
      {hud.missionPopup && !hud.minigame && (
        <div style={missionCard}>
          <div style={missionTitle}>{hud.missionPopup.title}</div>
          <div style={missionBody}>{hud.missionPopup.body}</div>
        </div>
      )}

      {/* click-to-look hint (desktop, pointer not yet captured) */}
      {!touch && !hud.lookLocked && !hud.paused && !hud.intro && (
        <div style={clickHint}>CLICK TO CAPTURE MOUSE · LOOK WITH MOUSE</div>
      )}

      {/* control hints (desktop) */}
      {!touch && (
        <div style={hints}>
          WASD move · SHIFT sprint · SPACE/J jetpack · H capture/fire · G enter · F boost · T transform · O chute · ESC pause
        </div>
      )}
    </div>
  )
}

function Logo() {
  return (
    <div style={{ font: '800 15px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.22em', marginBottom: 8 }}>
      <span style={{ color: NEON.cyan, textShadow: `0 0 12px ${NEON.cyan}` }}>UNIT</span>
      <span style={{ color: NEON.magenta, textShadow: `0 0 12px ${NEON.magenta}` }}> 7</span>
    </div>
  )
}

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  const v = Math.max(0, Math.min(1, value))
  return (
    <div style={{ marginBottom: 6, width: 160 }}>
      <div style={{ ...microLabel, color: NEON.dim }}>{label}</div>
      <div style={barTrack}>
        <div
          style={{
            width: `${v * 100}%`,
            height: '100%',
            background: color,
            boxShadow: `0 0 10px ${color}`,
            borderRadius: 3,
            transition: 'width 0.12s linear',
          }}
        />
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ textAlign: 'right', minWidth: 54 }}>
      <div style={{ ...microLabel, color: NEON.dim }}>{label}</div>
      <div style={{ font: '700 14px/1.1 ui-monospace, Menlo, monospace', color }}>{value}</div>
    </div>
  )
}

function Radar({ hud }: { hud: HudState }) {
  const R = 52
  const size = R * 2
  return (
    <svg width={size} height={size} style={{ marginBottom: 8, filter: 'drop-shadow(0 0 6px rgba(39,231,255,0.4))' }}>
      <circle cx={R} cy={R} r={R - 1} fill="rgba(6,10,22,0.6)" stroke="rgba(39,231,255,0.35)" strokeWidth={1} />
      <circle cx={R} cy={R} r={(R - 1) * 0.6} fill="none" stroke="rgba(39,231,255,0.15)" strokeWidth={1} />
      <line x1={R} y1={6} x2={R} y2={size - 6} stroke="rgba(39,231,255,0.12)" strokeWidth={1} />
      <line x1={6} y1={R} x2={size - 6} y2={R} stroke="rgba(39,231,255,0.12)" strokeWidth={1} />
      {hud.radar.map((b, i) => {
        const x = R + b.x * (R - 4)
        const y = R - b.y * (R - 4)
        const r = b.kind === 'objective' ? 4 : b.kind === 'building' ? 1.6 : 2.6
        return <circle key={i} cx={x} cy={y} r={r} fill={BLIP_COLOR[b.kind]} />
      })}
      {/* player + forward indicator */}
      <polygon points={`${R},${R - 6} ${R - 4},${R + 4} ${R + 4},${R + 4}`} fill={NEON.cyan} />
    </svg>
  )
}

const wrap: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 5,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: NEON.text,
}
const panel: CSSProperties = {
  position: 'absolute',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '8px 12px',
  background: 'rgba(5,10,25,0.62)',
  border: '1px solid rgba(90,255,255,0.28)',
  borderRadius: 12,
  boxShadow: '0 0 16px rgba(0,255,255,0.12)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  textShadow: '0 0 6px rgba(0,0,0,0.85)',
}
const microLabel: CSSProperties = { font: '600 9px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em' }
const barTrack: CSSProperties = {
  width: '100%',
  height: 7,
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 4,
  overflow: 'hidden',
}
const statRow: CSSProperties = { display: 'flex', gap: 14, marginTop: 4 }
const restartBtn: CSSProperties = {
  position: 'absolute',
  top: 14,
  left: 14,
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '6px 12px',
  background: 'rgba(6,10,22,0.7)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.92)',
  font: '700 10px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
  boxShadow: '0 0 14px rgba(39,231,255,0.25)',
}
const muteBtn: CSSProperties = {
  position: 'absolute',
  top: 14,
  left: 110,
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '6px 12px',
  background: 'rgba(6,10,22,0.7)',
  border: '1px solid rgba(138,92,255,0.5)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.92)',
  font: '700 10px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
  boxShadow: '0 0 14px rgba(138,92,255,0.2)',
}
const chip: CSSProperties = {
  marginTop: 4,
  alignSelf: 'flex-start',
  padding: '2px 8px',
  border: '1px solid',
  borderRadius: 10,
  font: '700 10px/1.4 ui-monospace, Menlo, monospace',
  letterSpacing: '0.08em',
}
const promptStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: '22%',
  transform: 'translateX(-50%)',
  padding: '8px 18px',
  background: 'rgba(6,10,22,0.7)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 999,
  font: '700 14px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.08em',
  boxShadow: '0 0 20px rgba(39,231,255,0.25)',
}
const objectiveStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 16,
  transform: 'translateX(-50%)',
  padding: '6px 16px',
  maxWidth: '70vw',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  background: 'rgba(6,10,22,0.7)',
  border: '1px solid rgba(155,255,77,0.45)',
  borderRadius: 999,
  font: '700 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.1em',
  boxShadow: '0 0 16px rgba(155,255,77,0.2)',
}
const bannerStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '38%',
  transform: 'translate(-50%,-50%)',
  font: '800 30px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.3em',
  color: '#fff',
  textShadow: '0 0 24px rgba(39,231,255,0.7)',
  pointerEvents: 'none',
  zIndex: 30,
}
const missionCard: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '24%',
  transform: 'translateX(-50%)',
  maxWidth: '82vw',
  padding: '14px 22px',
  textAlign: 'center',
  background: 'rgba(5,10,25,0.78)',
  border: '1px solid rgba(90,255,255,0.5)',
  borderRadius: 14,
  boxShadow: '0 0 26px rgba(0,255,255,0.25)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  zIndex: 22,
  pointerEvents: 'none',
}
const missionTitle: CSSProperties = {
  font: '800 20px/1.1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.18em',
  color: '#27e7ff',
  textShadow: '0 0 14px rgba(39,231,255,0.7)',
  marginBottom: 6,
}
const missionBody: CSSProperties = {
  font: '600 12px/1.4 ui-monospace, Menlo, monospace',
  color: 'rgba(223,238,255,0.92)',
  letterSpacing: '0.04em',
}
const clickHint: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%,-50%)',
  font: '600 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  color: 'rgba(223,238,255,0.7)',
  textShadow: '0 0 10px rgba(0,0,0,0.9)',
  animation: 'unit7pulse 2s ease-in-out infinite',
}
const hints: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 12,
  transform: 'translateX(-50%)',
  font: '600 10px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.08em',
  color: 'rgba(223,238,255,0.45)',
  whiteSpace: 'nowrap',
  maxWidth: '96vw',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
