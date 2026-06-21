import { type CSSProperties } from 'react'
import type { HudState } from '../game/types'

const CONTROLS: Array<[string, string]> = [
  ['WASD', 'Move'],
  ['Mouse', 'Look'],
  ['Shift', 'Sprint'],
  ['Space / J', 'Jetpack / fly'],
  ['G', 'Enter / exit / unlock'],
  ['F', 'Boost'],
  ['H', 'Capture / fire'],
  ['T', 'Transform'],
  ['O', 'Parachute'],
  ['Esc', 'Pause'],
]

/** In-game pause menu. ESC opens it without ever leaving the page. */
export function PauseMenu({ onResume, touch, hud, onToggleMute }: { onResume: () => void; touch: boolean; hud: HudState; onToggleMute: () => void }) {
  return (
    <div style={wrap}>
      <div style={panel}>
        <div style={title}>
          <span style={{ color: '#27e7ff' }}>UNIT</span>
          <span style={{ color: '#ff2bd0' }}> 7</span>
          <span style={{ color: 'rgba(223,238,255,0.5)', fontSize: 14, letterSpacing: '0.3em', marginLeft: 12 }}>PAUSED</span>
        </div>
        <div style={statsRow}>
          <Stat label="SCORE" value={hud.score} color="#27e7ff" />
          <Stat label="BEST" value={hud.best} color="#8a5cff" />
          <Stat label="CREDITS" value={hud.credits} color="#ff8a1e" />
          <Stat label="CAUGHT" value={hud.captured} color="#9bff4d" />
        </div>
        {!touch && (
          <div style={grid}>
            {CONTROLS.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <kbd style={kbd}>{k}</kbd>
                <span style={{ color: 'rgba(223,238,255,0.75)', alignSelf: 'center' }}>{v}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 12 }}>
          <button style={muteBtn} onClick={onToggleMute}>{hud.muted ? 'SOUND OFF' : 'SOUND ON'}</button>
          <button style={resumeBtn} onClick={onResume}>RESUME</button>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 60 }}>
      <div style={{ font: '600 9px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em', color: 'rgba(223,238,255,0.5)' }}>{label}</div>
      <div style={{ font: '800 18px/1.2 ui-monospace, Menlo, monospace', color }}>{value}</div>
    </div>
  )
}

const wrap: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 25,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(3,5,12,0.55)',
  backdropFilter: 'blur(7px)',
  WebkitBackdropFilter: 'blur(7px)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
const panel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 22,
  padding: '34px 44px',
  border: '1px solid rgba(39,231,255,0.35)',
  borderRadius: 16,
  background: 'rgba(8,12,24,0.88)',
  boxShadow: '0 0 60px rgba(39,231,255,0.18)',
  maxWidth: '90vw',
}
const title: CSSProperties = { font: '800 30px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.18em', display: 'flex', alignItems: 'baseline' }
const statsRow: CSSProperties = { display: 'flex', gap: 20 }
const muteBtn: CSSProperties = {
  pointerEvents: 'auto', cursor: 'pointer', padding: '12px 22px', font: '700 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em', color: 'rgba(223,238,255,0.9)', background: 'transparent', border: '1px solid rgba(138,92,255,0.5)', borderRadius: 999,
}
const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  columnGap: 16,
  rowGap: 7,
  font: '600 12px/1.4 ui-monospace, Menlo, monospace',
}
const kbd: CSSProperties = {
  justifySelf: 'start',
  padding: '2px 9px',
  border: '1px solid rgba(39,231,255,0.45)',
  borderRadius: 6,
  color: '#27e7ff',
  background: 'rgba(39,231,255,0.08)',
  whiteSpace: 'nowrap',
}
const resumeBtn: CSSProperties = {
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '12px 44px',
  font: '700 14px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.2em',
  color: '#05060b',
  background: '#27e7ff',
  border: 'none',
  borderRadius: 999,
  boxShadow: '0 0 24px rgba(39,231,255,0.5)',
}
