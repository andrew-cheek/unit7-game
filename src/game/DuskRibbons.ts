import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Where the player is looking / standing - ribbons anchor above this each frame. */
  focus: () => THREE.Vector3
  /** Day/night factor: 1 = full day (noon), 0 = night (Earth only). */
  dayFactor: () => number
  /** Current zone; ribbons only show on Earth. */
  zone: () => Zone
}

interface Ribbon {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  offX: number // horizontal offset from the focus anchor
  offY: number // height above the anchor
  offZ: number // depth behind the anchor
  drift: number // horizontal sway speed
  phase: number
  warm: THREE.Color // dawn tint (orange/pink)
  cool: THREE.Color // dusk tint (magenta)
}

/**
 * Dawn/dusk sky ribbons over the Earth city: a few very large soft additive
 * bands hung high in the sky that bloom warm (orange/pink) at sunrise and cool
 * (magenta) at sunset, then fade away at deep night and bright noon. Anchored
 * above the player's focus so they read as a distant horizon glow that follows
 * the camera rather than a fixed billboard.
 *
 * Self-contained set dressing: own gradient texture, own geometry, no colliders,
 * independent of Aurora / DawnShow / the post pipeline. Everything disposed
 * together. Additive, depthWrite:false, fog:false; big-but-few quads keep the
 * overdraw bill small. On LOW it still runs (2 ribbons, slightly smaller) - the
 * fill cost of 2 soft bands is well under the city's draw budget; if a future
 * profile shows it pinching low-tier fill-rate, drop to off here.
 *
 * Window: opacity peaks around the transition bands (dayFactor ~0.15-0.35 at
 * dawn and ~0.65-0.85 at dusk via a symmetric falloff around 0.25 and 0.75),
 * zero at deep night (<0.05) and bright midday (>0.95).
 */
export class DuskRibbons implements GameSystem {
  private group = new THREE.Group()
  private ribbons: Ribbon[] = []
  private tex: THREE.Texture
  private gradCanvas: HTMLCanvasElement | null = null // backing store for tex; released in dispose()
  private geo: THREE.PlaneGeometry
  private zone: Zone = 'earth'
  private t = 0
  private scratch = new THREE.Color()
  private scratchPos = new THREE.Vector3()

  constructor(scene: THREE.Scene, private deps: Deps) {
    this.tex = this.makeGradient()
    // Wide, soft horizontal band, gently waved so overlapping ribbons read as
    // layered cloud-light rather than flat sheets. Very wide so the glow spans
    // the visible horizon even though there are only a few.
    // LOW: shrink ~18% to trim the additive footprint; high/medium full size.
    const low = config.tier.name === 'low'
    this.geo = new THREE.PlaneGeometry(low ? 320 : 390, low ? 60 : 74, 20, 1)
    const pos = this.geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      pos.setZ(i, Math.sin(x * 0.018) * 10 + Math.sin(x * 0.045 + 1.3) * 4)
    }
    this.geo.computeVertexNormals()

    // high ~5, medium ~3, low ~2.
    const n = low ? 2 : config.tier.name === 'medium' ? 3 : 5
    for (let i = 0; i < n; i++) {
      // Warm = sunrise orange/pink; cool = sunset magenta. Vary hue slightly per
      // band so stacked ribbons read as a graded sky, not one flat wash.
      const warm = new THREE.Color().setHSL(0.06 + i * 0.012, 0.85, 0.58)
      const cool = new THREE.Color().setHSL(0.86 - i * 0.015, 0.8, 0.56)
      const mat = new THREE.MeshBasicMaterial({
        map: this.tex,
        color: warm,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(this.geo, mat)
      mesh.rotation.z = (i - (n - 1) / 2) * 0.04 // slight fan so bands aren't parallel
      this.group.add(mesh)
      this.ribbons.push({
        mesh,
        mat,
        offX: (i - (n - 1) / 2) * 30,
        offY: 175 + i * 16,
        offZ: -180 - i * 26,
        drift: 0.035 + i * 0.015,
        phase: i * 1.9,
        warm,
        cool,
      })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  /** Vertical alpha gradient: soft top, brightest mid-low, fading to nothing at the base. */
  private makeGradient(): THREE.Texture {
    const c = document.createElement('canvas')
    c.width = 4; c.height = 128
    const ctx = c.getContext('2d')!
    const g = ctx.createLinearGradient(0, 128, 0, 0)
    g.addColorStop(0, 'rgba(255,255,255,0)') // bottom edge: gone
    g.addColorStop(0.3, 'rgba(255,255,255,0.85)') // brightest band low in the strip
    g.addColorStop(0.6, 'rgba(255,255,255,0.45)')
    g.addColorStop(1, 'rgba(255,255,255,0)') // top: soft fade
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 4, 128)
    this.gradCanvas = c // keep a handle so dispose() can free the backing store
    const tex = new THREE.CanvasTexture(c)
    tex.needsUpdate = true
    return tex
  }

  setZone(zone: Zone) {
    this.zone = zone
    if (zone !== 'earth') this.group.visible = false
  }

  /**
   * Transition envelope: 0 at deep night / bright noon, peaking across the two
   * twilight bands centred on dayFactor 0.25 (dawn) and 0.75 (dusk). `dawn`
   * returns the warm/cool mix (1 = pure dawn warmth, 0 = pure dusk magenta).
   */
  private envelope(day: number): { glow: number; dawn: number } {
    // Distance to the nearer twilight centre, normalised by a half-width of 0.18.
    const dDawn = Math.abs(day - 0.25)
    const dDusk = Math.abs(day - 0.75)
    const gDawn = Math.max(0, 1 - dDawn / 0.18)
    const gDusk = Math.max(0, 1 - dDusk / 0.18)
    const glow = Math.max(gDawn, gDusk)
    const dawn = gDawn >= gDusk ? 1 : 0
    return { glow, dawn }
  }

  update(dt: number) {
    if (this.zone !== 'earth' || this.deps.zone() !== 'earth') {
      if (this.group.visible) this.group.visible = false
      return
    }
    const { glow, dawn } = this.envelope(this.deps.dayFactor())
    if (glow <= 0) { if (this.group.visible) this.group.visible = false; return }
    this.group.visible = true
    this.t += dt
    // Anchor the whole group over the player's focus so the glow follows the view.
    const f = this.deps.focus()
    this.group.position.set(f.x, 0, f.z)
    for (const r of this.ribbons) {
      r.mesh.position.set(
        r.offX + Math.sin(this.t * r.drift + r.phase) * 18,
        r.offY,
        r.offZ,
      )
      // Slow breathing shimmer, gated by the twilight envelope.
      const shimmer = 0.5 + 0.5 * Math.sin(this.t * 0.5 + r.phase)
      r.mat.opacity = glow * (0.16 + 0.2 * shimmer)
      // Lerp between dusk magenta and dawn warmth by which twilight we're in.
      this.scratch.copy(r.cool).lerp(r.warm, dawn)
      r.mat.color.copy(this.scratch)
    }
  }

  dispose() {
    this.geo.dispose()
    this.tex.dispose()
    if (this.gradCanvas) {
      this.gradCanvas.width = this.gradCanvas.height = 0
      this.gradCanvas = null
    }
    for (const r of this.ribbons) r.mat.dispose()
  }
}
