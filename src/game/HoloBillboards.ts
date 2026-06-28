import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus (used as the dep contract; placement is fixed city coords). */
  focus: () => THREE.Vector3
}

interface Billboard {
  group: THREE.Group
  panel: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  frame: THREE.MeshBasicMaterial
  baseY: number
  phase: number
  spin: number // slow yaw rate
  flick: number // flicker phase offset
}

/** Deterministic PRNG so the billboard layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Earth-roam atmosphere: a handful of giant translucent holographic ad panels
 * hovering high over the neon city, each showing procedurally-drawn neon ad text.
 * They bob, slowly rotate and flicker like a hologram. Additive, no colliders,
 * way up out of reach. Tier-scaled, Earth-gated, disposed together.
 */
export class HoloBillboards implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private boards: Billboard[] = []
  private zone: Zone = 'earth'
  private t = 0

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }
  private ownT<T extends THREE.Texture>(t: T): T { this.texs.push(t); return t }

  constructor(scene: THREE.Scene, private deps: Deps) {
    void this.deps
    const low = config.tier.name === 'low'
    const n = low ? 4 : 7
    const rnd = mulberry32(91017)
    const reach = config.world.half * 0.8
    const ads: Array<{ text: string; sub: string; tint: string }> = [
      { text: 'CYBER NOODLES', sub: 'HOT // 24H', tint: '#ff4ec7' },
      { text: 'HUMANOID ROBOTS', sub: 'UNIT 7', tint: '#49e0ff' },
      { text: 'NEON CITY', sub: '>> LIVE <<', tint: '#9bff6a' },
      { text: 'MEGA CORP', sub: 'BUY • SELL', tint: '#ffd24a' },
      { text: 'SKY TRANSIT', sub: '↑ LEVEL 9', tint: '#b07cff' },
      { text: 'PLASMA BAR', sub: 'OPEN ◆', tint: '#ff6a4a' },
      { text: 'DATA HAVEN', sub: '█▒░ SECURE', tint: '#4affd0' },
    ]

    // Aspect: wide ad panels. Shared geometries, scaled per board.
    const panelGeo = this.ownG(new THREE.PlaneGeometry(16, 9))
    const frameGeo = this.ownG(new THREE.PlaneGeometry(16.8, 9.8))

    for (let i = 0; i < n; i++) {
      const ad = ads[i % ads.length]
      const tex = this.ownT(this.drawAd(ad.text, ad.sub, ad.tint))
      const mat = this.own(new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      }))
      const frame = this.own(new THREE.MeshBasicMaterial({
        color: new THREE.Color(ad.tint), transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      }))

      const group = new THREE.Group()
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const baseY = 25 + rnd() * 30 // y ~ 25..55
      const scale = 1 + rnd() * 0.8
      group.position.set(x, baseY, z)
      group.rotation.y = rnd() * Math.PI * 2
      group.scale.setScalar(scale)

      // Glowing frame sits just behind the panel for a "screen edge" look.
      const frameMesh = new THREE.Mesh(frameGeo, frame)
      frameMesh.position.z = -0.05
      group.add(frameMesh)
      const panel = new THREE.Mesh(panelGeo, mat)
      group.add(panel)

      this.group.add(group)
      this.boards.push({
        group, panel, mat, frame, baseY,
        phase: rnd() * 6.28,
        spin: (0.04 + rnd() * 0.06) * (rnd() < 0.5 ? -1 : 1),
        flick: rnd() * 6.28,
      })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  /** Draw a neon ad to a canvas ONCE; returns a CanvasTexture. */
  private drawAd(text: string, sub: string, tint: string): THREE.CanvasTexture {
    const w = 512, h = 288
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    const ctx = cv.getContext('2d')!
    // Dark, mostly-transparent backdrop so the additive material reads as glow.
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(6,10,22,0.55)'
    ctx.fillRect(0, 0, w, h)

    // Inner neon border.
    ctx.strokeStyle = tint
    ctx.shadowColor = tint
    ctx.shadowBlur = 18
    ctx.lineWidth = 4
    ctx.strokeRect(14, 14, w - 28, h - 28)

    // Scanline glyph row near the top for a "graphic" feel.
    ctx.shadowBlur = 10
    ctx.fillStyle = tint
    for (let gx = 40; gx < w - 40; gx += 26) {
      const gh = 4 + ((gx * 7) % 14)
      ctx.globalAlpha = 0.35
      ctx.fillRect(gx, 44, 14, gh)
    }
    ctx.globalAlpha = 1

    // Headline.
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowBlur = 26
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 56px sans-serif'
    ctx.fillText(text, w / 2, h / 2 - 6, w - 56)
    // Tinted glow pass over the same text.
    ctx.shadowBlur = 34
    ctx.fillStyle = tint
    ctx.globalAlpha = 0.7
    ctx.fillText(text, w / 2, h / 2 - 6, w - 56)
    ctx.globalAlpha = 1

    // Subline.
    ctx.shadowBlur = 16
    ctx.fillStyle = tint
    ctx.font = 'bold 30px sans-serif'
    ctx.fillText(sub, w / 2, h / 2 + 56, w - 80)

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
    for (const b of this.boards) {
      // Gentle bob + slow yaw so the holograms turn to face around the city.
      b.group.position.y = b.baseY + Math.sin(this.t * 0.5 + b.phase) * 1.6
      b.group.rotation.y += b.spin * dt
      // Cheap hologram flicker: a fast jitter ridden on a slow base, clamped bright.
      const fl = 0.62 + 0.08 * Math.sin(this.t * 12 + b.flick) + 0.06 * Math.sin(this.t * 2.3 + b.flick * 1.7)
      b.mat.opacity = fl
      b.frame.opacity = 0.18 + 0.08 * (0.5 + 0.5 * Math.sin(this.t * 3 + b.flick))
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.texs) t.dispose()
  }
}
