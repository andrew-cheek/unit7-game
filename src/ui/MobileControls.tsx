import { useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import type { GameAction, GameControls, HudState } from '../game/types'

const JOY_R = 52

interface BtnDef {
  label: string
  action: GameAction
  type: 'hold' | 'tap' | 'sprint'
  color: string
}

// Clear, readable labels (was JET/SPR/G/MRPH/NET/CHUTE). The set shown is built
// contextually each frame so the screen isn't cluttered with irrelevant actions.
const RUN: BtnDef = { label: 'RUN', action: 'sprint', type: 'sprint', color: '#9bff4d' }
const JET: BtnDef = { label: 'JET', action: 'jet', type: 'hold', color: '#27e7ff' }
const BOOST: BtnDef = { label: 'BOOST', action: 'boost', type: 'hold', color: '#ff8a1e' }
const MORPH: BtnDef = { label: 'MORPH', action: 'morph', type: 'tap', color: '#8a5cff' }
const CAPTURE: BtnDef = { label: 'CAPTURE', action: 'net', type: 'tap', color: '#9bff4d' }
const ENTER: BtnDef = { label: 'ENTER', action: 'enter', type: 'tap', color: '#27e7ff' }
const EXIT: BtnDef = { label: 'EXIT', action: 'enter', type: 'tap', color: '#ff2bd0' }
const CHUTE: BtnDef = { label: 'CHUTE', action: 'chute', type: 'tap', color: '#ff2bd0' }
const STOMP: BtnDef = { label: 'STOMP', action: 'net', type: 'tap', color: '#ff8a1e' }

/**
 * Touch controls: a left thumb-stick for movement, a right-side drag area for
 * the camera, and a contextual action cluster bottom-right. The button set and a
 * one-line helper adapt to what you can actually do right now (near a vehicle,
 * inside one, airborne, ...) so the layout stays clean and readable on a phone.
 */
export function MobileControls({ controls, hud }: { controls: GameControls; hud: HudState }) {
  const [knob, setKnob] = useState({ x: 0, y: 0 })
  const [sprintOn, setSprintOn] = useState(false)
  const joyId = useRef<number | null>(null)
  const joyOrigin = useRef({ x: 0, y: 0 })
  const lookId = useRef<number | null>(null)
  const lookLast = useRef({ x: 0, y: 0 })

  // --- context ---
  const inVehicle = hud.mode === 'vehicle'
  const nearVehicle = !inVehicle && !!hud.prompt
  const airborne = !inVehicle && hud.altitude > 2.5

  // Build the relevant button set (most-used nearest the thumb = first/bottom).
  let buttons: BtnDef[]
  if (inVehicle) {
    buttons = hud.vehicle === 'TITAN' ? [EXIT, STOMP, BOOST] : [EXIT, BOOST, JET]
  } else {
    buttons = [RUN, JET, BOOST, MORPH, CAPTURE]
    if (nearVehicle) buttons.unshift(ENTER)
    if (airborne) buttons.push(CHUTE)
  }

  // Helper text: the single most relevant hint.
  const helper = inVehicle
    ? 'EXIT VEHICLE'
    : nearVehicle
      ? 'ENTER VEHICLE'
      : airborne
        ? 'CHUTE AVAILABLE'
        : hud.fuel > 0.15
          ? 'JETPACK READY'
          : null

  // --- joystick ---
  const onJoyDown = (e: RPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    joyOrigin.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    joyId.current = e.pointerId
    moveJoy(e.clientX, e.clientY)
  }
  const onJoyMove = (e: RPointerEvent) => {
    if (e.pointerId === joyId.current) moveJoy(e.clientX, e.clientY)
  }
  const onJoyUp = (e: RPointerEvent) => {
    if (e.pointerId === joyId.current) {
      joyId.current = null
      setKnob({ x: 0, y: 0 })
      controls.setVirtualMove(0, 0)
    }
  }
  const moveJoy = (cx: number, cy: number) => {
    let dx = cx - joyOrigin.current.x
    let dy = cy - joyOrigin.current.y
    const len = Math.hypot(dx, dy)
    if (len > JOY_R) {
      dx = (dx / len) * JOY_R
      dy = (dy / len) * JOY_R
    }
    setKnob({ x: dx, y: dy })
    controls.setVirtualMove(dx / JOY_R, -dy / JOY_R) // up = forward
  }

  // --- look ---
  const onLookDown = (e: RPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    lookId.current = e.pointerId
    lookLast.current = { x: e.clientX, y: e.clientY }
  }
  const onLookMove = (e: RPointerEvent) => {
    if (e.pointerId !== lookId.current) return
    controls.setVirtualLook(e.clientX - lookLast.current.x, e.clientY - lookLast.current.y)
    lookLast.current = { x: e.clientX, y: e.clientY }
  }
  const onLookUp = (e: RPointerEvent) => {
    if (e.pointerId === lookId.current) lookId.current = null
  }

  // --- buttons ---
  const btnDown = (b: BtnDef) => (e: RPointerEvent) => {
    e.stopPropagation()
    if (b.type === 'sprint') {
      setSprintOn((s) => {
        controls.pressAction('sprint', !s)
        return !s
      })
    } else {
      controls.pressAction(b.action, true)
    }
  }
  const btnUp = (b: BtnDef) => (e: RPointerEvent) => {
    e.stopPropagation()
    if (b.type === 'hold') controls.pressAction(b.action, false)
  }

  return (
    <div style={root}>
      <div style={lookArea} onPointerDown={onLookDown} onPointerMove={onLookMove} onPointerUp={onLookUp} onPointerCancel={onLookUp} />

      <div style={joyBase} onPointerDown={onJoyDown} onPointerMove={onJoyMove} onPointerUp={onJoyUp} onPointerCancel={onJoyUp}>
        <div style={{ ...joyKnob, transform: `translate(${knob.x}px, ${knob.y}px)` }} />
      </div>

      <div style={cluster}>
        {helper && <div style={helperPill}>{helper}</div>}
        <div style={btnWrap}>
          {buttons.map((b) => {
            const active = b.type === 'sprint' && sprintOn
            return (
              <div
                key={b.label}
                style={{
                  ...btn,
                  borderColor: b.color,
                  color: active ? '#05060b' : b.color,
                  background: active ? b.color : 'rgba(8,12,24,0.62)',
                  boxShadow: `0 0 14px ${b.color}55`,
                }}
                onPointerDown={btnDown(b)}
                onPointerUp={btnUp(b)}
                onPointerCancel={btnUp(b)}
              >
                {b.label}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const root: CSSProperties = { position: 'absolute', inset: 0, zIndex: 8, pointerEvents: 'none', touchAction: 'none' }
const lookArea: CSSProperties = {
  position: 'absolute', right: 0, top: 0, width: '55%', height: '70%', pointerEvents: 'auto', touchAction: 'none',
}
const joyBase: CSSProperties = {
  position: 'absolute',
  left: 'max(20px, env(safe-area-inset-left))',
  bottom: 'max(24px, env(safe-area-inset-bottom))',
  width: JOY_R * 2,
  height: JOY_R * 2,
  borderRadius: '50%',
  border: '2px solid rgba(39,231,255,0.4)',
  background: 'rgba(8,12,24,0.35)',
  pointerEvents: 'auto',
  touchAction: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const joyKnob: CSSProperties = {
  width: 50, height: 50, borderRadius: '50%',
  background: 'rgba(39,231,255,0.55)', boxShadow: '0 0 18px rgba(39,231,255,0.6)',
}
const cluster: CSSProperties = {
  position: 'absolute',
  right: 'max(16px, env(safe-area-inset-right))',
  bottom: 'max(20px, env(safe-area-inset-bottom))',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 8,
  pointerEvents: 'none',
}
const helperPill: CSSProperties = {
  pointerEvents: 'none',
  padding: '4px 10px',
  borderRadius: 999,
  background: 'rgba(6,10,22,0.7)',
  border: '1px solid rgba(39,231,255,0.4)',
  color: 'rgba(223,238,255,0.92)',
  font: '700 10px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
}
const btnWrap: CSSProperties = {
  width: 180,
  display: 'flex',
  flexWrap: 'wrap',
  flexDirection: 'row-reverse',
  gap: 10,
  justifyContent: 'flex-start',
  pointerEvents: 'none',
}
const btn: CSSProperties = {
  pointerEvents: 'auto',
  touchAction: 'none',
  width: 56,
  height: 56,
  borderRadius: '50%',
  border: '2px solid',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  font: '700 10px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.03em',
  textAlign: 'center',
  userSelect: 'none',
  WebkitUserSelect: 'none',
}
