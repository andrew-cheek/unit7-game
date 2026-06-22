import * as THREE from 'three'
import { config } from './config'
import { isMech, type Vehicle } from './Vehicles'
import type { Zone } from './types'

/**
 * The one-active-at-a-time objective chain (config.missions) and its guided
 * beacon. Extracted out of Game.ts (a ~2,300-line god object).
 *
 * Game feeds it the world reads it needs each frame via MissionContext and gets
 * back the HUD label; completion side-effects (banner, audio, analytics,
 * headline) run through the `onComplete` callback so this stays free of those
 * dependencies. The system owns the beacon mesh + the chain progress.
 */
export interface MissionContext {
  zone: Zone
  playerPos: THREE.Vector3
  captured: number
  currentVehicle: Vehicle | null
  vehicles: Vehicle[]
  isUnlocked: (kind: string) => boolean
  /** Earth portals (target zone + world position), for 'zone' objectives. */
  earthPortals: { target: Zone; position: THREE.Vector3 }[]
  /** Arcade cabinet positions, for the 'minigame' objective beacon. */
  arcadePortals: { pos: THREE.Vector3 }[]
  groundY: (x: number, z: number) => number
  /** Fired once when an objective is completed (title of the finished mission). */
  onComplete: (title: string) => void
}

export class MissionSystem {
  readonly objBeacon: THREE.Group
  /** Current goal world position (for the radar guide blip). */
  objTarget: THREE.Vector3 | null = null

  private idx = 0
  private captureBase = 0
  private minigamePlayed = false
  private beaconMats: THREE.Material[] = []

  constructor() {
    this.objBeacon = this.buildBeacon()
  }

  /** Playing a cabinet completes the 'minigame' objective. */
  markMinigamePlayed() {
    this.minigamePlayed = true
  }

  /**
   * Advance the chain and refresh the beacon. Returns the HUD objective label
   * for this frame (null once the chain is finished = free roam).
   */
  update(ctx: MissionContext): string | null {
    const list = config.missions
    if (this.idx >= list.length) {
      this.objTarget = null
      this.objBeacon.visible = false
      return null
    }
    const m = list[this.idx]
    let done = false
    switch (m.type) {
      case 'reach':
        done = ctx.zone === 'earth' && Math.hypot(ctx.playerPos.x - (m.x ?? 0), ctx.playerPos.z - (m.z ?? 0)) < (m.radius ?? 8)
        break
      case 'mech':
        done = !!ctx.currentVehicle && isMech(ctx.currentVehicle.kind)
        break
      case 'zone':
        done = ctx.zone === m.zone
        break
      case 'capture':
        done = ctx.captured - this.captureBase >= (m.count ?? 1)
        break
      case 'minigame':
        done = this.minigamePlayed
        break
    }

    let label: string | null
    if (done) {
      this.idx++
      ctx.onComplete(m.title)
      const nextM = list[this.idx]
      if (nextM?.type === 'capture') this.captureBase = ctx.captured
      label = nextM?.title ?? 'Free roam: explore the world!'
    } else {
      label = m.title
    }

    // Guided beacon: a glowing column on the current goal + a distance readout.
    this.objTarget = this.computeTarget(ctx)
    if (this.objTarget && ctx.zone === 'earth') {
      const gy = ctx.groundY(this.objTarget.x, this.objTarget.z)
      this.objBeacon.position.set(this.objTarget.x, gy, this.objTarget.z)
      this.objBeacon.visible = true
      this.objBeacon.rotation.y += 0.4 * (1 / 60)
      const d = Math.round(Math.hypot(this.objTarget.x - ctx.playerPos.x, this.objTarget.z - ctx.playerPos.z))
      if (label) label = `${label} · ${d}m`
    } else {
      this.objBeacon.visible = false
    }
    return label
  }

  /** World position the current objective points at (beacon + radar). */
  private computeTarget(ctx: MissionContext): THREE.Vector3 | null {
    const m = config.missions[this.idx]
    if (!m) return null
    if (m.type === 'reach') return new THREE.Vector3(m.x ?? 0, 0, m.z ?? 0)
    if (ctx.zone !== 'earth') return null // beacons only guide within the city
    if (m.type === 'mech') {
      // Guide to the nearest mech you can actually board (free/unlocked first).
      let best: THREE.Vector3 | null = null, bd = Infinity
      for (const v of ctx.vehicles) {
        if (!isMech(v.kind) || !ctx.isUnlocked(v.kind)) continue
        const d = (v.position.x - ctx.playerPos.x) ** 2 + (v.position.z - ctx.playerPos.z) ** 2
        if (d < bd) { bd = d; best = v.position }
      }
      return best ? best.clone() : null
    }
    if (m.type === 'zone') {
      for (const p of ctx.earthPortals) if (p.target === m.zone) return p.position.clone()
      return null
    }
    if (m.type === 'minigame') {
      let best: THREE.Vector3 | null = null, bd = Infinity
      for (const p of ctx.arcadePortals) {
        const d = (p.pos.x - ctx.playerPos.x) ** 2 + (p.pos.z - ctx.playerPos.z) ** 2
        if (d < bd) { bd = d; best = p.pos }
      }
      return best ? best.clone() : null
    }
    return null // capture: no fixed beacon (aliens roam)
  }

  private buildBeacon(): THREE.Group {
    const g = new THREE.Group()
    const own = <T extends THREE.Material>(m: T) => { this.beaconMats.push(m); return m }
    const colMat = own(new THREE.MeshBasicMaterial({ color: 0x9bff4d, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.4, 60, 12, 1, true), colMat)
    col.position.y = 30
    g.add(col)
    const ringMat = own(new THREE.MeshBasicMaterial({ color: 0x9bff4d, transparent: true, opacity: 0.8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.4, 3.2, 28), ringMat)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.4
    g.add(ring)
    g.visible = false
    return g
  }

  dispose() {
    this.beaconMats.forEach((m) => m.dispose())
  }
}
