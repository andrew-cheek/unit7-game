import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so the heavens stay anchored overhead wherever you roam. */
  focus: () => THREE.Vector3
}

interface Cloud {
  sprite: THREE.Sprite
  mat: THREE.SpriteMaterial
  base: THREE.Vector3 // sky-relative offset from focus
  drift: number // radians/sec of slow orbit
  ang: number // current orbit angle
  rad: number // orbit radius in XZ
  pulse: number // opacity pulse phase
  baseOp: number
}

interface Streak {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  origin: THREE.Vector3 // sky-relative start offset from focus
  dir: THREE.Vector3 // travel direction (unit)
  dist: number // distance travelled so far
  span: number // total streak run length
  active: boolean
}

const SKY_Y = 320 // how high the dome sits above focus
const STREAK_SPEED = 520 // units/sec a meteor travels

/**
 * Off-world heavens: a drifting band of additive nebula clouds and a faint
 * galaxy streak arc the sky, while a pooled set of shooting stars periodically
 * tear across the upper dome and fade. Pure ambience, sky-anchored to the
 * player focus, no colliders. Moon + Mars only; hidden on Earth's city sky.
 */
export class CosmicSky implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private clouds: Cloud[] = []
  private streaks: Streak[] = []
  private galaxy: THREE.Mesh | null = null
  private zone: Zone = 'earth'
  private t = 0
  private timer = 2.5 // countdown to the next meteor
  // Scratch vectors reused every frame so we never allocate in update().
  private scratch = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }
  private ownT<T extends THREE.Texture>(t: T): T { this.texs.push(t); return t }

  constructor(scene: THREE.Scene, private deps: Deps) {
    void this.deps
    const low = config.tier.name === 'low'
    const medium = config.tier.name === 'medium'

    // --- nebula band: big soft additive billboards in a high arc ---
    const cloudTex = this.ownT(this.drawCloud())
    const tints = [0xb07cff, 0x4affd0, 0xff4fd8, 0x6fa8ff, 0xff8acb]
    // Medium (iPad Pro tier) gets ~70% of the high cloud count, above low's floor.
    const nClouds = low ? 3 : medium ? 4 : 5
    for (let i = 0; i < nClouds; i++) {
      const mat = this.own(new THREE.SpriteMaterial({
        map: cloudTex,
        color: new THREE.Color(tints[i % tints.length]),
        transparent: true,
        opacity: 0.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        fog: false,
      }))
      const sprite = new THREE.Sprite(mat)
      const scale = 240 + Math.random() * 200
      sprite.scale.set(scale, scale * 0.62, 1)
      sprite.frustumCulled = false
      // Spread the clouds in a band across the upper sky.
      const ang = (i / nClouds) * Math.PI * 2 + Math.random() * 0.6
      const rad = 260 + Math.random() * 220
      const base = new THREE.Vector3(
        Math.cos(ang) * rad,
        SKY_Y * (0.7 + Math.random() * 0.4),
        Math.sin(ang) * rad,
      )
      sprite.position.copy(base)
      this.group.add(sprite)
      this.clouds.push({
        sprite, mat, base,
        drift: (0.006 + Math.random() * 0.01) * (Math.random() < 0.5 ? -1 : 1),
        ang, rad,
        pulse: Math.random() * 6.28,
        baseOp: 0.16 + Math.random() * 0.12,
      })
    }

    // --- galaxy / Milky-Way streak: one large faint band tilted across the sky ---
    const galTex = this.ownT(this.drawGalaxy())
    const galMat = this.own(new THREE.MeshBasicMaterial({
      map: galTex,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      fog: false,
    }))
    const galGeo = this.ownG(new THREE.PlaneGeometry(1400, 360))
    const galaxy = new THREE.Mesh(galGeo, galMat)
    galaxy.position.set(0, SKY_Y * 1.05, 0)
    galaxy.rotation.x = -Math.PI / 2 + 0.35
    galaxy.rotation.z = 0.5
    galaxy.frustumCulled = false
    this.group.add(galaxy)
    this.galaxy = galaxy

    // --- shooting stars: a pool of thin additive streak planes ---
    const streakTex = this.ownT(this.drawStreak())
    const streakGeo = this.ownG(new THREE.PlaneGeometry(1, 1))
    // Medium gets ~67% of the high streak pool (8 of 12), above low's 6.
    const nStreaks = low ? 6 : medium ? 8 : 12
    for (let i = 0; i < nStreaks; i++) {
      const mat = this.own(new THREE.MeshBasicMaterial({
        map: streakTex,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        fog: false,
      }))
      const mesh = new THREE.Mesh(streakGeo, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.streaks.push({
        mesh, mat,
        origin: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        dist: 0,
        span: 0,
        active: false,
      })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  /** Draw a soft radial cloud blob ONCE; returns a CanvasTexture. */
  private drawCloud(): THREE.CanvasTexture {
    const s = 256
    const cv = document.createElement('canvas')
    cv.width = s; cv.height = s
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, s, s)
    // A few overlapping soft radial gradients give an irregular nebula puff.
    const blobs = 7
    for (let i = 0; i < blobs; i++) {
      const cx = s * (0.3 + Math.random() * 0.4)
      const cy = s * (0.3 + Math.random() * 0.4)
      const r = s * (0.18 + Math.random() * 0.22)
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
      g.addColorStop(0, 'rgba(255,255,255,0.5)')
      g.addColorStop(0.4, 'rgba(255,255,255,0.18)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, s, s)
    }
    // Sprinkle faint stars across the puff for texture.
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    for (let i = 0; i < 40; i++) {
      ctx.globalAlpha = 0.3 + Math.random() * 0.5
      ctx.fillRect(Math.random() * s, Math.random() * s, 1.4, 1.4)
    }
    ctx.globalAlpha = 1
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    return tex
  }

  /** Draw a faint star-band (galaxy) ONCE; returns a CanvasTexture. */
  private drawGalaxy(): THREE.CanvasTexture {
    const w = 1024, h = 256
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    // Soft horizontal glow band down the centre.
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, 'rgba(120,140,255,0)')
    g.addColorStop(0.5, 'rgba(190,200,255,0.45)')
    g.addColorStop(1, 'rgba(120,140,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    // Dense star dust concentrated toward the band centre. Quantize each star's
    // alpha into 16 buckets and only reset fillStyle when the bucket changes, so
    // 1200 stars cost ~16 fillStyle assignments instead of one per star.
    let bucket = -1
    for (let i = 0; i < 1200; i++) {
      const x = Math.random() * w
      const dy = (Math.random() - 0.5) ** 3 * 4 // bias toward middle
      const y = h * 0.5 + dy * h
      const a = 0.2 + Math.random() * 0.7
      const b = Math.round(a * 16) // 16 alpha buckets, visually indistinguishable
      if (b !== bucket) {
        bucket = b
        ctx.fillStyle = `rgba(255,255,255,${b / 16})`
      }
      const sz = Math.random() < 0.9 ? 1 : 2
      ctx.fillRect(x, y, sz, sz)
    }
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    return tex
  }

  /** Draw a meteor streak (bright head, fading tail) ONCE; returns a CanvasTexture. */
  private drawStreak(): THREE.CanvasTexture {
    const w = 256, h = 32
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    // Tail fades from transparent (left) to bright (right = head).
    const g = ctx.createLinearGradient(0, 0, w, 0)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.7, 'rgba(200,225,255,0.5)')
    g.addColorStop(1, 'rgba(255,255,255,1)')
    ctx.fillStyle = g
    ctx.fillRect(0, h * 0.5 - 1.5, w, 3)
    // Bright round head at the leading edge.
    const head = ctx.createRadialGradient(w - 8, h * 0.5, 0, w - 8, h * 0.5, 12)
    head.addColorStop(0, 'rgba(255,255,255,1)')
    head.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = head
    ctx.fillRect(w - 28, 0, 28, h)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    return tex
  }

  setZone(zone: Zone) {
    this.zone = zone
    const active = zone === 'moon' || zone === 'mars'
    this.group.visible = active
    if (!active) {
      for (const s of this.streaks) { s.active = false; s.mesh.visible = false }
    }
  }

  /** Arm a free streak: pick a high start point and a random cross-sky run. */
  private launch() {
    const s = this.streaks.find((x) => !x.active)
    if (!s) return
    // Start somewhere high in the dome, offset from focus.
    const ang = Math.random() * Math.PI * 2
    const rad = 180 + Math.random() * 240
    s.origin.set(
      Math.cos(ang) * rad,
      SKY_Y * (0.85 + Math.random() * 0.3),
      Math.sin(ang) * rad,
    )
    // Travel mostly sideways with a slight downward bias, like a falling meteor.
    const dAng = Math.random() * Math.PI * 2
    s.dir.set(Math.cos(dAng), -0.25 - Math.random() * 0.3, Math.sin(dAng)).normalize()
    s.dist = 0
    s.span = 700 + Math.random() * 500
    s.active = true
    s.mesh.visible = true
    s.mat.opacity = 0
  }

  update(dt: number) {
    const active = this.zone === 'moon' || this.zone === 'mars'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return
    this.t += dt

    const f = this.deps.focus()
    // Anchor the whole dome over the player so it's always overhead.
    this.group.position.set(f.x, 0, f.z)
    if (this.galaxy) this.galaxy.rotation.y += dt * 0.01

    // Drift + pulse the nebula clouds (positions are group-local, so just orbit).
    for (const c of this.clouds) {
      c.ang += c.drift * dt
      c.sprite.position.x = Math.cos(c.ang) * c.rad
      c.sprite.position.z = Math.sin(c.ang) * c.rad
      c.sprite.position.y = c.base.y
      const pulse = 0.7 + 0.3 * Math.sin(this.t * 0.3 + c.pulse)
      c.mat.opacity = c.baseOp * pulse
    }

    // Schedule meteors on a random timer.
    this.timer -= dt
    if (this.timer <= 0) {
      this.launch()
      this.timer = 1.5 + Math.random() * 3.5
    }

    // Advance every in-flight streak.
    for (const s of this.streaks) {
      if (!s.active) continue
      s.dist += STREAK_SPEED * dt
      const frac = s.dist / s.span
      if (frac >= 1) {
        s.active = false
        s.mesh.visible = false
        continue
      }
      // Position the head along the run; orient the plane along its direction.
      this.scratch.copy(s.dir).multiplyScalar(s.dist).add(s.origin)
      s.mesh.position.copy(this.scratch)
      // Stretch the plane into a long thin streak and aim it down its path.
      const len = 90 + frac * 60
      s.mesh.scale.set(len, 9, 1)
      // Face the camera-anchored sky while pointing along travel: yaw from XZ dir.
      s.mesh.rotation.set(0, -Math.atan2(s.dir.z, s.dir.x), Math.asin(s.dir.y))
      // Fade in fast, then out toward the end of the run.
      s.mat.opacity = Math.min(1, frac * 6) * (1 - frac) * 1.6
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.texs) t.dispose()
  }
}
