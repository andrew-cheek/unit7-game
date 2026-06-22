// WorldEventSystem — lightweight, purely-visual ambient events that fire on a
// timer so each zone feels alive and surprising: ship flyovers, drone swarms,
// cargo drops, meteor showers, Mars dust bursts, Moon satellite passes.
//
// Everything is cheap: a handful of additive, fog-immune meshes per event that
// animate themselves and auto-expire. Element counts and the spawn interval
// scale with the quality tier (config.tier.fxScale), so mobile gets fewer,
// rarer events. Effects are created near the player and fully disposed when
// they finish, so there is no growing allocation.

import * as THREE from 'three'
import { config } from './config'
import type { Zone } from './types'

interface Effect {
  group: THREE.Group
  /** Advance; return true when finished. */
  update(dt: number): boolean
  dispose(): void
}

type EventName = 'ship' | 'drones' | 'cargo' | 'meteors' | 'dust' | 'satellite'

const POOL: Record<Zone, EventName[]> = {
  earth: ['ship', 'drones', 'cargo', 'meteors'],
  mars: ['meteors', 'dust', 'ship'],
  moon: ['satellite', 'cargo', 'meteors'],
}

export class WorldEvents {
  private scene: THREE.Scene
  private active: Effect[] = []
  private zone: Zone = 'earth'
  private focus = new THREE.Vector3()
  private timer: number
  /** Optional hook so the HUD can flash a tiny banner when an event fires. */
  onEvent?: (label: string) => void

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.timer = this.nextInterval() * 0.65 // first event slightly sooner, but not a front-loaded dump
  }

  private get fx(): number {
    return config.tier.fxScale
  }

  private nextInterval(): number {
    const base = 22 / Math.max(0.3, this.fx) // high ~22s, medium ~31s, low ~55s
    return base + Math.random() * base * 0.6
  }

  setZone(zone: Zone) {
    if (zone === this.zone) return
    this.zone = zone
    // Don't leave an Earth ship hanging over Mars; clear in-flight effects.
    for (const e of this.active) {
      this.scene.remove(e.group)
      e.dispose()
    }
    this.active = []
    this.timer = this.nextInterval() * 0.5
  }

  update(dt: number, focus: THREE.Vector3) {
    this.focus.copy(focus)
    this.timer -= dt
    const cap = Math.ceil(2 * this.fx) // fewer concurrent events (was +1): high 2, med 2, low 1
    if (this.timer <= 0 && this.active.length < cap) {
      this.spawn()
      this.timer = this.nextInterval()
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].update(dt)) {
        this.scene.remove(this.active[i].group)
        this.active[i].dispose()
        this.active.splice(i, 1)
      }
    }
  }

  private spawn() {
    const pool = POOL[this.zone]
    const name = pool[Math.floor(Math.random() * pool.length)]
    let fx: Effect
    let label: string
    switch (name) {
      case 'ship': fx = this.makeShip(); label = 'SHIP SIGHTED'; break
      case 'drones': fx = this.makeDroneSwarm(); label = 'DRONE SWARM'; break
      case 'cargo': fx = this.makeCargoDrop(); label = 'CARGO DROP'; break
      case 'dust': fx = this.makeDustBurst(); label = 'DUST STORM'; break
      case 'satellite': fx = this.makeSatellite(); label = 'SATELLITE PASS'; break
      case 'meteors':
      default: fx = this.makeMeteors(); label = 'METEOR SHOWER'; break
    }
    this.scene.add(fx.group)
    this.onEvent?.(label)
  }

  // --- effect builders -------------------------------------------------------

  /** A bright capital ship crossing the sky with an engine trail. */
  private makeShip(): Effect {
    const group = new THREE.Group()
    const color = 0x9fe8ff
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0x1a2740, fog: false })
    const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const trailMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const hull = new THREE.Mesh(new THREE.CapsuleGeometry(2.2, 10, 6, 12), bodyMat)
    hull.rotation.z = Math.PI / 2
    group.add(hull)
    const fin = new THREE.Mesh(new THREE.BoxGeometry(5, 0.4, 7), bodyMat)
    fin.position.x = -3
    group.add(fin)
    for (const sx of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), glowMat)
      lamp.position.set(5, 0, sx * 1.4)
      group.add(lamp)
    }
    const trail = new THREE.Mesh(new THREE.ConeGeometry(1.6, 22, 12, 1, true), trailMat)
    trail.rotation.z = Math.PI / 2
    trail.position.x = -16
    group.add(trail)

    const y = this.focus.y + 70 + Math.random() * 50
    const side = Math.random() < 0.5 ? 1 : -1
    const from = new THREE.Vector3(this.focus.x - side * 360, y, this.focus.z + (Math.random() * 200 - 100))
    const to = new THREE.Vector3(this.focus.x + side * 360, y, from.z + (Math.random() * 80 - 40))
    group.position.copy(from)
    group.lookAt(to)
    let t = 0
    const dur = 9
    return {
      group,
      update: (dt) => {
        t += dt
        group.position.lerpVectors(from, to, t / dur)
        return t >= dur
      },
      dispose: () => disposeGroup(group),
    }
  }

  /** A loose cluster of glowing drones sweeping past at mid height. */
  private makeDroneSwarm(): Effect {
    const group = new THREE.Group()
    const n = Math.round(10 * this.fx) + 4
    const mat = new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const geo = new THREE.SphereGeometry(0.45, 8, 6)
    const nodes: { m: THREE.Mesh; ox: number; oy: number; oz: number; ph: number }[] = []
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, mat)
      const ox = (Math.random() * 2 - 1) * 8
      const oy = (Math.random() * 2 - 1) * 5
      const oz = (Math.random() * 2 - 1) * 8
      m.position.set(ox, oy, oz)
      group.add(m)
      nodes.push({ m, ox, oy, oz, ph: Math.random() * 6.28 })
    }
    const y = this.focus.y + 28 + Math.random() * 24
    const side = Math.random() < 0.5 ? 1 : -1
    const from = new THREE.Vector3(this.focus.x - side * 220, y, this.focus.z - 60 + Math.random() * 120)
    const to = new THREE.Vector3(this.focus.x + side * 220, y, this.focus.z - 60 + Math.random() * 120)
    group.position.copy(from)
    let t = 0
    const dur = 8
    return {
      group,
      update: (dt) => {
        t += dt
        group.position.lerpVectors(from, to, t / dur)
        for (const nd of nodes) {
          nd.m.position.set(nd.ox + Math.sin(t * 2 + nd.ph) * 1.5, nd.oy + Math.cos(t * 2.4 + nd.ph) * 1.2, nd.oz)
        }
        return t >= dur
      },
      dispose: () => disposeGroup(group),
    }
  }

  /** A lit cargo pod descending on a beam, landing with a pulse, then fading. */
  private makeCargoDrop(): Effect {
    const group = new THREE.Group()
    const color = 0xffb347
    const podMat = new THREE.MeshBasicMaterial({ color: 0x2a2018, fog: false })
    const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const beamMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const pod = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), podMat)
    group.add(pod)
    const halo = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.25, 8, 20), glowMat)
    halo.rotation.x = Math.PI / 2
    group.add(halo)
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 60, 16, 1, true), beamMat)
    beam.position.y = 30
    group.add(beam)
    const ox = this.focus.x + (Math.random() * 80 - 40)
    const oz = this.focus.z + (Math.random() * 80 - 40)
    const groundY = this.focus.y - 1
    group.position.set(ox, groundY + 70, oz)
    let t = 0
    const fall = 4
    const rest = 2
    return {
      group,
      update: (dt) => {
        t += dt
        if (t < fall) {
          group.position.y = groundY + 70 * (1 - t / fall) + 3
          halo.rotation.z += dt * 3
        } else {
          const k = (t - fall) / rest
          beam.scale.y = Math.max(0.001, 1 - k)
          glowMat.opacity = 1 - k
        }
        return t >= fall + rest
      },
      dispose: () => disposeGroup(group),
    }
  }

  /** A volley of glowing meteors streaking across the sky. */
  private makeMeteors(): Effect {
    const group = new THREE.Group()
    const n = Math.round(6 * this.fx) + 3
    const geo = new THREE.ConeGeometry(0.5, 9, 8)
    const items: { m: THREE.Mesh; vel: THREE.Vector3; mat: THREE.MeshBasicMaterial; delay: number; life: number }[] = []
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
      const m = new THREE.Mesh(geo, mat)
      const start = new THREE.Vector3(this.focus.x + (Math.random() * 300 - 150), this.focus.y + 140 + Math.random() * 40, this.focus.z + (Math.random() * 300 - 150))
      m.position.copy(start)
      const vel = new THREE.Vector3(-30 - Math.random() * 30, -55 - Math.random() * 25, -10 + Math.random() * 20)
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), vel.clone().normalize())
      group.add(m)
      items.push({ m, vel, mat, delay: Math.random() * 2.5, life: 0 })
    }
    let t = 0
    const dur = 5
    return {
      group,
      update: (dt) => {
        t += dt
        for (const it of items) {
          if (t < it.delay) continue
          it.life += dt
          it.m.position.addScaledVector(it.vel, dt)
          it.mat.opacity = Math.min(1, it.life * 3) * Math.max(0, 1 - it.life / 2.2)
        }
        return t >= dur
      },
      dispose: () => disposeGroup(group),
    }
  }

  /** Mars: an expanding translucent dust dome rolling up near the horizon. */
  private makeDustBurst(): Effect {
    const group = new THREE.Group()
    const mat = new THREE.MeshBasicMaterial({ color: 0xc46a32, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false, fog: false })
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat)
    group.add(dome)
    const ang = Math.random() * Math.PI * 2
    group.position.set(this.focus.x + Math.cos(ang) * 90, this.focus.y - 2, this.focus.z + Math.sin(ang) * 90)
    let t = 0
    const dur = 5
    return {
      group,
      update: (dt) => {
        t += dt
        const k = t / dur
        const s = 6 + k * 60
        dome.scale.set(s, s * 0.6, s)
        mat.opacity = Math.sin(k * Math.PI) * 0.35
        return t >= dur
      },
      dispose: () => disposeGroup(group),
    }
  }

  /** Moon: a single bright satellite arcing across the black sky. */
  private makeSatellite(): Effect {
    const group = new THREE.Group()
    const color = 0xbfe6ff
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), mat)
    group.add(dot)
    const panel = new THREE.Mesh(new THREE.BoxGeometry(4, 0.1, 1.4), new THREE.MeshBasicMaterial({ color: 0x3a6ea5, fog: false }))
    group.add(panel)
    const y = this.focus.y + 120
    const side = Math.random() < 0.5 ? 1 : -1
    const from = new THREE.Vector3(this.focus.x - side * 320, y, this.focus.z - 120)
    const to = new THREE.Vector3(this.focus.x + side * 320, y + 30, this.focus.z + 160)
    group.position.copy(from)
    let t = 0
    const dur = 8
    return {
      group,
      update: (dt) => {
        t += dt
        group.position.lerpVectors(from, to, t / dur)
        group.rotation.y += dt * 0.5
        return t >= dur
      },
      dispose: () => disposeGroup(group),
    }
  }

  dispose() {
    for (const e of this.active) {
      this.scene.remove(e.group)
      e.dispose()
    }
    this.active = []
  }
}

function disposeGroup(group: THREE.Group) {
  const geos = new Set<THREE.BufferGeometry>()
  const mats = new Set<THREE.Material>()
  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) geos.add(m.geometry)
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mats.add(mm))
  })
  geos.forEach((g) => g.dispose())
  mats.forEach((m) => m.dispose())
}
