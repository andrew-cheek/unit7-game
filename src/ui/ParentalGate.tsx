import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useUnit7UiStyles, U7_UI_CLASS, panelEnter, backdropEnter } from './uiAnims'

/**
 * ParentalGate — the "ask a grown-up" + PIN screen that gates whether typed
 * chat with other players can be enabled.
 *
 * Pure presentational: all persistence/crypto is injected via props. The
 * component owns only local input + attempt state. Matches the Unit 7 neon
 * panel aesthetic (cyan/magenta, ui-monospace, modal/backdrop).
 */
export interface ParentalGateProps {
  /** 'setup' = create a PIN for the first time; 'verify' = enter the existing PIN. */
  mode: 'setup' | 'verify'
  /**
   * Arithmetic gate shown before PIN setup (mode 'setup'). A soft gate so a
   * young child can't proceed on their own. `answer` is compared case/space
   * insensitively against what's typed.
   */
  challenge?: { question: string; answer: string }
  /** Number of digits in the PIN (e.g. 4). */
  pinLength: number
  /** setup: store the freshly created PIN. */
  onSetPin: (pin: string) => Promise<void>
  /** verify: check the entered PIN. Resolve true on match. */
  onVerify: (pin: string) => Promise<boolean>
  /** Called after a correct PIN entry / successful setup. */
  onSuccess: () => void
  /** Called when the grown-up backs out. */
  onCancel: () => void
}

/** Wrong-PIN attempts before a short lock-out kicks in. */
const MAX_ATTEMPTS = 4
/** Lock-out duration after too many wrong tries (ms). */
const LOCKOUT_MS = 20_000

type SetupStep = 'challenge' | 'create' | 'confirm'

export function ParentalGate(props: ParentalGateProps) {
  const { mode, challenge, pinLength, onSetPin, onVerify, onSuccess, onCancel } = props
  useUnit7UiStyles()

  // ---- shared state ----------------------------------------------------
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ---- setup-flow state ------------------------------------------------
  const [setupStep, setSetupStep] = useState<SetupStep>(challenge ? 'challenge' : 'create')
  const [challengeText, setChallengeText] = useState('')
  const [createdPin, setCreatedPin] = useState('')

  // ---- pin entry state (shared by create/confirm/verify) ---------------
  const [pin, setPin] = useState('')

  // ---- anti-guessing state (verify) ------------------------------------
  const [attempts, setAttempts] = useState(0)
  const [lockedUntil, setLockedUntil] = useState(0)
  const [, force] = useState(0)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const now = Date.now()
  const locked = lockedUntil > now
  const lockSecs = locked ? Math.ceil((lockedUntil - now) / 1000) : 0

  // re-render once per second while locked so the countdown ticks down
  if (locked && tickRef.current === null) {
    tickRef.current = setInterval(() => {
      if (Date.now() >= lockedUntil) {
        if (tickRef.current) clearInterval(tickRef.current)
        tickRef.current = null
        setAttempts(0)
      }
      force((n) => n + 1)
    }, 500)
  }

  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '')

  const appendDigit = useCallback(
    (d: string) => {
      if (busy || locked) return
      setError(null)
      setPin((p) => (p.length >= pinLength ? p : p + d))
    },
    [busy, locked, pinLength],
  )
  const backspace = useCallback(() => {
    if (busy || locked) return
    setError(null)
    setPin((p) => p.slice(0, -1))
  }, [busy, locked])
  const clearPin = useCallback(() => {
    if (busy || locked) return
    setError(null)
    setPin('')
  }, [busy, locked])

  const pinComplete = pin.length === pinLength

  // ---- handlers --------------------------------------------------------
  const submitChallenge = useCallback(() => {
    if (!challenge) return
    if (normalize(challengeText) === normalize(challenge.answer)) {
      setError(null)
      setChallengeText('')
      setSetupStep('create')
    } else {
      setError("That's not quite right — ask a grown-up to help.")
    }
  }, [challenge, challengeText])

  const submitCreate = useCallback(() => {
    if (!pinComplete) return
    setCreatedPin(pin)
    setPin('')
    setError(null)
    setSetupStep('confirm')
  }, [pin, pinComplete])

  const submitConfirm = useCallback(async () => {
    if (!pinComplete) return
    if (pin !== createdPin) {
      setError("Those PINs didn't match. Let's set it again.")
      setPin('')
      setCreatedPin('')
      setSetupStep('create')
      return
    }
    setBusy(true)
    try {
      await onSetPin(createdPin)
      onSuccess()
    } catch {
      setError('Something went wrong saving the PIN. Please try again.')
      setBusy(false)
    }
  }, [pin, pinComplete, createdPin, onSetPin, onSuccess])

  const submitVerify = useCallback(async () => {
    if (!pinComplete || locked) return
    setBusy(true)
    try {
      const ok = await onVerify(pin)
      if (ok) {
        onSuccess()
        return
      }
      const next = attempts + 1
      setAttempts(next)
      setPin('')
      if (next >= MAX_ATTEMPTS) {
        setLockedUntil(Date.now() + LOCKOUT_MS)
        setError('Too many tries. Please wait a moment and ask your grown-up.')
      } else {
        setError('Wrong PIN, ask your grown-up.')
      }
      setBusy(false)
    } catch {
      setError('Something went wrong checking the PIN. Please try again.')
      setBusy(false)
    }
  }, [pin, pinComplete, locked, onVerify, onSuccess, attempts])

  // submit handler for the active step
  const onPrimary = useCallback(() => {
    if (mode === 'verify') return void submitVerify()
    if (setupStep === 'create') return submitCreate()
    if (setupStep === 'confirm') return void submitConfirm()
  }, [mode, setupStep, submitVerify, submitCreate, submitConfirm])

  // ---- derived copy ----------------------------------------------------
  const showPinPad = mode === 'verify' || setupStep === 'create' || setupStep === 'confirm'
  const primaryLabel = useMemo(() => {
    if (mode === 'verify') return 'UNLOCK'
    if (setupStep === 'create') return 'NEXT'
    return 'SAVE PIN'
  }, [mode, setupStep])

  const stepHint = useMemo(() => {
    if (mode === 'verify') return 'Enter your PIN to turn on chat.'
    if (setupStep === 'challenge') return 'A quick question first.'
    if (setupStep === 'create') return `Pick a ${pinLength}-digit PIN you'll remember.`
    return 'Type the same PIN again to confirm.'
  }, [mode, setupStep, pinLength])

  return (
    <div className={U7_UI_CLASS} style={{ ...wrap, ...backdropEnter }} role="dialog" aria-modal="true" aria-label="Grown-ups only — parental gate" onClick={onCancel}>
      <div style={{ ...card, ...panelEnter }} onClick={(e) => e.stopPropagation()}>
        <div style={headerRow}>
          <span aria-hidden style={lockBadge}>
            🔒
          </span>
          <div style={title}>GROWN-UPS ONLY</div>
        </div>

        <p style={copy}>
          This unlocks <strong style={{ color: '#5cf0ff' }}>typed chat</strong> with other players. It's turned{' '}
          <strong style={{ color: '#9bff4d' }}>off by default</strong> to keep things safe. Set a PIN so only a grown-up
          can change it.
        </p>

        <div style={hint}>{stepHint}</div>

        {/* ---- arithmetic challenge (setup gate) ---- */}
        {mode === 'setup' && setupStep === 'challenge' && challenge && (
          <div style={section}>
            <label style={questionLabel} htmlFor="pg-challenge">
              To continue, {challenge.question}
            </label>
            <input
              id="pg-challenge"
              style={textInput}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              value={challengeText}
              placeholder="Type the answer"
              aria-label={`To continue, ${challenge.question}`}
              onChange={(e) => {
                setError(null)
                setChallengeText(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitChallenge()
              }}
            />
            <button
              style={primaryBtn}
              type="button"
              disabled={challengeText.trim().length === 0}
              onClick={submitChallenge}
            >
              CONTINUE
            </button>
          </div>
        )}

        {/* ---- PIN entry (create / confirm / verify) ---- */}
        {showPinPad && (
          <div style={section}>
            <PinDots length={pinLength} filled={pin.length} aria-label={`${pin.length} of ${pinLength} digits entered`} />

            <Keypad
              disabled={busy || locked}
              onDigit={appendDigit}
              onBackspace={backspace}
              onClear={clearPin}
            />

            <button
              style={pinComplete && !busy && !locked ? primaryBtn : primaryBtnDisabled}
              type="button"
              disabled={!pinComplete || busy || locked}
              onClick={onPrimary}
            >
              {busy ? 'PLEASE WAIT…' : locked ? `LOCKED ${lockSecs}s` : primaryLabel}
            </button>
          </div>
        )}

        {error && (
          <div style={errBox} role="alert">
            {error}
          </div>
        )}

        <button style={cancelBtn} type="button" onClick={onCancel}>
          CANCEL
        </button>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------

function PinDots(props: { length: number; filled: number; 'aria-label'?: string }) {
  const { length, filled } = props
  return (
    <div style={dotsRow} role="img" aria-label={props['aria-label']}>
      {Array.from({ length }, (_, i) => (
        <span key={i} style={i < filled ? dotFilled : dotEmpty} aria-hidden />
      ))}
    </div>
  )
}

function Keypad(props: {
  disabled: boolean
  onDigit: (d: string) => void
  onBackspace: () => void
  onClear: () => void
}) {
  const { disabled, onDigit, onBackspace, onClear } = props
  return (
    <div style={keypad}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
        <button
          key={d}
          style={disabled ? keyBtnDisabled : keyBtn}
          type="button"
          disabled={disabled}
          aria-label={`Digit ${d}`}
          onClick={() => onDigit(d)}
        >
          {d}
        </button>
      ))}
      <button
        style={disabled ? keyBtnSecDisabled : keyBtnSec}
        type="button"
        disabled={disabled}
        aria-label="Clear"
        onClick={onClear}
      >
        CLR
      </button>
      <button
        style={disabled ? keyBtnDisabled : keyBtn}
        type="button"
        disabled={disabled}
        aria-label="Digit 0"
        onClick={() => onDigit('0')}
      >
        0
      </button>
      <button
        style={disabled ? keyBtnSecDisabled : keyBtnSec}
        type="button"
        disabled={disabled}
        aria-label="Delete last digit"
        onClick={onBackspace}
      >
        ⌫
      </button>
    </div>
  )
}

// ----------------------------------------------------------------------
// Styles — neon panel aesthetic (cyan/magenta, ui-monospace)
// ----------------------------------------------------------------------

const wrap: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 60,
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  background: 'rgba(2,4,10,0.62)',
}
const card: CSSProperties = {
  width: 'min(380px, 94vw)',
  maxHeight: '94vh',
  overflowY: 'auto',
  padding: '20px 22px 18px',
  textAlign: 'center',
  borderRadius: 16,
  background: 'rgba(6,10,22,0.96)',
  border: '1px solid rgba(39,231,255,0.5)',
  boxShadow: '0 0 34px rgba(39,231,255,0.25)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
const headerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  marginBottom: 8,
}
const lockBadge: CSSProperties = {
  fontSize: 18,
  lineHeight: 1,
}
const title: CSSProperties = {
  color: '#27e7ff',
  textShadow: '0 0 16px rgba(39,231,255,0.6)',
  font: '800 17px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.18em',
}
const copy: CSSProperties = {
  margin: '0 0 12px',
  color: 'rgba(223,238,255,0.72)',
  font: '600 11.5px/1.55 ui-monospace, Menlo, monospace',
}
const hint: CSSProperties = {
  marginBottom: 14,
  color: '#ff2bd0',
  textShadow: '0 0 12px rgba(255,43,208,0.4)',
  font: '700 12px/1.4 ui-monospace, Menlo, monospace',
  letterSpacing: '0.04em',
}
const section: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 14,
}
const questionLabel: CSSProperties = {
  color: '#dff0ff',
  font: '700 15px/1.4 ui-monospace, Menlo, monospace',
}
const textInput: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '12px 14px',
  textAlign: 'center',
  color: '#dff0ff',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(39,231,255,0.4)',
  borderRadius: 10,
  font: '700 18px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.1em',
  outline: 'none',
}
const dotsRow: CSSProperties = {
  display: 'flex',
  gap: 14,
  justifyContent: 'center',
  marginTop: 2,
  minHeight: 18,
}
const dotBase: CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: 999,
  display: 'inline-block',
}
const dotEmpty: CSSProperties = {
  ...dotBase,
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.25)',
}
const dotFilled: CSSProperties = {
  ...dotBase,
  background: 'linear-gradient(180deg,#5cf0ff,#27e7ff)',
  boxShadow: '0 0 12px rgba(39,231,255,0.7)',
  border: '1px solid rgba(39,231,255,0.8)',
}
const keypad: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 10,
  width: '100%',
  maxWidth: 280,
}
const keyBtn: CSSProperties = {
  cursor: 'pointer',
  height: 56,
  color: '#dff0ff',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(39,231,255,0.4)',
  borderRadius: 12,
  font: '800 22px/1 ui-monospace, Menlo, monospace',
  touchAction: 'manipulation',
  userSelect: 'none',
}
const keyBtnDisabled: CSSProperties = {
  ...keyBtn,
  cursor: 'default',
  opacity: 0.4,
}
const keyBtnSec: CSSProperties = {
  ...keyBtn,
  color: 'rgba(223,238,255,0.8)',
  border: '1px solid rgba(255,255,255,0.18)',
  font: '700 16px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.06em',
}
const keyBtnSecDisabled: CSSProperties = {
  ...keyBtnSec,
  cursor: 'default',
  opacity: 0.4,
}
const primaryBtn: CSSProperties = {
  cursor: 'pointer',
  width: '100%',
  maxWidth: 280,
  padding: '12px 20px',
  font: '800 13px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  color: '#04121a',
  background: 'linear-gradient(180deg,#5cf0ff,#27e7ff)',
  border: 'none',
  borderRadius: 10,
  touchAction: 'manipulation',
}
const primaryBtnDisabled: CSSProperties = {
  ...primaryBtn,
  cursor: 'default',
  opacity: 0.45,
  background: 'rgba(39,231,255,0.25)',
  color: 'rgba(4,18,26,0.7)',
}
const errBox: CSSProperties = {
  marginTop: 14,
  padding: '9px 12px',
  color: '#ffd0ec',
  background: 'rgba(255,43,208,0.1)',
  border: '1px solid rgba(255,43,208,0.5)',
  borderRadius: 10,
  font: '600 11.5px/1.45 ui-monospace, Menlo, monospace',
}
const cancelBtn: CSSProperties = {
  marginTop: 16,
  cursor: 'pointer',
  padding: '9px 22px',
  background: 'rgba(6,10,22,0.8)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.8)',
  font: '700 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
  touchAction: 'manipulation',
}
