import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import type { GameAction, GameControls, HudState } from '../game/types'

const JOY_R = 56
const JOY_DEAD = 8 // px of slack around center so a resting thumb reads as zero

interface BtnDef {
  label: string
  action: GameAction
  type: 'hold' | 'tap' | 'sprint'
  color: string
}

// JUMP is the primary button (tap = jump, hold = jetpack/fly), in the spot a
// Roblox player reaches for. The rest are secondary and only shown when useful.
const JUMP: BtnDef = { label: 'JUMP', action: 'jet', type: 'hold', color: '#27e7ff' }
const JET: BtnDef = { label: 'JET', action: 'jet', type: 'hold', color: '#27e7ff' }
const RUN: BtnDef = { label: 'SPRINT', action: 'sprint', type: 'sprint', color: '#9bff4d' }
const BOOST: BtnDef = { label: 'BOOST', action: 'boost', type: 'hold', color: '#ff8a1e' }
const MORPH: BtnDef = { label: 'TRANSFORM', action: 'morph', type: 'tap', color: '#8a5cff' }
const CAPTURE: BtnDef = { label: 'CAPTURE', action: 'net', type: 'tap', color: '#9bff4d' }
const ENTER: BtnDef = { label: 'ENTER', action: 'enter', type: 'tap', color: '#27e7ff' }
const EXIT: BtnDef = { label: 'EXIT', action: 'enter', type: 'tap', color: '#ff2bd0' }
const CHUTE: BtnDef = { label: 'CHUTE', action: 'chute', type: 'tap', color: '#ff2bd0' }
const CUT: BtnDef = { label: 'CUT', action: 'chute', type: 'tap', color: '#ff8a1e' }
const GRAPPLE: BtnDef = { label: 'GRAPPLE', action: 'grapple', type: 'hold', color: '#27e7ff' }
const FIRE: BtnDef = { label: 'FIRE', action: 'net', type: 'tap', color: '#ff8a1e' }
const BOARD: BtnDef = { label: 'BOARD', action: 'board', type: 'tap', color: '#27e7ff' }
const WARP: BtnDef = { label: 'WARP', action: 'warp', type: 'tap', color: '#b46bff' }

/**
 * Touch controls in the shape a Roblox player expects: a floating left thumb-stick
 * that appears wherever you press, a big JUMP button bottom-right (tap to jump,
 * hold to fly), a small secondary cluster that only shows relevant actions, and
 * two-finger pinch-to-zoom on the camera side. The right side of the screen is
 * the camera-drag area.
 */
export function MobileControls({ controls, hud }: { controls: GameControls; hud: HudState }) {
  const [knob, setKnob] = useState({ x: 0, y: 0 })
  const [joyAt, setJoyAt] = useState<{ x: number; y: number } | null>(null)
  const [sprintOn, setSprintOn] = useState(false)
  const joyId = useRef<number | null>(null)
  const joyOrigin = useRef({ x: 0, y: 0 })
  const lookId = useRef<number | null>(null)
  const lookLast = useRef({ x: 0, y: 0 })
  // Pinch: track pointers active in the camera area; 2 = zoom gesture.
  const pinch = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchDist = useRef<number | null>(null)

  // Sprint is a toggle. The engine clears held inputs on window blur, so sync the
  // button's visual state off too, otherwise it can show "on" while the engine
  // has already stopped sprinting (a stuck-sprint mismatch).
  useEffect(() => {
    const reset = () => setSprintOn(false)
    window.addEventListener('blur', reset)
    return () => window.removeEventListener('blur', reset)
  }, [])

  // --- context ---
  const inVehicle = hud.mode === 'vehicle'
  const nearVehicle = !inVehicle && !!hud.prompt
  const airborne = !inVehicle && hud.altitude > 2.5
  const inMech = inVehicle && !!hud.vehicle && hud.vehicle.startsWith('MECH')

  // Primary button + a trimmed secondary set (contextual only).
  let primary: BtnDef = JUMP
  let secondary: BtnDef[]
  if (inVehicle) {
    primary = inMech ? JET : BOOST
    secondary = inMech ? [EXIT, FIRE, MORPH] : [EXIT]
  } else {
    secondary = [RUN]
    if (nearVehicle) secondary.unshift(ENTER)
    if (hud.warp.ready || hud.warp.active) secondary.unshift(WARP)
    if (hud.canCapture) secondary.push(CAPTURE)
    if (!airborne) secondary.push(MORPH, BOARD)
    secondary.push(GRAPPLE) // hold to fire the grapple arm and zip around
    // CHUTE / CUT is a dedicated left-side button (see below) -- not in this cluster
  }

  const helper = inMech
    ? 'JET TO FLY · FIRE'
    : inVehicle
    ? 'EXIT VEHICLE'
    : nearVehicle
      ? (hud.prompt && /RIDE TO/.test(hud.prompt) ? 'RIDE THE ROCKET' : 'ENTER')
      : hud.warp.active
        ? 'WARP: SWITCH / RETURN'
        : hud.warp.ready
          ? 'WARP READY'
          : 'TAP JUMP · HOLD TO FLY'

  // --- floating joystick (left half) ---
  const onJoyDown = (e: RPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    joyId.current = e.pointerId
    joyOrigin.current = { x: e.clientX, y: e.clientY }
    setJoyAt({ x: e.clientX, y: e.clientY })
    setKnob({ x: 0, y: 0 })
  }
  const onJoyMove = (e: RPointerEvent) => {
    if (e.pointerId !== joyId.current) return
    let dx = e.clientX - joyOrigin.current.x
    let dy = e.clientY - joyOrigin.current.y
    const len = Math.hypot(dx, dy)
    if (len > JOY_R) { dx = (dx / len) * JOY_R; dy = (dy / len) * JOY_R }
    setKnob({ x: dx, y: dy }) // knob still tracks the raw thumb position
    // Deadzone + magnitude rescale: a resting thumb reads as zero intent and the
    // usable range ramps 0..1 from the deadzone edge, so contact no longer lurches
    // movement (the mech/glide path floors intent at 0.55 with no gate).
    const clampedLen = Math.min(len, JOY_R)
    if (clampedLen <= JOY_DEAD) { controls.setVirtualMove(0, 0); return }
    const mag = (clampedLen - JOY_DEAD) / (JOY_R - JOY_DEAD)
    controls.setVirtualMove((dx / clampedLen) * mag, -(dy / clampedLen) * mag)
  }
  const onJoyUp = (e: RPointerEvent) => {
    if (e.pointerId !== joyId.current) return
    joyId.current = null
    setJoyAt(null)
    setKnob({ x: 0, y: 0 })
    controls.setVirtualMove(0, 0)
  }

  // --- camera drag + pinch zoom (right half) ---
  const onLookDown = (e: RPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current.size >= 2) {
      const [a, b] = [...pinch.current.values()]
      pinchDist.current = Math.hypot(a.x - b.x, a.y - b.y)
      lookId.current = null // a pinch is not a look-drag
    } else {
      lookId.current = e.pointerId
      lookLast.current = { x: e.clientX, y: e.clientY }
    }
  }
  const onLookMove = (e: RPointerEvent) => {
    if (pinch.current.has(e.pointerId)) pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current.size >= 2 && pinchDist.current != null) {
      const [a, b] = [...pinch.current.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (d > 1) { controls.adjustZoom(pinchDist.current / d); pinchDist.current = d } // spread = zoom in
      return
    }
    if (e.pointerId !== lookId.current) return
    controls.setVirtualLook(e.clientX - lookLast.current.x, e.clientY - lookLast.current.y)
    lookLast.current = { x: e.clientX, y: e.clientY }
  }
  const onLookUp = (e: RPointerEvent) => {
    pinch.current.delete(e.pointerId)
    if (pinch.current.size < 2) pinchDist.current = null
    if (e.pointerId === lookId.current) lookId.current = null
  }

  // --- buttons ---
  const btnDown = (b: BtnDef) => (e: RPointerEvent) => {
    e.stopPropagation()
    if (b.type === 'sprint') setSprintOn((s) => { controls.pressAction('sprint', !s); return !s })
    else controls.pressAction(b.action, true)
  }
  const btnUp = (b: BtnDef) => (e: RPointerEvent) => {
    e.stopPropagation()
    if (b.type === 'hold') controls.pressAction(b.action, false)
  }

  // CHUTE / CUT stacks directly above JUMP (right side) while airborne, so it's a
  // prominent second action under the right thumb and never overlaps the floating
  // joystick on the left. Label + color flip once the canopy is open.
  const showChuteBtn = !inVehicle && airborne
  const chuteLabel = hud.mode === 'parachute' ? 'CUT' : 'CHUTE'
  const chuteColor = hud.mode === 'parachute' ? '#ff8a1e' : '#ff2bd0'

  return (
    <div style={root}>
      {/* camera area (right) handles look-drag + pinch zoom */}
      <div style={lookArea} onPointerDown={onLookDown} onPointerMove={onLookMove} onPointerUp={onLookUp} onPointerCancel={onLookUp} />
      {/* movement area (left) summons the floating stick where you press */}
      <div style={joyArea} onPointerDown={onJoyDown} onPointerMove={onJoyMove} onPointerUp={onJoyUp} onPointerCancel={onJoyUp} />

      {joyAt && (
        <div style={{ ...joyBase, left: joyAt.x - JOY_R, top: joyAt.y - JOY_R }}>
          <div style={{ ...joyKnob, transform: `translate(${knob.x}px, ${knob.y}px)` }} />
        </div>
      )}

      <div style={cluster}>
        {helper && <div style={helperPill}>{helper}</div>}
        <div style={secWrap}>
          {secondary.map((b) => {
            const active = b.type === 'sprint' && sprintOn
            return (
              <div
                key={b.label}
                style={{ ...secBtn, borderColor: b.color, color: active ? '#05060b' : b.color, background: active ? b.color : 'rgba(8,12,24,0.62)', boxShadow: `0 0 12px ${b.color}55` }}
                onPointerDown={btnDown(b)}
                onPointerUp={btnUp(b)}
                onPointerCancel={btnUp(b)}
              >
                {b.label}
              </div>
            )
          })}
        </div>
        {showChuteBtn && (
          <div
            style={{ ...chuteBtn, borderColor: chuteColor, color: chuteColor, boxShadow: `0 0 18px ${chuteColor}66` }}
            onPointerDown={(e) => { e.stopPropagation(); controls.pressAction('chute', true) }}
            onPointerUp={(e) => { e.stopPropagation(); controls.pressAction('chute', false) }}
            onPointerCancel={(e) => { e.stopPropagation(); controls.pressAction('chute', false) }}
          >
            {chuteLabel}
          </div>
        )}
        <div
          style={{ ...primaryBtn, borderColor: primary.color, color: primary.color, boxShadow: `0 0 22px ${primary.color}66` }}
          onPointerDown={btnDown(primary)}
          onPointerUp={btnUp(primary)}
          onPointerCancel={btnUp(primary)}
        >
          {primary.label}
        </div>
      </div>
    </div>
  )
}

const root: CSSProperties = { position: 'absolute', inset: 0, zIndex: 8, pointerEvents: 'none', touchAction: 'none' }
// Clean left/right split so a center touch is never ambiguous: left half drives
// the floating stick, right half drives camera-drag + pinch. The action buttons
// render on top of these areas, so taps on them still win.
const lookArea: CSSProperties = { position: 'absolute', left: '50%', top: 0, width: '50%', height: '82%', pointerEvents: 'auto', touchAction: 'none' }
const joyArea: CSSProperties = { position: 'absolute', left: 0, bottom: 0, width: '50%', height: '78%', pointerEvents: 'auto', touchAction: 'none' }
const joyBase: CSSProperties = {
  position: 'absolute',
  width: JOY_R * 2,
  height: JOY_R * 2,
  borderRadius: '50%',
  border: '2px solid rgba(39,231,255,0.4)',
  background: 'rgba(8,12,24,0.32)',
  pointerEvents: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const joyKnob: CSSProperties = {
  width: 52, height: 52, borderRadius: '50%',
  background: 'rgba(39,231,255,0.55)', boxShadow: '0 0 18px rgba(39,231,255,0.6)',
}
const cluster: CSSProperties = {
  position: 'absolute',
  right: 'max(16px, env(safe-area-inset-right))',
  bottom: 'max(22px, env(safe-area-inset-bottom))',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 10,
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
const secWrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'nowrap',
  gap: 10,
  justifyContent: 'flex-end',
  alignItems: 'center',
  pointerEvents: 'none',
}
const secBtn: CSSProperties = {
  pointerEvents: 'auto',
  touchAction: 'none',
  width: 50, height: 50, borderRadius: '50%',
  border: '2px solid',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  font: '700 9px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.02em', textAlign: 'center', userSelect: 'none', WebkitUserSelect: 'none',
}
const primaryBtn: CSSProperties = {
  pointerEvents: 'auto',
  touchAction: 'none',
  width: 84, height: 84, borderRadius: '50%',
  border: '3px solid',
  background: 'rgba(8,12,24,0.66)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  font: '800 14px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.06em', textAlign: 'center', userSelect: 'none', WebkitUserSelect: 'none',
}
const chuteBtn: CSSProperties = {
  pointerEvents: 'auto',
  touchAction: 'none',
  width: 68, height: 68, borderRadius: '50%',
  border: '3px solid',
  background: 'rgba(8,12,24,0.66)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  font: '800 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.06em', textAlign: 'center', userSelect: 'none', WebkitUserSelect: 'none',
}
