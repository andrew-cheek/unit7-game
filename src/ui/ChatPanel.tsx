import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CHAT_MAX_LEN, type ChatMessage } from '../game/kidShared'
import { useUnit7UiStyles, U7_UI_CLASS } from './uiAnims'

// Kid-safe typed chat dock. PURE presentational + local input state only: it
// owns nothing but the draft text. All filtering, networking and persistence are
// injected through props (the parent re-filters every line before it relays, and
// the server filters again). This component is only ever mounted when a parent
// has turned chat on behind the parental gate — that gating lives outside here.
//
// Style matches the rest of the neon HUD (Unit7Game.tsx / HUD.tsx): inline
// CSSProperties, cyan/magenta on a dark glass panel, ui-monospace. Touch gets a
// slide-up sheet pinned to the bottom; desktop gets a compact bottom-right dock.
// Either way the panel is small and non-blocking so the game stays playable.

const NEON = {
  cyan: '#27e7ff',
  magenta: '#ff2bd0',
  lime: '#9bff4d',
  text: 'rgba(223,238,255,0.92)',
  dim: 'rgba(223,238,255,0.6)',
}

// A friendly, non-shaming default for the inline hint when a draft would be
// blocked. Parents' onFilterPreview can supply a more specific reason string.
const DEFAULT_HINT = "Let's keep it friendly — no phone numbers or links"

export interface ChatPanelProps {
  /** Already filtered / safe lines, newest last. */
  messages: ChatMessage[]
  /** Relay a line. The parent re-filters before it goes on the wire. */
  onSend: (text: string) => void
  /** Optional live check used only to surface an inline input hint; the real
   *  enforcement still happens in the parent + on the server. */
  onFilterPreview?: (text: string) => { allowed: boolean; reason?: string }
  /** This player's id, so their own lines right-align and highlight. */
  selfId: string
  touch: boolean
  onClose: () => void
}

export function ChatPanel({ messages, onSend, onFilterPreview, selfId, touch, onClose }: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  useUnit7UiStyles()

  // Auto-scroll to the newest line whenever the log grows. useLayoutEffect so the
  // jump happens before paint (no visible flash of the old scroll position).
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const trimmed = draft.trim()
  // Live filter check for the hint only. We never block typing — we just disable
  // SEND and show a gentle nudge so a kid learns what's not allowed.
  const preview = onFilterPreview && trimmed ? onFilterPreview(draft) : null
  const blocked = preview ? !preview.allowed : false
  const canSend = trimmed.length > 0 && !blocked

  const send = () => {
    if (!canSend) return
    onSend(draft)
    setDraft('') // clear after send; parent owns whether it actually relayed
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // Enter sends; this is our own <input>, so it never sees the game's WASD keys
    // and we add no global key handler. Shift+Enter is a no-op (single-line input).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const remaining = CHAT_MAX_LEN - draft.length

  return (
    <div className={U7_UI_CLASS} style={touch ? { ...dock, ...dockTouch } : dock}>
      <div style={header}>
        <span style={headerLeft}>
          <span style={liveDot} />
          <span style={{ color: NEON.cyan, letterSpacing: '0.16em' }}>CHAT IS ON</span>
        </span>
        <button style={closeBtn} onClick={onClose} aria-label="Close chat">CLOSE ✕</button>
      </div>

      {/* Safety affordance: makes it obvious this is monitored, friendly chat and
          that other kids are only ever seen as a callsign (no avatars / DMs / IDs). */}
      <div style={safeNote}>Friendly chat — grown-ups can see it. Be kind!</div>

      <div ref={listRef} style={list}>
        {messages.length === 0 ? (
          <div style={emptyNote}>Say hi to other pilots 👋</div>
        ) : (
          messages.map((m) => {
            const mine = m.id === selfId
            return (
              <div key={m.id + ':' + m.t} style={mine ? { ...row, ...rowMine } : row}>
                <span style={mine ? { ...name, color: NEON.cyan } : { ...name, color: NEON.magenta }}>
                  {mine ? 'You' : m.name}
                </span>
                <span style={mine ? { ...bubble, ...bubbleMine } : bubble}>{m.text}</span>
              </div>
            )
          })
        )}
      </div>

      {/* Inline hint sits directly above the input so the nudge is right where the
          kid is typing. Only shown when a draft would actually be blocked. */}
      {blocked && (
        <div style={hint}>{preview?.reason || DEFAULT_HINT}</div>
      )}

      <div style={inputRow}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={CHAT_MAX_LEN}
          placeholder="Type a message…"
          autoComplete="off"
          autoCorrect="on"
          spellCheck
          enterKeyHint="send"
          style={touch ? { ...input, ...inputTouch } : input}
          aria-label="Chat message"
        />
        <button
          style={canSend ? sendBtn : { ...sendBtn, ...sendBtnOff }}
          onClick={send}
          disabled={!canSend}
        >
          SEND ▸
        </button>
      </div>

      {/* Live character count; flips to a warning colour as the hard cap nears. */}
      <div style={{ ...count, color: remaining <= 10 ? NEON.magenta : NEON.dim }}>
        {draft.length}/{CHAT_MAX_LEN}
      </div>
    </div>
  )
}

// --- styles -----------------------------------------------------------------
// The slide-up pop-in keyframe (unit7chatIn) and the focus / reduced-motion
// rules now live in the shared global block injected by useUnit7UiStyles().

const dock: CSSProperties = {
  position: 'absolute',
  right: 'max(14px, env(safe-area-inset-right))',
  bottom: 'max(14px, env(safe-area-inset-bottom))',
  zIndex: 26,
  display: 'flex',
  flexDirection: 'column',
  width: 'min(320px, 90vw)',
  maxHeight: '52vh',
  padding: '10px 12px 8px',
  background: 'rgba(5,10,25,0.9)',
  border: '1px solid rgba(90,255,255,0.4)',
  borderRadius: 14,
  boxShadow: '0 0 26px rgba(0,255,255,0.18)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  pointerEvents: 'auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: NEON.text,
  animation: 'unit7chatIn 0.18s ease-out',
}
// Touch: a slide-up sheet pinned across the bottom, full width, rounded only on
// top, with bigger touch targets and a taller log. Sits clear of side insets.
const dockTouch: CSSProperties = {
  left: 'max(8px, env(safe-area-inset-left))',
  right: 'max(8px, env(safe-area-inset-right))',
  bottom: 0,
  width: 'auto',
  maxHeight: '46vh',
  borderRadius: '16px 16px 0 0',
  padding: '12px 14px calc(10px + env(safe-area-inset-bottom))',
}
const header: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  font: '800 11px/1 ui-monospace, Menlo, monospace',
  marginBottom: 4,
}
const headerLeft: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
}
const liveDot: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: NEON.lime,
  boxShadow: `0 0 8px ${NEON.lime}`,
}
const closeBtn: CSSProperties = {
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '6px 12px',
  background: 'rgba(6,10,22,0.7)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.92)',
  font: '700 10px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
}
const safeNote: CSSProperties = {
  font: '600 9px/1.4 ui-monospace, Menlo, monospace',
  letterSpacing: '0.04em',
  color: NEON.dim,
  marginBottom: 8,
}
const list: CSSProperties = {
  flex: 1,
  minHeight: 80,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  paddingRight: 2,
  marginBottom: 6,
}
const emptyNote: CSSProperties = {
  margin: 'auto',
  textAlign: 'center',
  color: 'rgba(223,238,255,0.45)',
  font: '600 11px/1.4 ui-monospace, Menlo, monospace',
  padding: '12px 0',
}
const row: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  maxWidth: '88%',
  alignSelf: 'flex-start',
}
const rowMine: CSSProperties = {
  alignItems: 'flex-end',
  alignSelf: 'flex-end',
}
const name: CSSProperties = {
  font: '800 9px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  // No avatars, no profile link, no id — a callsign is the only identity shown.
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const bubble: CSSProperties = {
  padding: '6px 10px',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '4px 12px 12px 12px',
  color: NEON.text,
  font: '600 12px/1.35 ui-monospace, Menlo, monospace',
  letterSpacing: '0.01em',
  wordBreak: 'break-word',
  overflowWrap: 'anywhere',
}
const bubbleMine: CSSProperties = {
  background: 'rgba(39,231,255,0.12)',
  border: '1px solid rgba(39,231,255,0.4)',
  borderRadius: '12px 4px 12px 12px',
  color: '#eaf6ff',
}
const hint: CSSProperties = {
  margin: '0 0 6px',
  padding: '6px 9px',
  background: 'rgba(255,43,208,0.1)',
  border: '1px solid rgba(255,43,208,0.45)',
  borderRadius: 9,
  color: '#ffb8ec',
  font: '600 10px/1.35 ui-monospace, Menlo, monospace',
  letterSpacing: '0.02em',
}
const inputRow: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'stretch',
}
const input: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '9px 12px',
  background: 'rgba(5,8,16,0.9)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 10,
  color: '#dff0ff',
  font: '600 13px/1.2 ui-monospace, Menlo, monospace',
  letterSpacing: '0.02em',
  outline: 'none',
}
const inputTouch: CSSProperties = {
  padding: '12px 14px',
  font: '600 16px/1.2 ui-monospace, Menlo, monospace', // 16px avoids iOS zoom-on-focus
  borderRadius: 12,
}
const sendBtn: CSSProperties = {
  flexShrink: 0,
  cursor: 'pointer',
  padding: '0 16px',
  background: 'linear-gradient(180deg,#5cf0ff,#27e7ff)',
  border: 'none',
  borderRadius: 10,
  color: '#04121a',
  font: '800 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
  whiteSpace: 'nowrap',
}
const sendBtnOff: CSSProperties = {
  cursor: 'not-allowed',
  background: 'rgba(39,231,255,0.12)',
  color: 'rgba(223,238,255,0.45)',
}
const count: CSSProperties = {
  marginTop: 4,
  textAlign: 'right',
  font: '600 9px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.08em',
}
