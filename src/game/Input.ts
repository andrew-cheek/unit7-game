import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { config } from './config'
import { clamp } from './utils'
import type { GameAction } from './types'

// Codes we swallow so the page never scrolls / loses focus mid-game (esp. Space).
const GAME_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'Space',
  'KeyJ', 'KeyH', 'KeyG', 'KeyF', 'KeyT', 'KeyO',
])

const HELD: GameAction[] = ['sprint', 'jet', 'boost']

/**
 * One place that turns keyboard, pointer-lock mouse and touch into a clean
 * per-frame intent: an analog move vector, absolute camera yaw/pitch, plus
 * held/edge action flags. PointerLockControls manages the desktop lock lifecycle
 * (a throwaway proxy is rotated; we read raw movementX/Y ourselves for the
 * third-person orbit). Everything is removed in dispose().
 */
export class Input {
  // Camera-relative analog move intent, components in [-1, 1].
  moveX = 0 // strafe (+right)
  moveY = 0 // forward (+forward)
  // Absolute orbit angles - the single source of truth for look direction.
  yaw = 0
  pitch = config.camera.startPitch

  held: Record<GameAction, boolean> = {
    sprint: false, jet: false, net: false, enter: false, boost: false, morph: false, chute: false,
  }
  locked = false
  pausePressed = false

  onUnlock: (() => void) | null = null

  private dom: HTMLElement
  private plc: PointerLockControls
  private keys = new Set<string>()
  private edges = new Set<GameAction>()
  private lookDX = 0
  private lookDY = 0
  private virtualMove = new THREE.Vector2(0, 0)
  private usingVirtualMove = false
  private lockEnabled = true
  private lastLookMs = -1e9
  // Drag-look fallback: when pointer lock is unavailable (sandboxed iframe /
  // embedded contexts, where requestPointerLock is rejected) the player can
  // still look by holding the mouse button and dragging on the canvas.
  private dragging = false
  private dragLastX = 0
  private dragLastY = 0

  constructor(dom: HTMLElement) {
    this.dom = dom
    // First arg is a throwaway object; PLC only manages the lock for us.
    this.plc = new PointerLockControls(new THREE.Object3D() as unknown as THREE.Camera, dom)
    this.plc.addEventListener('lock', this.onLock)
    this.plc.addEventListener('unlock', this.onUnlockEvent)

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('mousemove', this.onMouseMove)
    dom.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
  }

  // ---- lifecycle ----------------------------------------------------------
  setLockEnabled(v: boolean) {
    this.lockEnabled = v
  }
  requestLock() {
    if (this.lockEnabled && !this.locked) {
      try {
        this.plc.lock()
      } catch {
        /* lock can throw if not user-gesture; ignored */
      }
    }
  }
  exitLock() {
    if (this.locked) this.plc.unlock()
  }

  private onLock = () => {
    this.locked = true
  }
  private onUnlockEvent = () => {
    this.locked = false
    this.onUnlock?.()
  }
  private onPointerDown = (e: PointerEvent) => {
    if ('ontouchstart' in window) return // touch devices use MobileControls
    // Click on the canvas captures the mouse for look (desktop). If pointer lock
    // is rejected (iframe/embed), the drag below still drives look while held.
    this.requestLock()
    this.dragging = true
    this.dragLastX = e.clientX
    this.dragLastY = e.clientY
  }
  private onPointerUp = () => {
    this.dragging = false
  }

  // ---- keyboard -----------------------------------------------------------
  // True when the event is going to a text field (e.g. the multiplayer username
  // box). We must NOT preventDefault or capture game keys then, or letters like
  // W/A/S/D/F/G and Space never reach the input.
  private isEditableTarget(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null
    if (!t) return false
    const tag = t.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.isEditableTarget(e)) return
    if (GAME_CODES.has(e.code)) e.preventDefault()
    if (e.repeat) return
    this.keys.add(e.code)

    switch (e.code) {
      case 'ShiftLeft':
      case 'ShiftRight':
        this.held.sprint = true
        break
      case 'Space':
      case 'KeyJ':
        this.held.jet = true
        break
      case 'KeyF':
        this.held.boost = true
        break
      case 'KeyH':
        this.edges.add('net')
        break
      case 'KeyG':
        this.edges.add('enter')
        break
      case 'KeyT':
        this.edges.add('morph')
        break
      case 'KeyO':
        this.edges.add('chute')
        break
      case 'Escape':
        this.pausePressed = true
        break
    }
  }

  private onKeyUp = (e: KeyboardEvent) => {
    if (this.isEditableTarget(e)) return
    if (GAME_CODES.has(e.code)) e.preventDefault()
    this.keys.delete(e.code)
    switch (e.code) {
      case 'ShiftLeft':
      case 'ShiftRight':
        this.held.sprint = false
        break
      case 'Space':
      case 'KeyJ':
        this.held.jet = false
        break
      case 'KeyF':
        this.held.boost = false
        break
    }
  }

  private onBlur = () => {
    this.keys.clear()
    this.held.sprint = this.held.jet = this.held.boost = false
    // Also drop queued one-shot edges, else a net/enter/morph/chute fires on refocus.
    this.edges.clear()
  }

  private onMouseMove = (e: MouseEvent) => {
    if (this.locked) {
      this.lookDX += e.movementX
      this.lookDY += e.movementY
      return
    }
    // Pointer lock unavailable: drag-look from raw client deltas while held.
    if (this.dragging) {
      this.lookDX += e.clientX - this.dragLastX
      this.lookDY += e.clientY - this.dragLastY
      this.dragLastX = e.clientX
      this.dragLastY = e.clientY
    }
  }

  // ---- virtual (touch) ----------------------------------------------------
  setVirtualMove(x: number, y: number) {
    this.virtualMove.set(x, y)
    this.usingVirtualMove = x !== 0 || y !== 0
  }
  setVirtualLook(dx: number, dy: number) {
    if (dx !== 0 || dy !== 0) this.lastLookMs = performance.now()
    this.yaw -= dx * config.camera.touchSensitivity
    this.pitch = clamp(this.pitch - dy * config.camera.touchSensitivity, config.camera.pitchMin, config.camera.pitchMax)
  }

  /** Seconds since the player last actively moved the camera (mouse / touch). */
  get sinceLook() {
    return (performance.now() - this.lastLookMs) / 1000
  }
  pressAction(action: GameAction, down: boolean) {
    if (HELD.includes(action)) {
      this.held[action] = down
    } else if (down) {
      this.edges.add(action)
    }
  }

  // ---- per-frame ----------------------------------------------------------
  /** Resolve keys + accumulated mouse-look into move intent and yaw/pitch. */
  update() {
    // Apply mouse-look deltas captured since last frame.
    if (this.lookDX !== 0 || this.lookDY !== 0) {
      this.lastLookMs = performance.now()
      this.yaw -= this.lookDX * config.camera.mouseSensitivity
      this.pitch = clamp(
        this.pitch - this.lookDY * config.camera.mouseSensitivity,
        config.camera.pitchMin,
        config.camera.pitchMax,
      )
      this.lookDX = 0
      this.lookDY = 0
    }

    if (this.usingVirtualMove) {
      this.moveX = this.virtualMove.x
      this.moveY = this.virtualMove.y
    } else {
      let x = 0
      let y = 0
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1
      // Normalize diagonals so they aren't faster.
      const len = Math.hypot(x, y)
      if (len > 1) {
        x /= len
        y /= len
      }
      this.moveX = x
      this.moveY = y
    }
  }

  consumeEdge(action: GameAction): boolean {
    if (this.edges.has(action)) {
      this.edges.delete(action)
      return true
    }
    return false
  }
  consumePause(): boolean {
    if (this.pausePressed) {
      this.pausePressed = false
      return true
    }
    return false
  }

  dispose() {
    this.plc.removeEventListener('lock', this.onLock)
    this.plc.removeEventListener('unlock', this.onUnlockEvent)
    this.plc.dispose()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('mousemove', this.onMouseMove)
    this.dom.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
  }
}
