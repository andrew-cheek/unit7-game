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
  pitch = -0.18

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
  private onPointerDown = () => {
    // Click on the canvas captures the mouse for look (desktop).
    if (!('ontouchstart' in window)) this.requestLock()
  }

  // ---- keyboard -----------------------------------------------------------
  private onKeyDown = (e: KeyboardEvent) => {
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
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return
    this.lookDX += e.movementX
    this.lookDY += e.movementY
  }

  // ---- virtual (touch) ----------------------------------------------------
  setVirtualMove(x: number, y: number) {
    this.virtualMove.set(x, y)
    this.usingVirtualMove = x !== 0 || y !== 0
  }
  setVirtualLook(dx: number, dy: number) {
    this.yaw -= dx * config.camera.touchSensitivity
    this.pitch = clamp(this.pitch - dy * config.camera.touchSensitivity, config.camera.pitchMin, config.camera.pitchMax)
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
  }
}
