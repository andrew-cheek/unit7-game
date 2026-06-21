// The server-authoritative alien swarm for multiplayer: everyone sees and
// fights the SAME aliens. The server owns their positions (relayed ~6Hz here)
// and decides who captures each one (first claim wins). This manager just
// renders + interpolates them and helps the capture code find a claimable
// target. Earth-only, like the single-player invasion.

import * as THREE from 'three'
import { createAlien, type CharacterModel } from './procedural'
import type { AlienTuple } from './Net'

interface Shared {
  model: CharacterModel
  group: THREE.Group
  pos: THREE.Vector3
  target: THREE.Vector3
  big: boolean
  bob: number
}

export class SharedAliens {
  private scene: THREE.Scene
  private aliens = new Map<number, Shared>()
  private visible = true

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  get count(): number {
    return this.aliens.size
  }

  setVisible(v: boolean) {
    if (v === this.visible) return
    this.visible = v
    for (const a of this.aliens.values()) a.group.visible = v
  }

  /** Reconcile to the server's latest full list: add new, move existing, drop gone. */
  sync(list: AlienTuple[]) {
    const seen = new Set<number>()
    for (const [id, x, y, z, big] of list) {
      seen.add(id)
      const a = this.aliens.get(id)
      if (a) {
        a.target.set(x, y, z)
      } else {
        this.add(id, x, y, z, big === 1)
      }
    }
    // Anything no longer in the list was captured/removed server-side.
    for (const id of [...this.aliens.keys()]) if (!seen.has(id)) this.remove(id)
  }

  private add(id: number, x: number, y: number, z: number, big: boolean) {
    const model = createAlien({ big, color: big ? 0x9b6cff : 0x3ba86a, eye: 0xff2bd0 })
    const group = new THREE.Group()
    group.add(model.group)
    group.position.set(x, y, z)
    group.visible = this.visible
    this.scene.add(group)
    this.aliens.set(id, { model, group, pos: new THREE.Vector3(x, y, z), target: new THREE.Vector3(x, y, z), big, bob: Math.random() * Math.PI * 2 })
  }

  remove(id: number) {
    const a = this.aliens.get(id)
    if (!a) return
    this.scene.remove(a.group)
    a.model.dispose()
    this.aliens.delete(id)
  }

  /** Position of an alien (for capture FX on removal), or null if unknown. */
  positionOf(id: number): THREE.Vector3 | null {
    return this.aliens.get(id)?.pos.clone() ?? null
  }

  /**
   * Nearest claimable alien inside a forward cone, matching the net's reach.
   * Returns its id + position, or null.
   */
  nearestClaimable(sx: number, sz: number, fwdX: number, fwdZ: number, range: number, cosCone: number): { id: number; pos: THREE.Vector3 } | null {
    let bestId = -1
    let bestD = range
    let bestPos: THREE.Vector3 | null = null
    for (const [id, a] of this.aliens) {
      const dx = a.pos.x - sx
      const dz = a.pos.z - sz
      const d = Math.hypot(dx, dz)
      if (d > range || d < 0.001) continue
      if ((dx * fwdX + dz * fwdZ) / d < cosCone) continue
      if (d < bestD) {
        bestD = d
        bestId = id
        bestPos = a.pos
      }
    }
    return bestId >= 0 && bestPos ? { id: bestId, pos: bestPos.clone() } : null
  }

  update(dt: number) {
    if (!this.visible) return
    const k = 1 - Math.exp(-dt * 10)
    for (const a of this.aliens.values()) {
      a.pos.lerp(a.target, k)
      a.bob += dt * 2
      a.group.position.set(a.pos.x, a.pos.y + Math.sin(a.bob) * 0.15, a.pos.z)
      // Face travel direction (toward the interpolation target).
      const dx = a.target.x - a.pos.x
      const dz = a.target.z - a.pos.z
      if (dx * dx + dz * dz > 1e-4) a.model.group.rotation.y = Math.atan2(dx, dz)
      a.model.update(dt, 0.6, true)
    }
  }

  dispose() {
    for (const id of [...this.aliens.keys()]) this.remove(id)
  }
}
