import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so the blimps roam the sky loosely around wherever you are. */
  focus: () => THREE.Vector3
}

interface Blimp {
  group: THREE.Group
  dots: THREE.InstancedMesh
  dotMat: THREE.MeshBasicMaterial
  dir: THREE.Vector2 // travel direction (unit)
  lane: number // perpendicular lane offset from focus
  along: number // signed distance travelled along the lane axis
  height: number
  speed: number
  phase: number
}

/**
 * Earth-roam city flavor: a couple of big slow advertising airships that drift
 * across the sky over the neon city, each with a glowing side billboard (a
 * procedurally-drawn neon ad) and a row of twinkling marquee lights. Large
 * moving vehicles - additive glow, no colliders, high up. Earth-gated, pooled.
 */
export class AdBlimps implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private blimps: Blimp[] = []
  private zone: Zone = 'earth'
  private t = 0

  // Scratch reused every frame; no per-frame heap allocation.
  private _scratch = new THREE.Object3D()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }
  private ownT<T extends THREE.Texture>(t: T): T { this.texs.push(t); return t }

  constructor(scene: THREE.Scene, private deps: Deps) {
    void this.deps
    const low = config.tier.name === 'low'
    const count = low ? 2 : 3
    const ads: Array<{ text: string; tint: string }> = [
      { text: 'MEGA CORP', tint: '#ffd24a' },
      { text: 'NEON CITY', tint: '#49e0ff' },
      { text: 'UNIT 7', tint: '#ff4ec7' },
    ]

    // SHARED geometries across all blimps (hull / fin / gondola / billboard / dot).
    const hullGeo = this.ownG(new THREE.SphereGeometry(6, 16, 12))
    const finGeo = this.ownG(new THREE.PlaneGeometry(7, 5))
    const gondolaGeo = this.ownG(new THREE.BoxGeometry(5, 2, 2.4))
    const panelGeo = this.ownG(new THREE.PlaneGeometry(16, 9))
    const dotGeo = this.ownG(new THREE.CircleGeometry(0.32, 8))

    // Shared body / fin / gondola materials (per-blimp billboard texture is unique).
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x20242e, metalness: 0.7, roughness: 0.5 }))
    const finMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a2f3a, metalness: 0.6, roughness: 0.6, side: THREE.DoubleSide }))
    const gondolaMat = this.own(new THREE.MeshStandardMaterial({ color: 0x14171d, metalness: 0.5, roughness: 0.7 }))

    const half = config.world.half
    const dotN = low ? 12 : 18

    for (let i = 0; i < count; i++) {
      const ad = ads[i % ads.length]
      const group = new THREE.Group()

      // Elongated ellipsoid hull (radius-6 sphere stretched long along X).
      const hull = new THREE.Mesh(hullGeo, bodyMat)
      hull.scale.set(3.2, 1.2, 1.2)
      group.add(hull)

      // Tail fin at the back of the hull.
      const fin = new THREE.Mesh(finGeo, finMat)
      fin.position.set(-18, 4, 0)
      fin.rotation.y = Math.PI / 2
      group.add(fin)
      const finB = new THREE.Mesh(finGeo, finMat)
      finB.position.set(-18, -2, 0)
      finB.rotation.set(Math.PI / 2, 0, 0)
      group.add(finB)

      // Small gondola underneath.
      const gondola = new THREE.Mesh(gondolaGeo, gondolaMat)
      gondola.position.set(2, -7.6, 0)
      group.add(gondola)

      // Billboard panel on each side, facing +Z / -Z, showing the neon ad.
      const tex = this.ownT(this.drawAd(ad.text, ad.tint))
      const panelMat = this.own(new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      }))
      const panelR = new THREE.Mesh(panelGeo, panelMat)
      panelR.position.set(0, 0, 7.4)
      group.add(panelR)
      const panelL = new THREE.Mesh(panelGeo, panelMat)
      panelL.position.set(0, 0, -7.4)
      panelL.rotation.y = Math.PI
      group.add(panelL)

      // Row of additive marquee dots along the lower hull (instanced, twinkle).
      const dotMat = this.own(new THREE.MeshBasicMaterial({
        color: new THREE.Color(ad.tint), transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide,
      }))
      const dots = new THREE.InstancedMesh(dotGeo, dotMat, dotN)
      const sc = this._scratch
      for (let d = 0; d < dotN; d++) {
        const f = d / (dotN - 1)
        sc.position.set((f - 0.5) * 34, -7.2, 0)
        sc.rotation.set(0, 0, 0)
        sc.scale.setScalar(1)
        sc.updateMatrix()
        dots.setMatrixAt(d, sc.matrix)
      }
      dots.instanceMatrix.needsUpdate = true
      group.add(dots)

      // Lay out lanes: spread perpendicular, staggered start along the lane.
      const ang = (i / count) * Math.PI * 2
      const dir = new THREE.Vector2(Math.cos(ang), Math.sin(ang))
      this.group.add(group)
      this.blimps.push({
        group, dots, dotMat, dir,
        lane: (i - (count - 1) / 2) * half * 0.9,
        along: ((i * 0.37) % 1 - 0.5) * 2 * half * 1.3,
        height: 72 + i * 9,
        speed: 5 + i * 1.6,
        phase: i * 1.7,
      })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  /** Draw a neon ad word to a canvas ONCE; returns a CanvasTexture. */
  private drawAd(text: string, tint: string): THREE.CanvasTexture {
    const w = 512, h = 288
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(6,10,22,0.6)'
    ctx.fillRect(0, 0, w, h)

    // Neon border.
    ctx.strokeStyle = tint
    ctx.shadowColor = tint
    ctx.shadowBlur = 18
    ctx.lineWidth = 5
    ctx.strokeRect(16, 16, w - 32, h - 32)

    // Headline word, white core + tinted glow pass.
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowBlur = 28
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 72px sans-serif'
    ctx.fillText(text, w / 2, h / 2, w - 64)
    ctx.shadowBlur = 36
    ctx.fillStyle = tint
    ctx.globalAlpha = 0.7
    ctx.fillText(text, w / 2, h / 2, w - 64)
    ctx.globalAlpha = 1

    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    tex.needsUpdate = true
    return tex
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    // Drive visibility from the zone each frame so it's correct at startup too
    // (setZone only fires on a zone *change*, and you begin on Earth).
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt
    const f = this.deps.focus()
    const half = config.world.half
    const wrap = half * 1.3

    for (const b of this.blimps) {
      b.along += b.speed * dt
      // Wrap to re-enter from the opposite side once past the far edge.
      if (b.along > wrap) b.along = -wrap
      else if (b.along < -wrap) b.along = wrap

      // Position: travel axis = dir, lane offset = perpendicular, centred on focus.
      const px = -b.dir.y, pz = b.dir.x // perpendicular to dir
      const x = f.x + b.dir.x * b.along + px * b.lane
      const z = f.z + b.dir.y * b.along + pz * b.lane
      const y = b.height + Math.sin(this.t * 0.3 + b.phase) * 2.5
      b.group.position.set(x, y, z)

      // Slow yaw to face travel direction; gentle bob/roll.
      b.group.rotation.y = Math.atan2(-b.dir.y, b.dir.x)
      b.group.rotation.z = Math.sin(this.t * 0.4 + b.phase) * 0.05

      // Marquee twinkle: pulse overall dot brightness.
      b.dotMat.opacity = 0.6 + 0.35 * (0.5 + 0.5 * Math.sin(this.t * 4 + b.phase))
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.texs) t.dispose()
  }
}
