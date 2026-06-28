import * as THREE from 'three'
import { config } from './config'

export type SkyDest = 'arcade' | 'mars' | 'moon' | 'city'

interface SkyPortal {
  group: THREE.Group
  ring: THREE.Mesh
  x: number; y: number; z: number // live (animated) centre, used by the fly-through test
  bx: number; by: number; bz: number // float base
  ph: number
  dest: SkyDest
}

/**
 * Persistent floating destination portals hanging in the Earth sky above the
 * plaza: CITY / ARCADE / MARS / MOON rings stacked down the descent corridor.
 * Replaces the old scripted skydive's pads - now they live in the world, so any
 * time you're airborne (stepping off the launch pad, or jetpacking up from the
 * street) you can steer through one to travel. Fly-through detection is exposed
 * via flyThrough(); Game routes the actual zone change / landing.
 *
 * Visuals + float animation are lifted from the retired DropIn.buildPlatforms so
 * the look is unchanged; the difference is they persist and read the live player
 * position instead of the dive's own diver.
 */
export class SkyPortals {
  readonly group = new THREE.Group()
  private portals: SkyPortal[] = []
  private beamChevrons: { mesh: THREE.Mesh; base: number; top: number; speed: number }[] = []
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private t = 0
  // Per-destination cooldown so a single pass fires once, not every frame while
  // you're inside the catch volume.
  private cooldown = 0

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  /** `center` is the plaza touchdown point (ground level); portals stack above it. */
  constructor(scene: THREE.Scene, center: THREE.Vector3) {
    const C: Record<SkyDest, number> = { city: 0x27e7ff, arcade: 0xff2bd0, mars: 0xff8a1e, moon: 0xbfe6ff }
    const labels: Record<SkyDest, string> = { city: 'CITY', arcade: 'ARCADE', mars: 'MARS', moon: 'MOON' }
    // [dest, altitude above the plaza, lateral offset]. Staggered heights, sides
    // alternating left/right. The offset is kept wide enough that a dead-straight
    // fall down the middle never clips one (even allowing for the float bob + the
    // ~50m pad-edge step-off) - you reach a portal by deliberately steering out to
    // it, not by falling past it.
    const defs: Array<[SkyDest, number, number]> = [
      ['moon', 900, -96],
      ['arcade', 690, 96],
      ['mars', 470, -96],
      ['city', 280, 96],
    ]
    const chevGeo = this.ownG(new THREE.TorusGeometry(6, 0.45, 8, 26))
    for (const [dest, alt, off] of defs) {
      const col = C[dest]
      const x = center.x + off
      const y = center.y + alt
      const z = center.z
      const group = new THREE.Group()
      group.position.set(x, y, z)
      // Huge landing disk + glowing rim.
      const disk = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(30, 31, 1.4, 44)), this.own(new THREE.MeshStandardMaterial({ color: 0x0a0d16, emissive: col, emissiveIntensity: 1.8, roughness: 0.5, metalness: 0.4 })))
      group.add(disk)
      const rim = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(30, 1.3, 8, 52)), this.own(new THREE.MeshBasicMaterial({ color: col, fog: false })))
      rim.rotation.x = Math.PI / 2
      group.add(rim)
      // Big upright portal ring you fly through.
      const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(24, 2.2, 16, 52)), this.own(new THREE.MeshBasicMaterial({ color: col, fog: false })))
      ring.position.y = 20
      group.add(ring)
      const disc = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(23, 44)), this.own(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.32, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
      disc.position.y = 20
      group.add(disc)
      // A fat pillar of light spearing up into the sky from the pad, so each reads
      // as a beam coming down and is unmistakable from anywhere in the air.
      const beam = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(7, 7, 1100, 16, 1, true)), this.own(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
      beam.position.y = 520
      group.add(beam)
      // Glowing rings climbing the beam - the "this way up" playground look.
      const chevMat = this.own(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const CHEV = config.tier.name === 'low' ? 3 : 5, top = 200
      for (let c = 0; c < CHEV; c++) {
        const chev = new THREE.Mesh(chevGeo, chevMat)
        chev.rotation.x = Math.PI / 2
        chev.position.y = 20 + (c / CHEV) * top
        group.add(chev)
        this.beamChevrons.push({ mesh: chev, base: 20, top: 20 + top, speed: 26 + c * 1.5 })
      }
      // Big floating label above the ring.
      const sprite = this.labelSprite(labels[dest], col)
      sprite.position.set(0, 40, 0)
      sprite.scale.set(44, 16, 1)
      group.add(sprite)
      this.group.add(group)
      this.portals.push({ group, ring, x, y, z, bx: x, by: y, bz: z, ph: alt * 0.013, dest })
    }
    scene.add(this.group)
  }

  /** A neon text billboard sprite for the portal labels. */
  private labelSprite(text: string, color: number): THREE.Sprite {
    const cv = document.createElement('canvas')
    cv.width = 256; cv.height = 96
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, 256, 96)
    ctx.font = '800 56px ui-monospace, Menlo, monospace'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = '#' + color.toString(16).padStart(6, '0')
    ctx.shadowBlur = 18
    ctx.fillStyle = '#eaf6ff'
    ctx.fillText(text, 128, 48)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    this.texs.push(tex)
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
    this.mats.push(sprite.material)
    return sprite
  }

  setVisible(v: boolean) { this.group.visible = v }

  update(dt: number) {
    if (!this.group.visible) return
    this.t += dt
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt)
    const pt = this.t
    for (const p of this.portals) {
      p.ring.rotation.z += dt * 0.8
      p.group.rotation.y += dt * 0.25
      // Gentle bob + sway; the live x/y/z track it so the fly-through test stays true.
      p.x = p.bx + Math.cos(pt * 0.3 + p.ph) * 8
      p.y = p.by + Math.sin(pt * 0.5 + p.ph) * 7
      p.z = p.bz + Math.sin(pt * 0.27 + p.ph) * 8
      p.group.position.set(p.x, p.y, p.z)
    }
    for (const ch of this.beamChevrons) {
      let y = ch.mesh.position.y + ch.speed * dt
      if (y > ch.top) y = ch.base + (y - ch.top)
      ch.mesh.position.y = y
    }
  }

  /**
   * Did `pos` (the live player/vehicle position) just fly through a portal? Returns
   * the destination once per pass (a short cooldown debounces a single crossing),
   * else null. Caller routes the travel.
   */
  flyThrough(pos: THREE.Vector3): SkyDest | null {
    if (this.cooldown > 0 || !this.group.visible) return null
    for (const p of this.portals) {
      if (Math.abs(pos.y - p.y) > 22) continue // vertical catch window
      if (Math.hypot(pos.x - p.x, pos.z - p.z) < 26) { // ~ the ring's bore; well under the 96 lateral offset
        this.cooldown = 2
        return p.dest
      }
    }
    return null
  }

  dispose() {
    this.group.parent?.remove(this.group)
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.texs) t.dispose()
    this.geos.length = 0; this.mats.length = 0; this.texs.length = 0
    this.portals.length = 0; this.beamChevrons.length = 0
  }
}
