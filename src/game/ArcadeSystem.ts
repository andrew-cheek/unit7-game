import * as THREE from 'three'
import type { MinigameKind } from './types'

/**
 * Arcade cabinet proximity + the "conveyed in" transport beam. Extracted from
 * Game.ts (a ~2,100-line god object).
 *
 * This owns only the mechanism: detect when the player stands on a cabinet pad,
 * play the short beam beat, and then fire `onEnter`. The actual minigame entry
 * (pausing the engine, hiding the player, rewards, HUD) is intrinsic Game
 * orchestration and stays in Game, invoked via the callback. The transport beam
 * is a single pooled mesh (geo+mat owned here, freed in dispose()), reused on
 * every trigger like Missiles' ring pool — not re-allocated per entry.
 */
export interface ArcadeCabinetRef {
  kind: MinigameKind
  pos: THREE.Vector3
}

export interface ArcadeContext {
  /** True only when a new transport may start (on Earth, not transitioning, not
   *  already in/cooling-down from a minigame, and on foot). */
  canTrigger: boolean
  playerPos: THREE.Vector3
  portals: ArcadeCabinetRef[]
  /** Fired when the beam beat completes — Game enters the minigame. */
  onEnter: (kind: MinigameKind, pos: THREE.Vector3) => void
  /** Fired when a transport beam starts (Game plays the SFX). */
  onSfx: () => void
}

const BEAT = 0.7

export class ArcadeSystem {
  private scene: THREE.Scene
  // One reusable transport beam. geo+mat owned here and disposed in dispose();
  // reused per trigger (toggle visibility/opacity) instead of allocating each time.
  private beamGeo = new THREE.CylinderGeometry(1.5, 1.5, 16, 20, 1, true)
  private beamMat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
  private beam: THREE.Mesh
  private pending: { kind: MinigameKind; pos: THREE.Vector3; t: number } | null = null

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.beam = new THREE.Mesh(this.beamGeo, this.beamMat)
    this.beam.renderOrder = 5
    this.beam.visible = false
    this.scene.add(this.beam)
  }

  /** A transport is mid-beat (blocks re-triggering / other gameplay checks). */
  get busy() {
    return this.pending !== null
  }

  update(dt: number, ctx: ArcadeContext) {
    if (this.pending) {
      this.advance(dt, ctx)
      return
    }
    if (!ctx.canTrigger) return
    // p.pos is the stand-here pad in front of each arcade door; trigger on it.
    for (const p of ctx.portals) {
      const dx = ctx.playerPos.x - p.pos.x
      const dz = ctx.playerPos.z - p.pos.z
      if (dx * dx + dz * dz < 2.0 * 2.0) {
        this.start(p.pos, p.kind, ctx)
        return
      }
    }
  }

  private start(pos: THREE.Vector3, kind: MinigameKind, ctx: ArcadeContext) {
    this.beam.position.set(pos.x, pos.y + 8, pos.z)
    this.beam.scale.set(1, 1, 1)
    this.beam.rotation.y = 0
    this.beamMat.opacity = 0
    this.beam.visible = true
    ctx.onSfx()
    this.pending = { kind, pos: pos.clone(), t: 0 }
  }

  private advance(dt: number, ctx: ArcadeContext) {
    const e = this.pending!
    e.t += dt
    const k = Math.min(1, e.t / BEAT)
    this.beamMat.opacity = Math.sin(k * Math.PI) * 0.7 // fade in then out
    this.beam.scale.set(1 + k * 0.6, 1, 1 + k * 0.6)
    this.beam.rotation.y += dt * 6
    if (e.t >= BEAT) {
      this.beam.visible = false
      this.pending = null
      ctx.onEnter(e.kind, e.pos)
    }
  }

  /** Free the pooled beam (geo+mat). Wired into Game.dispose at teardown. */
  dispose() {
    this.scene.remove(this.beam)
    this.beamGeo.dispose()
    this.beamMat.dispose()
  }
}
