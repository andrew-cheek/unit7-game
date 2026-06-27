import * as THREE from 'three'
import { config } from './config'

/**
 * The opening you stand on, not fall into: a floating sci-fi factory platform high
 * above the city where Unit-7 robots are stamped out, march to the edge, and step
 * off into the dive. The deck is translucent in parts so you can see the sky and
 * the distant city far below; a cloud-shaped "BEGIN YOUR JOURNEY" sign and a big
 * retro neon arrow point you off the ledge. Walk or jump off and the skydive
 * (DropIn) takes over.
 *
 * Local space: +Z is the ledge / dive direction, -Z is the factory end. The whole
 * group is yaw-rotated so +Z points at the city you'll dive toward.
 */
export class LaunchPad {
  readonly group = new THREE.Group()
  /** Walkable surface height (world Y). */
  readonly topY: number
  /** Platform radius (XZ), for the step-off test. */
  readonly radius = 30
  /** Invisible flat collider the player stands on (added to Physics ground). */
  readonly collider: THREE.Mesh
  /** World spawn point + facing for the player (on the deck, facing the ledge). */
  readonly spawn = new THREE.Vector3()
  readonly spawnYaw: number

  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private t = 0
  private yaw: number
  private center: THREE.Vector3
  // Factory robots: stamped at the press, march +Z to the ledge, step off + fall.
  private bots: { g: THREE.Group; legL: THREE.Mesh; legR: THREE.Mesh; z: number; state: 'spawn' | 'walk' | 'fall'; v: number; ph: number; fallT: number; mat: THREE.MeshStandardMaterial }[] = []
  private press!: THREE.Group
  private cores: THREE.Mesh[] = []
  private arrowMat!: THREE.MeshBasicMaterial
  private signMat!: THREE.SpriteMaterial

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, center: THREE.Vector3, faceYaw: number) {
    this.center = center.clone()
    this.topY = center.y
    this.yaw = faceYaw
    this.group.position.copy(this.center)
    this.group.rotation.y = faceYaw

    this.buildDeck()
    this.buildFactory()
    this.buildProps()
    this.buildSignage()
    this.buildClouds()
    this.buildBots()

    // Invisible horizontal collider disk at the deck surface for the player to walk
    // on (raycast ground). Slightly smaller than the visual rim so the edge reads.
    this.collider = new THREE.Mesh(
      this.ownG(new THREE.CylinderGeometry(this.radius, this.radius, 1, 32)),
      this.own(new THREE.MeshBasicMaterial({ visible: false })),
    )
    this.collider.position.set(this.center.x, this.topY - 0.5, this.center.z)
    scene.add(this.collider)
    this.collider.updateMatrixWorld(true) // so the very first physics raycast sees it at the right place

    // Spawn the player at the factory end of the deck, facing the ledge (+Z local).
    const back = this.radius * 0.62
    this.spawn.set(this.center.x - Math.sin(this.yaw) * back, this.topY + 0.1, this.center.z - Math.cos(this.yaw) * back)
    this.spawnYaw = this.yaw

    scene.add(this.group)
    this.group.updateMatrixWorld(true)
  }

  /** Translucent hex deck + opaque walkway + glowing rim. */
  private buildDeck() {
    const R = this.radius
    // See-through glass floor: a dark translucent disk you can see the sky through.
    const glass = new THREE.Mesh(
      this.ownG(new THREE.CircleGeometry(R, 48)),
      this.own(new THREE.MeshStandardMaterial({ color: 0x0a1626, metalness: 0.3, roughness: 0.2, transparent: true, opacity: 0.4, side: THREE.DoubleSide })),
    )
    glass.rotation.x = -Math.PI / 2
    glass.position.y = 0
    this.group.add(glass)
    // Glowing hex/grid lattice on the glass (additive, reads as energized floor).
    const grid = new THREE.Mesh(
      this.ownG(new THREE.RingGeometry(R * 0.18, R, 6, 5)),
      this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })),
    )
    grid.rotation.x = -Math.PI / 2; grid.position.y = 0.05
    this.group.add(grid)
    // Opaque walkway strip down the centre (factory -> ledge) so footing reads solid.
    const walk = new THREE.Mesh(
      this.ownG(new THREE.BoxGeometry(7, 0.3, R * 2)),
      this.own(new THREE.MeshStandardMaterial({ color: 0x141b2b, metalness: 0.5, roughness: 0.5 })),
    )
    walk.position.set(0, 0.0, 0)
    this.group.add(walk)
    // Solid central hub.
    const hub = new THREE.Mesh(
      this.ownG(new THREE.CylinderGeometry(R * 0.2, R * 0.24, 0.6, 24)),
      this.own(new THREE.MeshStandardMaterial({ color: 0x10182a, metalness: 0.6, roughness: 0.4, emissive: 0x0a2a3a, emissiveIntensity: 0.6 })),
    )
    hub.position.y = 0.1
    this.group.add(hub)
    // Glowing rim torus + a low safety lip so the edge is unmistakable.
    const rim = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(R, 0.35, 10, 64)), this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, fog: false })))
    rim.rotation.x = -Math.PI / 2; rim.position.y = 0.2
    this.group.add(rim)
    const lip = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(R, R, 0.8, 48, 1, true)), this.own(new THREE.MeshBasicMaterial({ color: 0x123, transparent: true, opacity: 0.5, side: THREE.DoubleSide })))
    lip.position.y = -0.3
    this.group.add(lip)
    // Under-glow so the disk reads as a hovering craft from below.
    const glow = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(R * 1.05, 48)), this.own(new THREE.MeshBasicMaterial({ color: 0x1a5cff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })))
    glow.rotation.x = -Math.PI / 2; glow.position.y = -1.2
    this.group.add(glow)
  }

  /** A robot-stamping press + conveyor at the factory (-Z) end of the deck. */
  private buildFactory() {
    const R = this.radius
    this.press = new THREE.Group()
    this.press.position.set(0, 0, -R * 0.72)
    const frameMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2336, metalness: 0.6, roughness: 0.4 }))
    // Gantry arch the robots are stamped under.
    for (const sx of [-3.2, 3.2]) {
      const post = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.8, 7, 0.8)), frameMat)
      post.position.set(sx, 3.5, 0); this.press.add(post)
    }
    const top = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(7.6, 0.9, 1.4)), frameMat)
    top.position.set(0, 7, 0); this.press.add(top)
    // The stamping head (animated up/down) + a hot emissive underside.
    const head = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(5.4, 1.2, 1.2)), this.own(new THREE.MeshStandardMaterial({ color: 0x0c1018, metalness: 0.7, roughness: 0.3, emissive: 0xff6a1e, emissiveIntensity: 1.2 })))
    head.name = 'pressHead'; head.position.set(0, 4.2, 0); this.press.add(head)
    // Forge glow pad where new units appear.
    const pad = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(2.6, 28)), this.own(new THREE.MeshBasicMaterial({ color: 0xff8a1e, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    pad.rotation.x = -Math.PI / 2; pad.position.y = 0.12; this.press.add(pad)
    // Conveyor rollers leading out toward the ledge.
    const rollerMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.7, roughness: 0.4 }))
    for (let i = 0; i < 4; i++) {
      const roller = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.4, 0.4, 6, 12)), rollerMat)
      roller.rotation.z = Math.PI / 2
      roller.position.set(0, 0.3, 2 + i * 2.2)
      this.press.add(roller)
    }
    this.group.add(this.press)
  }

  /** Sci-fi flavour: energy cores, antenna spires, a holo-readout. */
  private buildProps() {
    const R = this.radius
    const coreMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9b6bff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const coreGeo = this.ownG(new THREE.IcosahedronGeometry(1.5, 0))
    const spireMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2336, metalness: 0.7, roughness: 0.35, emissive: 0x27e7ff, emissiveIntensity: 0.5 }))
    const spireGeo = this.ownG(new THREE.ConeGeometry(0.6, 9, 8))
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4
      const r = R * 0.82
      // Floating energy core in a cage.
      const core = new THREE.Mesh(coreGeo, coreMat)
      core.position.set(Math.cos(a) * r, 3 + (i % 2) * 1.5, Math.sin(a) * r)
      this.group.add(core); this.cores.push(core)
      // Antenna spire beside it.
      const spire = new THREE.Mesh(spireGeo, spireMat)
      spire.position.set(Math.cos(a + 0.25) * r, 4.5, Math.sin(a + 0.25) * r)
      this.group.add(spire)
      const tip = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.35, 10, 8)), this.own(new THREE.MeshBasicMaterial({ color: 0xff2bd0, fog: false })))
      tip.position.set(spire.position.x, 9.2, spire.position.z)
      this.group.add(tip)
    }
  }

  /** Cloud-shaped "BEGIN YOUR JOURNEY, UNIT 7" sign + a big neon down-arrow at the ledge. */
  private buildSignage() {
    const R = this.radius
    // Cloud sign hovering out in the sky beyond the ledge.
    const tex = this.cloudSign()
    this.texs.push(tex)
    this.signMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false })
    this.mats.push(this.signMat)
    const sign = new THREE.Sprite(this.signMat)
    sign.position.set(0, 9, R + 26) // off the platform, in front of the ledge
    sign.scale.set(56, 28, 1)
    this.group.add(sign)

    // Retro neon down-arrow at the ledge pointing off the edge (flow-pulsed).
    this.arrowMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff2bd0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const arrow = new THREE.Group()
    arrow.position.set(0, 6, R - 1.5)
    // shaft chevrons
    for (let i = 0; i < 3; i++) {
      const chev = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(2.2, 2.4, 4)), this.arrowMat)
      chev.rotation.x = Math.PI // point down
      chev.rotation.y = Math.PI / 4
      chev.position.y = 2.5 - i * 2.4
      ;(chev as THREE.Mesh & { _ph?: number })._ph = i
      arrow.add(chev)
    }
    arrow.name = 'downArrow'
    this.group.add(arrow)
    // "STEP OFF" neon bar above the arrow.
    const barTex = this.labelTex('STEP OFF TO DIVE')
    this.texs.push(barTex)
    const barMat = new THREE.SpriteMaterial({ map: barTex, transparent: true, depthWrite: false, fog: false })
    this.mats.push(barMat)
    const bar = new THREE.Sprite(barMat)
    bar.position.set(0, 10.5, R - 1)
    bar.scale.set(18, 4.5, 1)
    this.group.add(bar)
  }

  /** A few cloud puffs drifting below the platform so the drop reads as a long way down. */
  private buildClouds() {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128
    const ctx = cv.getContext('2d')!
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, 'rgba(220,235,255,0.4)'); g.addColorStop(1, 'rgba(220,235,255,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    this.texs.push(tex)
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.5, depthWrite: false, fog: false })
    this.mats.push(mat)
    const n = config.tier.name === 'low' ? 5 : 10
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const r = 40 + (i % 3) * 30
      const puff = new THREE.Sprite(mat)
      puff.position.set(Math.cos(a) * r, -30 - (i % 4) * 16, Math.sin(a) * r)
      puff.scale.set(80, 48, 1)
      this.group.add(puff)
    }
  }

  /** Pool of factory robots that march off the ledge. */
  private buildBots() {
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3650, metalness: 0.55, roughness: 0.45 }))
    const torsoGeo = this.ownG(new THREE.CapsuleGeometry(0.42, 0.9, 4, 8))
    const headGeo = this.ownG(new THREE.BoxGeometry(0.5, 0.5, 0.5))
    const legGeo = this.ownG(new THREE.BoxGeometry(0.24, 0.9, 0.24))
    const armGeo = this.ownG(new THREE.BoxGeometry(0.2, 0.85, 0.2))
    const tints = [0x27e7ff, 0xff2bd0, 0x9dff5a, 0xffd24a, 0xb98cff]
    const n = config.tier.name === 'low' ? 5 : 8
    for (let i = 0; i < n; i++) {
      const g = new THREE.Group()
      const torso = new THREE.Mesh(torsoGeo, bodyMat); torso.position.y = 1.5; g.add(torso)
      const col = tints[i % tints.length]
      const mat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: col, emissiveIntensity: 1.6, roughness: 0.4 }))
      const head = new THREE.Mesh(headGeo, mat); head.position.y = 2.25; g.add(head)
      for (const sx of [-1, 1]) {
        const arm = new THREE.Mesh(armGeo, bodyMat); arm.position.set(sx * 0.6, 1.5, 0); g.add(arm)
      }
      const legL = new THREE.Mesh(legGeo, bodyMat); legL.position.set(-0.22, 0.85, 0); g.add(legL)
      const legR = new THREE.Mesh(legGeo, bodyMat); legR.position.set(0.22, 0.85, 0); g.add(legR)
      this.group.add(g)
      const b = { g, legL, legR, z: 0, state: 'spawn' as const, v: 2.4 + Math.random() * 1.2, ph: Math.random() * 6.28, fallT: 0, mat }
      this.respawnBot(b, -this.radius * 0.72 - i * 1.4) // stagger down the conveyor
      this.bots.push(b)
    }
  }

  private respawnBot(b: LaunchPad['bots'][number], z: number) {
    b.z = z
    b.state = 'spawn'
    b.fallT = 0
    b.g.position.set((Math.random() - 0.5) * 3, this.topY, z)
    b.g.rotation.set(0, 0, 0)
    b.g.scale.setScalar(0.01) // grow out of the press
    b.mat.opacity = 1
    b.mat.transparent = true
  }

  update(dt: number, _playerX: number, _playerZ: number) {
    this.t += dt
    // Press head hammers; forge pad pulses.
    const headMesh = this.press.getObjectByName('pressHead') as THREE.Mesh | null
    if (headMesh) headMesh.position.y = 4.2 + Math.abs(Math.sin(this.t * 2.2)) * 1.6
    // Energy cores spin + bob.
    for (let i = 0; i < this.cores.length; i++) {
      const c = this.cores[i]
      c.rotation.x += dt * 1.2; c.rotation.y += dt * 0.8
      c.position.y += Math.sin(this.t * 1.4 + i) * dt * 0.6
    }
    // Down-arrow chevrons flow + pulse.
    const arrow = this.group.getObjectByName('downArrow')
    if (arrow) {
      this.arrowMat.opacity = 0.55 + Math.sin(this.t * 4) * 0.35
      for (const ch of arrow.children) {
        const ph = (ch as THREE.Mesh & { _ph?: number })._ph ?? 0
        ;(ch as THREE.Mesh).position.y = 2.5 - ph * 2.4 - ((this.t * 3 + ph) % 1) * 0.6
      }
    }
    // Sign bobs gently.
    // (sprite is the 2nd-to-last-ish child; just bob the whole arrow group's sibling via mat - skip for simplicity)

    // March the factory robots toward the ledge (+Z local) and off it.
    const ledge = this.radius - 0.5
    for (const b of this.bots) {
      if (b.state === 'spawn') {
        const s = Math.min(1, b.g.scale.x + dt * 2)
        b.g.scale.setScalar(s)
        if (s >= 1) b.state = 'walk'
      } else if (b.state === 'walk') {
        b.z += b.v * dt
        b.g.position.z = b.z
        // walk cycle
        const sw = Math.sin(this.t * 8 + b.ph) * 0.5
        b.legL.rotation.x = sw; b.legR.rotation.x = -sw
        b.g.position.y = this.topY + Math.abs(Math.sin(this.t * 8 + b.ph)) * 0.06
        if (b.z >= ledge) { b.state = 'fall'; b.fallT = 0 }
      } else {
        // step off: pitch into a dive and fall away, fading, then recycle.
        b.fallT += dt
        b.g.position.z += b.v * dt
        b.g.position.y = this.topY - 0.5 * 9.8 * b.fallT * b.fallT * 0.6
        b.g.rotation.x = Math.min(Math.PI / 2, b.fallT * 2.2)
        b.mat.opacity = Math.max(0, 1 - b.fallT * 0.7)
        if (b.fallT > 2.2) this.respawnBot(b, -this.radius * 0.72)
      }
    }
  }

  /** Returns true once you've left the deck - walked/fell off the edge (dropped
   *  below the surface past the rim) OR flew clearly out past it (jetpack). */
  steppedOff(x: number, y: number, z: number): boolean {
    const d = Math.hypot(x - this.center.x, z - this.center.z)
    if (d <= this.radius - 4) return false // still well within the deck
    return y < this.topY - 1.5 || d > this.radius + 12
  }

  private cloudSign(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 512
    const ctx = cv.getContext('2d')!
    // Puffy cloud silhouette.
    ctx.fillStyle = 'rgba(244,250,255,0.96)'
    const puffs: [number, number, number][] = [[300, 300, 140], [460, 250, 170], [640, 270, 160], [780, 310, 130], [380, 340, 150], [560, 360, 170], [700, 350, 150], [512, 230, 150]]
    for (const [x, y, r] of puffs) { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill() }
    ctx.fillStyle = 'rgba(244,250,255,0.96)'; ctx.fillRect(280, 290, 480, 110)
    // Neon text.
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = '#27e7ff'; ctx.shadowBlur = 24
    ctx.fillStyle = '#0a3a55'
    ctx.font = '900 70px ui-monospace, Menlo, monospace'
    ctx.fillText('BEGIN YOUR JOURNEY', 512, 290)
    ctx.shadowColor = '#ff2bd0'
    ctx.fillStyle = '#a01a5a'
    ctx.font = '900 96px ui-monospace, Menlo, monospace'
    ctx.fillText('UNIT 7', 512, 372)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  private labelTex(text: string): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128
    const ctx = cv.getContext('2d')!
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = '#ff2bd0'; ctx.shadowBlur = 18
    ctx.fillStyle = '#eafff2'
    ctx.font = '800 64px ui-monospace, Menlo, monospace'
    ctx.fillText(text, 256, 64)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  dispose() {
    this.group.parent?.remove(this.group)
    this.collider.parent?.remove(this.collider)
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
    this.texs.forEach((t) => t.dispose())
  }
}
