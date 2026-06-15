import { useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import type { GameAction, GameControls } from '../game/types'

const JOY_R = 54

interface BtnDef {
  label: string
  action: GameAction
  type: 'hold' | 'tap' | 'sprint'
  color: string
}
const BUTTONS: BtnDef[] = [
  { label: 'JET', action: 'jet', type: 'hold', color: '#27e7ff' },
  { label: 'BOOST', action: 'boost', type: 'hold', color: '#ff8a1e' },
  { label: 'SPR', action: 'sprint', type: 'sprint', color: '#9bff4d' },
  { label: 'NET', action: 'net', type: 'tap', color: '#9bff4d' },
  { label: 'G', action: 'enter', type: 'tap', color: '#27e7ff' },
  { label: 'MRPH', action: 'morph', type: 'tap', color: '#8a5cff' },
  { label: 'CHUTE', action: 'chute', type: 'tap', color: '#ff2bd0' },
]

/**
 * Touch controls: a left thumb-stick for movement, a right-side drag area for
 * the camera, and a compact action cluster bottom-right. Multitouch is handled
 * with pointer capture so move + look + buttons all work at once, and the play
 * area in the middle stays clear.
 */
export function MobileControls({ controls }: { controls: GameControls }) {
  const [knob, setKnob] = useState({ x: 0, y: 0 })
  const [sprintOn, setSprintOn] = useState(false)
  const joyId = useRef<number | null>(null)
  const joyOrigin = useRef({ x: 0, y: 0 })
  const lookId = useRef<number | null>(null)
  const lookLast = useRef({ x: 0, y: 0 })

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

      <div
        style={joyBase}
        onPointerDown={onJoyDown}
        onPointerMove={onJoyMove}
        onPointerUp={onJoyUp}
        onPointerCancel={onJoyUp}
      >
        <div style={{ ...joyKnob, transform: `translate(${knob.x}px, ${knob.y}px)` }} />
      </div>

      <div style={btnWrap}>
        {BUTTONS.map((b) => {
          const active = b.type === 'sprint' && sprintOn
          return (
            <div
              key={b.label}
              style={{
                ...btn,
                borderColor: b.color,
                color: active ? '#05060b' : b.color,
                background: active ? b.color : 'rgba(8,12,24,0.6)',
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
  )
}

const root: CSSProperties = { position: 'absolute', inset: 0, zIndex: 8, pointerEvents: 'none', touchAction: 'none' }
const lookArea: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 0,
  width: '55%',
  height: '78%',
  pointerEvents: 'auto',
  touchAction: 'none',
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
  width: 52,
  height: 52,
  borderRadius: '50%',
  background: 'rgba(39,231,255,0.55)',
  boxShadow: '0 0 18px rgba(39,231,255,0.6)',
}
const btnWrap: CSSProperties = {
  position: 'absolute',
  right: 'max(16px, env(safe-area-inset-right))',
  bottom: 'max(20px, env(safe-area-inset-bottom))',
  width: 186,
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
  width: 54,
  height: 54,
  borderRadius: '50%',
  border: '2px solid',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  font: '700 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.04em',
  userSelect: 'none',
  WebkitUserSelect: 'none',
}
