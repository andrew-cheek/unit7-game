import * as THREE from 'three'
import type { MinigameKind } from './types'

/**
 * Arcade cabinet proximity + the "conveyed in" transport beam. Extracted from
 * Game.ts (a ~2,100-line god object).
 *
 * This owns only the mechanism: detect when the player stands on a cabinet pad,
 * play the short beam beat, and then fire `onEnter`. The actual minigame entry
 * (pausing the engine, hiding the player, rewards, HUD) is intrinsic Game
 * orchestration and stays in Game, invoked via the callback. Beam geometry +
 * material are pushed into Game's dispose arrays so teardown is unchanged.
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
  private sinkGeos: THREE.BufferGeometry[]
  private sinkMats: THREE.Material[]
  private pending: { kind: MinigameKind; pos: THREE.Vector3; t: number; beam: THREE.Mesh } | null = null

  constructor(scene: THREE.Scene, sinkGeos: THREE.BufferGeometry[], sinkMats: THREE.Material[]) {
    this.scene = scene
    this.sinkGeos = sinkGeos
    this.sinkMats = sinkMats
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
    const geo = new THREE.CylinderGeometry(1.5, 1.5, 16, 20, 1, true)
    this.sinkGeos.push(geo)
    const mat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    this.sinkMats.push(mat)
    const beam = new THREE.Mesh(geo, mat)
    beam.position.set(pos.x, pos.y + 8, pos.z)
    beam.renderOrder = 5
    this.scene.add(beam)
    ctx.onSfx()
    this.pending = { kind, pos: pos.clone(), t: 0, beam }
  }

  private advance(dt: number, ctx: ArcadeContext) {
    const e = this.pending!
    e.t += dt
    const k = Math.min(1, e.t / BEAT)
    const mat = e.beam.material as THREE.MeshBasicMaterial
    mat.opacity = Math.sin(k * Math.PI) * 0.7 // fade in then out
    e.beam.scale.set(1 + k * 0.6, 1, 1 + k * 0.6)
    e.beam.rotation.y += dt * 6
    if (e.t >= BEAT) {
      this.scene.remove(e.beam)
      this.pending = null
      ctx.onEnter(e.kind, e.pos)
    }
  }
}
