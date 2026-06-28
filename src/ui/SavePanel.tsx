import { useState, useRef, useEffect, type CSSProperties } from 'react'

/**
 * Save / Restore panel. Kid-friendly, touch/iPad-first, fully PROP-DRIVEN: it
 * never touches the store, network, clipboard or localStorage itself. Every side
 * effect is a callback the host wires at integration time, so this file stays a
 * pure presentational component (the only state it owns is the restore input box
 * and its in-flight/result UI). By design it collects NO personal info — there is
 * no name or email field anywhere; the recovery code is the only identity.
 */
export interface SavePanelProps {
  /** The player's recovery code, e.g. "BRAVE-TIGER-MOON-42". */
  recoveryCode: string
  /** Whether the cloud save backend is currently reachable. */
  online: boolean
  /** Copy the recovery code to the clipboard (host owns the clipboard call). */
  onCopyCode: () => void
  /** Restore a save from a typed code. Resolves ok, or ok:false with a reason. */
  onRestore: (code: string) => Promise<{ ok: boolean; error?: string }>
  /** Close the panel. */
  onClose: () => void
  /** Touch device: bigger tap targets, no autofocus stealing the on-screen keyboard. */
  touch: boolean
}

type RestoreState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string }

export function SavePanel({ recoveryCode, online, onCopyCode, onRestore, onClose, touch }: SavePanelProps) {
  const [code, setCode] = useState('')
  const [restore, setRestore] = useState<RestoreState>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    }
  }, [])

  // Escape closes (works even with the on-screen keyboard up / pointer locked).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleCopy = () => {
    onCopyCode()
    setCopied(true)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => { if (aliveRef.current) setCopied(false) }, 1800)
  }

  const trimmed = code.trim()
  const canRestore = trimmed.length > 0 && restore.kind !== 'busy'

  const handleRestore = async () => {
    if (!canRestore) return
    setRestore({ kind: 'busy' })
    try {
      const res = await onRestore(trimmed)
      if (!aliveRef.current) return
      if (res.ok) {
        setRestore({ kind: 'ok' })
      } else {
        setRestore({ kind: 'error', message: GENTLE_ERROR })
      }
    } catch {
      if (!aliveRef.current) return
      setRestore({ kind: 'error', message: GENTLE_ERROR })
    }
  }

  return (
    <div style={backdrop} onPointerDown={onClose}>
      <style>{SAVE_KEYFRAMES}</style>
      <div
        style={touch ? { ...card, ...cardTouch } : card}
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="u7-save-title"
      >
        {/* Header */}
        <div style={headRow}>
          <div>
            <div id="u7-save-title" style={title}>SAVE &amp; RESTORE</div>
            <div style={subtitle}>Your game saves by itself. Write down this code to play on another iPad.</div>
          </div>
          <button style={closeBtn} onClick={onClose} aria-label="Close save panel">✕</button>
        </div>

        {/* Online / offline indicator */}
        <div style={{ ...statusPill, ...(online ? statusOnline : statusOffline) }}>
          {online ? (
            <><span aria-hidden>☁</span><span>Saved to the cloud ✓</span></>
          ) : (
            <><span aria-hidden>⚠</span><span>Offline — saves on this device only</span></>
          )}
        </div>

        {/* The recovery code, big and readable, with a COPY button. */}
        <div style={section}>
          <div style={sectionLabel}>YOUR CODE</div>
          <div style={codeBox} aria-label="Your recovery code">{recoveryCode}</div>
          <button
            style={touch ? { ...copyBtn, ...bigTouch } : copyBtn}
            onClick={handleCopy}
            aria-live="polite"
          >
            {copied ? 'COPIED! ✓' : 'COPY CODE'}
          </button>
          <div style={helperText}>Keep this code safe. Anyone with it can load your game.</div>
        </div>

        {/* Restore-on-this-device. */}
        <div style={section}>
          <div style={sectionLabel}>RESTORE ON THIS DEVICE</div>
          <label htmlFor="u7-restore-code" style={inputLabel}>Type a code to load that game here.</label>
          <input
            id="u7-restore-code"
            value={code}
            // No autofocus on touch: it would yank up the on-screen keyboard and
            // cover the code the player is trying to read.
            autoFocus={!touch}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="BRAVE-TIGER-MOON-42"
            disabled={restore.kind === 'busy'}
            onChange={(e) => {
              setCode(e.target.value)
              if (restore.kind === 'error' || restore.kind === 'ok') setRestore({ kind: 'idle' })
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRestore() }}
            style={touch ? { ...input, ...inputTouch } : input}
          />
          <button
            style={{
              ...(touch ? { ...restoreBtn, ...bigTouch } : restoreBtn),
              opacity: canRestore ? 1 : 0.45,
              cursor: canRestore ? 'pointer' : 'not-allowed',
            }}
            onClick={handleRestore}
            disabled={!canRestore}
          >
            {restore.kind === 'busy' ? (
              <span style={busyRow}><span style={spinner} aria-hidden />RESTORING…</span>
            ) : (
              'RESTORE ▸'
            )}
          </button>

          {restore.kind === 'ok' && (
            <div style={{ ...resultMsg, ...resultOk }} role="status">Your game was restored! ✓</div>
          )}
          {restore.kind === 'error' && (
            <div style={{ ...resultMsg, ...resultErr }} role="alert">{restore.message}</div>
          )}
        </div>

        <button style={touch ? { ...doneBtn, ...bigTouch } : doneBtn} onClick={onClose}>CLOSE</button>
      </div>
    </div>
  )
}

const GENTLE_ERROR = "That code didn't work — check the words and try again."

const NEON = {
  cyan: '#27e7ff',
  magenta: '#ff2bd0',
  lime: '#9bff4d',
  text: 'rgba(223,238,255,0.92)',
  dim: 'rgba(223,238,255,0.6)',
}

const SAVE_KEYFRAMES = `@keyframes u7spin{to{transform:rotate(360deg)}}`

const backdrop: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 44,
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  background: 'rgba(2,4,10,0.6)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
const card: CSSProperties = {
  width: 'min(460px, 92vw)',
  maxHeight: '92vh',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: '22px 24px 24px',
  borderRadius: 16,
  background: 'rgba(6,10,22,0.95)',
  border: '1px solid rgba(39,231,255,0.5)',
  boxShadow: '0 0 34px rgba(39,231,255,0.25)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
}
const cardTouch: CSSProperties = {
  width: 'min(560px, 94vw)',
  gap: 18,
  padding: '24px 26px 26px',
}
const headRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
}
const title: CSSProperties = {
  color: NEON.cyan,
  textShadow: '0 0 16px #27e7ff',
  font: '800 19px/1.1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
}
const subtitle: CSSProperties = {
  marginTop: 8,
  color: NEON.dim,
  font: '600 13px/1.5 ui-monospace, Menlo, monospace',
  letterSpacing: '0.02em',
  maxWidth: 360,
}
const closeBtn: CSSProperties = {
  flexShrink: 0,
  pointerEvents: 'auto',
  cursor: 'pointer',
  width: 36,
  height: 36,
  borderRadius: 999,
  background: 'rgba(6,10,22,0.8)',
  border: '1px solid rgba(255,255,255,0.18)',
  color: 'rgba(223,238,255,0.8)',
  font: '800 16px/1 ui-monospace, Menlo, monospace',
}
const statusPill: CSSProperties = {
  alignSelf: 'flex-start',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 14px',
  borderRadius: 999,
  border: '1px solid',
  font: '700 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.08em',
}
const statusOnline: CSSProperties = {
  color: NEON.lime,
  borderColor: 'rgba(155,255,77,0.6)',
  background: 'rgba(155,255,77,0.08)',
}
const statusOffline: CSSProperties = {
  color: '#ff8a1e',
  borderColor: 'rgba(255,138,30,0.6)',
  background: 'rgba(255,138,30,0.08)',
}
const section: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '14px 16px',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.1)',
}
const sectionLabel: CSSProperties = {
  color: NEON.dim,
  font: '700 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.18em',
}
const codeBox: CSSProperties = {
  padding: '16px 14px',
  textAlign: 'center',
  wordBreak: 'break-word',
  color: '#eaf6ff',
  textShadow: '0 0 14px rgba(39,231,255,0.6)',
  font: '800 26px/1.2 ui-monospace, Menlo, monospace',
  letterSpacing: '0.1em',
  background: 'rgba(5,8,16,0.9)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 12,
}
const copyBtn: CSSProperties = {
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '13px 0',
  font: '800 14px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  color: '#04121a',
  background: 'linear-gradient(180deg,#5cf0ff,#27e7ff)',
  border: 'none',
  borderRadius: 10,
}
const helperText: CSSProperties = {
  color: 'rgba(223,238,255,0.5)',
  font: '600 11px/1.5 ui-monospace, Menlo, monospace',
  letterSpacing: '0.02em',
}
const inputLabel: CSSProperties = {
  color: NEON.dim,
  font: '600 12px/1.4 ui-monospace, Menlo, monospace',
  letterSpacing: '0.02em',
}
const input: CSSProperties = {
  padding: '13px 14px',
  textAlign: 'center',
  font: '700 17px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
  color: '#dff0ff',
  background: 'rgba(5,8,16,0.9)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 10,
  outline: 'none',
}
const inputTouch: CSSProperties = {
  padding: '16px 14px',
  fontSize: 19,
}
const restoreBtn: CSSProperties = {
  pointerEvents: 'auto',
  padding: '13px 0',
  font: '800 14px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  color: '#9fe8ff',
  background: 'rgba(39,231,255,0.1)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 10,
}
const busyRow: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
}
const spinner: CSSProperties = {
  width: 14,
  height: 14,
  borderRadius: '50%',
  border: '2px solid rgba(159,232,255,0.3)',
  borderTopColor: '#9fe8ff',
  display: 'inline-block',
  animation: 'u7spin 0.7s linear infinite',
}
const resultMsg: CSSProperties = {
  padding: '11px 14px',
  borderRadius: 10,
  border: '1px solid',
  font: '700 13px/1.4 ui-monospace, Menlo, monospace',
  letterSpacing: '0.02em',
  textAlign: 'center',
}
const resultOk: CSSProperties = {
  color: NEON.lime,
  borderColor: 'rgba(155,255,77,0.6)',
  background: 'rgba(155,255,77,0.1)',
}
const resultErr: CSSProperties = {
  color: '#ffb3c8',
  borderColor: 'rgba(255,43,208,0.5)',
  background: 'rgba(255,43,208,0.1)',
}
const doneBtn: CSSProperties = {
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '13px 0',
  font: '700 13px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  color: 'rgba(223,238,255,0.8)',
  background: 'rgba(6,10,22,0.8)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 10,
}
// Touch override: chunkier tap targets so small fingers hit them on an iPad.
const bigTouch: CSSProperties = {
  padding: '17px 0',
  fontSize: 15,
}
