import { type CSSProperties } from 'react'
import type { HudState } from '../game/types'

const CONTROLS: Array<[string, string]> = [
  ['WASD', 'Move'],
  ['Mouse', 'Look'],
  ['Shift', 'Sprint'],
  ['Space / J', 'Jetpack — tap again in air to boost higher'],
  ['Q', 'Grapple arm (hold)'],
  ['O', 'Parachute — press again to CUT it'],
  ['C', 'Hoverboard'],
  ['G', 'Enter / exit / unlock'],
  ['H', 'Capture / fire'],
  ['T', 'Transform'],
  ['F', 'Boost'],
  ['B', 'Dance'],
  ['V', 'Bubble gun'],
  ['R', 'Warp'],
  ['Esc', 'Pause'],
]

/** In-game pause menu. ESC opens it without ever leaving the page. */
export function PauseMenu({
  onResume,
  touch,
  hud,
  onToggleMute,
  onCycleNeon,
  onOpenChatGate,
  onDisableChat,
}: {
  onResume: () => void
  touch: boolean
  hud: HudState
  onToggleMute: () => void
  onCycleNeon: () => void
  // Parental control: open the gate that turns typed chat ON (PIN-protected).
  onOpenChatGate?: () => void
  // Parental control: turn typed chat OFF (no PIN — never trap a kid enabled).
  onDisableChat?: () => void
}) {
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
        {/* Parental control: typed chat with other players. OFF by default; only a
            grown-up (PIN gate) can turn it on. Turning it off needs no PIN. */}
        {(onOpenChatGate || onDisableChat) && (
          <div style={chatControl}>
            <div style={chatControlText}>
              <div style={chatControlTitle}>
                Typed chat with other players
                <span style={{ ...chatStatePill, ...(hud.chatEnabled ? chatStateOn : chatStateOff) }}>
                  {hud.chatEnabled ? 'ON' : 'OFF'}
                </span>
              </div>
              <div style={chatControlSub}>Grown-ups only. Off by default to keep things safe.</div>
            </div>
            {hud.chatEnabled
              ? onDisableChat && <button style={chatToggleOff} onClick={onDisableChat}>Turn off</button>
              : onOpenChatGate && <button style={chatToggleOn} onClick={onOpenChatGate}>Turn on (grown-ups)</button>}
          </div>
        )}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button style={muteBtn} onClick={onToggleMute}>{hud.muted ? 'SOUND OFF' : 'SOUND ON'}</button>
          <button style={muteBtn} onClick={onCycleNeon}>NEON: {hud.neon.toUpperCase()}</button>
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
  // Give the value column a floor so long descriptions don't wrap repeatedly on narrow viewports
  gridTemplateColumns: 'auto minmax(120px, 1fr)',
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
const chatControl: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  width: '100%',
  maxWidth: 460,
  padding: '12px 16px',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(138,92,255,0.4)',
}
const chatControlText: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  textAlign: 'left',
  minWidth: 0,
}
const chatControlTitle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  font: '700 12px/1.2 ui-monospace, Menlo, monospace',
  letterSpacing: '0.06em',
  color: 'rgba(223,238,255,0.92)',
}
const chatControlSub: CSSProperties = {
  font: '600 10px/1.4 ui-monospace, Menlo, monospace',
  letterSpacing: '0.02em',
  color: 'rgba(223,238,255,0.5)',
}
const chatStatePill: CSSProperties = {
  flexShrink: 0,
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid',
  font: '800 9px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
}
const chatStateOn: CSSProperties = {
  color: '#9bff4d',
  borderColor: 'rgba(155,255,77,0.6)',
  background: 'rgba(155,255,77,0.1)',
}
const chatStateOff: CSSProperties = {
  color: 'rgba(223,238,255,0.6)',
  borderColor: 'rgba(255,255,255,0.2)',
  background: 'rgba(255,255,255,0.04)',
}
const chatToggleOn: CSSProperties = {
  flexShrink: 0,
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '10px 16px',
  font: '800 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.1em',
  color: '#04121a',
  background: 'linear-gradient(180deg,#a98cff,#8a5cff)',
  border: 'none',
  borderRadius: 999,
  whiteSpace: 'nowrap',
}
const chatToggleOff: CSSProperties = {
  flexShrink: 0,
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '10px 16px',
  font: '700 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.1em',
  color: 'rgba(223,238,255,0.85)',
  background: 'rgba(6,10,22,0.8)',
  border: '1px solid rgba(255,255,255,0.2)',
  borderRadius: 999,
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
