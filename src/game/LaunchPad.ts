import * as THREE from 'three'
import { config } from './config'

/**
 * The opening you stand on, not fall into: a floating robot FACTORY high above the
 * city. An assembly line stamps and builds fresh units stage by stage - worker
 * arms welding as chassis ride the conveyor - and each finished unit stands up,
 * marches to the ledge under a neon "DROP ZONE" sign, and steps off into its
 * skydive. Walk to the glowing arrow and step off to start yours.
 *
 * Local space: +Z is the ledge / dive direction, -Z is the head of the assembly
 * line. The whole group is yaw-rotated so +Z points at the city you dive toward.
 */
export class LaunchPad {
  readonly group = new THREE.Group()
  readonly topY: number
  readonly radius = 32
  readonly collider: THREE.Mesh
  readonly spawn = new THREE.Vector3()
  readonly spawnYaw: number

  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private t = 0
  private yaw: number
  private center: THREE.Vector3
  // Assembly-line units: ride the conveyor being built stage by stage, then stand
  // up at the end, walk to the ledge, and step off into the dive (recycled).
  private units: {
    g: THREE.Group; parts: THREE.Object3D[]; legL: THREE.Mesh; legR: THREE.Mesh; head: THREE.Mesh
    bodyMat: THREE.MeshStandardMaterial; headMat: THREE.MeshStandardMaterial
    z: number; state: 'build' | 'walk' | 'fall'; v: number; ph: number; fallT: number; lane: number
  }[] = []
  private arms: { pivot: THREE.Group; elbow: THREE.Group; spark: THREE.Mesh; sparkMat: THREE.MeshBasicMaterial; ph: number }[] = []
  private cores: THREE.Mesh[] = []
  private beltSeams: THREE.Mesh[] = []
  private arrowMat!: THREE.MeshBasicMaterial
  private arrowChevs: THREE.Mesh[] = []
  private signGlow!: THREE.MeshBasicMaterial

  private readonly beltStart = -24
  private readonly beltEnd = 3

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, center: THREE.Vector3, faceYaw: number) {
    this.center = center.clone()
    this.topY = center.y
    this.yaw = faceYaw
    this.group.position.copy(this.center)
    this.group.rotation.y = faceYaw

    this.buildDeck()
    this.buildConveyor()
    this.buildArms()
    this.buildSign()
    this.buildProps()
    this.buildClouds()
    this.buildUnits()

    this.collider = new THREE.Mesh(
      this.ownG(new THREE.CylinderGeometry(this.radius, this.radius, 1, 6)),
      this.own(new THREE.MeshBasicMaterial({ visible: false })),
    )
    this.collider.rotation.y = faceYaw
    this.collider.position.set(this.center.x, this.topY - 0.5, this.center.z)
    scene.add(this.collider)
    this.collider.updateMatrixWorld(true)

    // Spawn on the right-hand walkway near the line's head, facing the ledge, so
    // you watch the units get built and march past you to the edge.
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw))
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    this.spawn.copy(this.center).addScaledVector(right, 8).addScaledVector(fwd, this.beltStart + 4)
    this.spawn.y = this.topY + 0.1
    this.spawnYaw = this.yaw

    scene.add(this.group)
    this.group.updateMatrixWorld(true)
  }

  /** Hexagonal industrial deck: dark metal, glowing seams, translucent side bays
   *  you can see the sky through, solid grated walkways. */
  private buildDeck() {
    const R = this.radius
    // Bright factory-floor lighting so the rig reads (it sits at altitude where the
    // sun is shallow; without this the dark metal goes near-black).
    const key = new THREE.PointLight(0xdcecff, 3.2, 120, 2); key.position.set(0, 26, -6); this.group.add(key)
    const fill = new THREE.PointLight(0x6fa8ff, 1.6, 90, 2); fill.position.set(0, 10, R * 0.5); this.group.add(fill)
    const forgeLight = new THREE.PointLight(0xff8a3c, 2.0, 40, 2); forgeLight.position.set(0, 6, this.beltStart); this.group.add(forgeLight)

    // Translucent glass bays (see the sky/clouds below).
    const glass = new THREE.Mesh(
      this.ownG(new THREE.CircleGeometry(R, 6),),
      this.own(new THREE.MeshStandardMaterial({ color: 0x1c2c4a, metalness: 0.4, roughness: 0.25, transparent: true, opacity: 0.5, side: THREE.DoubleSide, emissive: 0x0a1830, emissiveIntensity: 0.5 })),
    )
    glass.rotation.x = -Math.PI / 2
    this.group.add(glass)
    // Solid grated walkway running the length of the line and a cross-deck apron.
    const deckMat = this.own(new THREE.MeshStandardMaterial({ color: 0x33405e, metalness: 0.5, roughness: 0.5, emissive: 0x13243c, emissiveIntensity: 0.45 }))
    const spine = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(16, 0.4, R * 2)), deckMat)
    spine.position.y = 0.02; this.group.add(spine)
    const apron = new THREE.Mesh(this.ownG(new THREE.RingGeometry(R * 0.62, R * 0.98, 6, 1)), deckMat)
    apron.rotation.x = -Math.PI / 2; apron.position.y = 0.01; this.group.add(apron)
    // Glowing seams along the hex edges + a couple of cross seams.
    const seamMat = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, fog: false }))
    const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(R - 0.3, 0.28, 8, 6)), seamMat)
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.25; this.group.add(ring)
    for (const z of [-R * 0.45, R * 0.2]) {
      const seam = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(R * 1.6, 0.12, 0.3)), seamMat)
      seam.position.set(0, 0.24, z); this.group.add(seam)
    }
    // Safety lip + under-glow so it reads as a hovering rig from below.
    const lip = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(R, R, 1.1, 6, 1, true)), this.own(new THREE.MeshStandardMaterial({ color: 0x0c1424, metalness: 0.6, roughness: 0.5, side: THREE.DoubleSide })))
    lip.rotation.y = Math.PI / 6; lip.position.y = -0.45; this.group.add(lip)
    const glow = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(R * 1.06, 6)), this.own(new THREE.MeshBasicMaterial({ color: 0x1a5cff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })))
    glow.rotation.x = -Math.PI / 2; glow.position.y = -1.6; this.group.add(glow)
    // Under-struts / engine pods so it isn't a flat disc.
    const podMat = this.own(new THREE.MeshStandardMaterial({ color: 0x10182a, metalness: 0.7, roughness: 0.4, emissive: 0x1a5cff, emissiveIntensity: 0.5 }))
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6
      const pod = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.2, 0.5, 4, 8)), podMat)
      pod.position.set(Math.cos(a) * R * 0.8, -2.2, Math.sin(a) * R * 0.8)
      this.group.add(pod)
    }
  }

  /** The conveyor belt + a frame gantry over the head of the line. */
  private buildConveyor() {
    const len = this.beltEnd - this.beltStart
    const cz = (this.beltStart + this.beltEnd) / 2
    const beltMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1c2740, metalness: 0.6, roughness: 0.55, emissive: 0x0c1a30, emissiveIntensity: 0.4 }))
    const belt = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(6, 0.5, len)), beltMat)
    belt.position.set(0, 0.5, cz); this.group.add(belt)
    // Moving seam stripes on the belt (animated +Z to read as motion).
    const stripeMat = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    for (let i = 0; i < 8; i++) {
      const st = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(5.4, 0.02, 0.5)), stripeMat)
      st.position.set(0, 0.78, this.beltStart + (i / 8) * len)
      this.group.add(st); this.beltSeams.push(st)
    }
    // Side rails.
    const railMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2438, metalness: 0.7, roughness: 0.4 }))
    for (const sx of [-3.4, 3.4]) {
      const rail = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.4, 1.1, len)), railMat)
      rail.position.set(sx, 0.7, cz); this.group.add(rail)
    }
    // Head gantry where raw chassis drop in, with a hot forge bar.
    const gantry = new THREE.Group(); gantry.position.set(0, 0, this.beltStart)
    const frameMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2336, metalness: 0.65, roughness: 0.4 }))
    for (const sx of [-4, 4]) { const post = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.9, 8, 0.9)), frameMat); post.position.set(sx, 4, 0); gantry.add(post) }
    const top = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(9.5, 1, 1.6)), frameMat); top.position.set(0, 8, 0); gantry.add(top)
    const forge = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(7, 0.5, 0.5)), this.own(new THREE.MeshStandardMaterial({ color: 0x0c1018, emissive: 0xff6a1e, emissiveIntensity: 1.6, roughness: 0.3 }))); forge.position.set(0, 7.2, 0); gantry.add(forge)
    this.group.add(gantry)
  }

  /** Industrial worker arms beside the belt that pivot/weld as chassis pass. */
  private buildArms() {
    const baseMat = this.own(new THREE.MeshStandardMaterial({ color: 0x222c44, metalness: 0.7, roughness: 0.35 }))
    const segMat = this.own(new THREE.MeshStandardMaterial({ color: 0x33405e, metalness: 0.7, roughness: 0.35 }))
    const armGeo = this.ownG(new THREE.BoxGeometry(0.5, 0.5, 3.4))
    const stations = [this.beltStart + 5, this.beltStart + 12, this.beltStart + 19]
    let s = 0
    for (const z of stations) for (const sx of [-1, 1]) {
      const root = new THREE.Group(); root.position.set(sx * 4.6, 0, z)
      const base = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.8, 1, 1.6, 10)), baseMat); base.position.y = 0.8; root.add(base)
      const pivot = new THREE.Group(); pivot.position.set(0, 1.6, 0); root.add(pivot)
      const upper = new THREE.Mesh(armGeo, segMat); upper.position.set(0, 0, -sx * 1.5); pivot.add(upper)
      const elbow = new THREE.Group(); elbow.position.set(0, 0, -sx * 3); pivot.add(elbow)
      const fore = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.4, 0.4, 2.4)), segMat); fore.position.set(0, -0.4, -sx * 1.0); elbow.add(fore)
      const sparkMat = this.own(new THREE.MeshBasicMaterial({ color: 0xfff1c4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const spark = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.22, 8, 6)), sparkMat); spark.position.set(0, -0.8, -sx * 2.1); elbow.add(spark)
      this.group.add(root)
      this.arms.push({ pivot, elbow, spark, sparkMat, ph: s * 1.3 }); s++
    }
  }

  /** A neon "DROP ZONE" billboard over the ledge + a big animated down-arrow. */
  private buildSign() {
    const R = this.radius
    // Billboard panel on two posts, facing back up the line (toward the player).
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2336, metalness: 0.6, roughness: 0.4 }))
    for (const sx of [-9, 9]) { const post = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.7, 13, 0.7)), postMat); post.position.set(sx, 6.5, R + 4); this.group.add(post) }
    const tex = this.signTex(); this.texs.push(tex)
    const panelMat = this.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.DoubleSide }))
    const panel = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(22, 8)), panelMat)
    panel.position.set(0, 11, R + 4); panel.rotation.y = Math.PI // face -Z (the player)
    this.group.add(panel)
    // Glowing frame around the billboard.
    this.signGlow = this.own(new THREE.MeshBasicMaterial({ color: 0xff2bd0, fog: false }))
    const frame = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(0.1, 0.1, 4, 4)), this.signGlow) // placeholder, replaced by border boxes
    frame.visible = false; this.group.add(frame)
    for (const [w, h, y] of [[23, 0.4, 15.2], [23, 0.4, 6.8]] as [number, number, number][]) {
      const bar = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(w, h, 0.4)), this.signGlow); bar.position.set(0, y, R + 4); this.group.add(bar)
    }

    // Big retro neon down-arrow at the ledge, chevrons flowing down toward the drop.
    this.arrowMat = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const chevGeo = this.ownG(new THREE.ConeGeometry(2.4, 2.6, 4))
    for (let i = 0; i < 4; i++) {
      const chev = new THREE.Mesh(chevGeo, this.arrowMat)
      chev.rotation.x = Math.PI; chev.rotation.y = Math.PI / 4
      chev.position.set(0, 5.5 - i * 2.2, R - 2)
      this.group.add(chev); this.arrowChevs.push(chev)
    }
  }

  /** Energy cores, beacon lights, pipes. */
  private buildProps() {
    const R = this.radius
    const coreMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9b6bff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const coreGeo = this.ownG(new THREE.IcosahedronGeometry(1.4, 0))
    const cageMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.7, roughness: 0.4, emissive: 0x27e7ff, emissiveIntensity: 0.4 }))
    const cageGeo = this.ownG(new THREE.TorusGeometry(1.9, 0.12, 6, 16))
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4
      const r = R * 0.78
      const core = new THREE.Mesh(coreGeo, coreMat); core.position.set(Math.cos(a) * r, 3.2, Math.sin(a) * r)
      this.group.add(core); this.cores.push(core)
      for (let k = 0; k < 2; k++) { const cage = new THREE.Mesh(cageGeo, cageMat); cage.position.copy(core.position); cage.rotation.x = k * Math.PI / 2; this.group.add(cage) }
    }
    // Beacon spires at the rear corners.
    const spireMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2336, metalness: 0.7, roughness: 0.35, emissive: 0xff2bd0, emissiveIntensity: 0.4 }))
    for (const sx of [-1, 1]) {
      const spire = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(0.7, 10, 8)), spireMat); spire.position.set(sx * R * 0.7, 5, this.beltStart - 2); this.group.add(spire)
      const tip = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.4, 10, 8)), this.own(new THREE.MeshBasicMaterial({ color: 0xff2bd0, fog: false }))); tip.position.set(sx * R * 0.7, 10, this.beltStart - 2); this.group.add(tip)
    }
  }

  private buildClouds() {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128
    const ctx = cv.getContext('2d')!
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, 'rgba(220,235,255,0.4)'); g.addColorStop(1, 'rgba(220,235,255,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; this.texs.push(tex)
    const mat = this.own(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.5, depthWrite: false, fog: false }))
    const n = config.tier.name === 'low' ? 5 : 10
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const r = 44 + (i % 3) * 30
      const puff = new THREE.Sprite(mat)
      puff.position.set(Math.cos(a) * r, -32 - (i % 4) * 16, Math.sin(a) * r)
      puff.scale.set(80, 48, 1)
      this.group.add(puff)
    }
  }

  /** Units assembled on the belt -> walk to the ledge -> step off. */
  private buildUnits() {
    const torsoGeo = this.ownG(new THREE.BoxGeometry(0.95, 1.1, 0.6))
    const headGeo = this.ownG(new THREE.BoxGeometry(0.55, 0.55, 0.55))
    const legGeo = this.ownG(new THREE.BoxGeometry(0.26, 0.95, 0.26))
    const armGeo = this.ownG(new THREE.BoxGeometry(0.22, 0.9, 0.22))
    const baseGeo = this.ownG(new THREE.BoxGeometry(0.9, 0.3, 0.7))
    const tints = [0x27e7ff, 0xff2bd0, 0x9dff5a, 0xffd24a, 0xb98cff, 0xff8a1e]
    const n = config.tier.name === 'low' ? 4 : 7
    for (let i = 0; i < n; i++) {
      const g = new THREE.Group()
      const col = tints[i % tints.length]
      const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3650, metalness: 0.55, roughness: 0.45, transparent: true, opacity: 1 }))
      const headMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: col, emissiveIntensity: 1.7, roughness: 0.4, transparent: true, opacity: 1 }))
      const base = new THREE.Mesh(baseGeo, bodyMat); base.position.y = 0.15
      const legL = new THREE.Mesh(legGeo, bodyMat); legL.position.set(-0.22, 0.75, 0)
      const legR = new THREE.Mesh(legGeo, bodyMat); legR.position.set(0.22, 0.75, 0)
      const torso = new THREE.Mesh(torsoGeo, bodyMat); torso.position.y = 1.75
      const armL = new THREE.Mesh(armGeo, bodyMat); armL.position.set(-0.62, 1.75, 0)
      const armR = new THREE.Mesh(armGeo, bodyMat); armR.position.set(0.62, 1.75, 0)
      const head = new THREE.Mesh(headGeo, headMat); head.position.y = 2.6
      const parts = [base, legL, legR, torso, armL, armR, head]
      for (const p of parts) g.add(p)
      this.group.add(g)
      const u = { g, parts, legL, legR, head, bodyMat, headMat, z: 0, state: 'build' as const, v: 3.2 + Math.random() * 1.2, ph: Math.random() * 6.28, fallT: 0, lane: (Math.random() - 0.5) * 2.2 }
      this.respawnUnit(u, this.beltStart - i * ((this.beltEnd - this.beltStart) / n))
      this.units.push(u)
    }
  }

  private respawnUnit(u: LaunchPad['units'][number], z: number) {
    u.z = z; u.state = 'build'; u.fallT = 0
    u.g.position.set(u.lane, this.topY + 0.55, z) // riding on top of the belt
    u.g.rotation.set(0, 0, 0)
    u.bodyMat.opacity = 1; u.headMat.opacity = 1
    u.headMat.emissiveIntensity = 0.2
  }

  update(dt: number, _x: number, _z: number) {
    this.t += dt
    const len = this.beltEnd - this.beltStart
    // Belt stripes flow toward the ledge.
    for (const st of this.beltSeams) {
      st.position.z += 6 * dt
      if (st.position.z > this.beltEnd) st.position.z = this.beltStart
    }
    // Worker arms pivot and weld (spark flashes near a passing chassis).
    for (const a of this.arms) {
      a.pivot.rotation.x = Math.sin(this.t * 2 + a.ph) * 0.5 - 0.3
      a.elbow.rotation.x = Math.sin(this.t * 3 + a.ph) * 0.6
      a.sparkMat.opacity = Math.max(0, Math.sin(this.t * 18 + a.ph)) * 0.85
      const s = 1 + a.sparkMat.opacity * 0.9; a.spark.scale.setScalar(s)
    }
    // Energy cores + sign + arrow.
    for (let i = 0; i < this.cores.length; i++) { const c = this.cores[i]; c.rotation.x += dt * 1.1; c.rotation.y += dt * 0.8; c.position.y = 3.2 + Math.sin(this.t * 1.4 + i) * 0.5 }
    if (this.signGlow) (this.signGlow.color as THREE.Color).setHex(0xff2bd0)
    this.arrowMat.opacity = 0.5 + Math.sin(this.t * 4) * 0.35
    for (let i = 0; i < this.arrowChevs.length; i++) this.arrowChevs[i].position.y = 5.5 - i * 2.2 - ((this.t * 3 + i) % 1) * 0.6

    // Units: build along the belt, then walk to the ledge and off.
    const ledge = this.radius - 1
    for (const u of this.units) {
      if (u.state === 'build') {
        u.z += (len / 6) * dt // ride the belt
        const f = THREE.MathUtils.clamp((u.z - this.beltStart) / len, 0, 1)
        // Reveal parts stage by stage: base -> legs -> torso -> arms -> head lights.
        u.parts[0].visible = true
        u.parts[1].visible = u.parts[2].visible = f > 0.18
        u.parts[3].visible = f > 0.42
        u.parts[4].visible = u.parts[5].visible = f > 0.64
        u.parts[6].visible = f > 0.82
        u.headMat.emissiveIntensity = f > 0.82 ? 1.7 : 0.2
        u.g.position.set(u.lane, this.topY + 0.55, u.z)
        if (u.z >= this.beltEnd) { u.state = 'walk'; for (const p of u.parts) p.visible = true; u.headMat.emissiveIntensity = 1.7 }
      } else if (u.state === 'walk') {
        u.z += u.v * dt
        const sw = Math.sin(this.t * 8 + u.ph) * 0.5
        u.legL.rotation.x = sw; u.legR.rotation.x = -sw
        u.g.position.set(u.lane * (1 - (u.z - this.beltEnd) / (ledge - this.beltEnd)), this.topY + Math.abs(Math.sin(this.t * 8 + u.ph)) * 0.06, u.z)
        if (u.z >= ledge) { u.state = 'fall'; u.fallT = 0 }
      } else {
        u.fallT += dt
        u.z += u.v * dt
        u.g.position.y = this.topY - 0.5 * 9.8 * u.fallT * u.fallT * 0.6
        u.g.position.z = u.z
        u.g.rotation.x = Math.min(Math.PI / 2, u.fallT * 2.2)
        const o = Math.max(0, 1 - u.fallT * 0.8); u.bodyMat.opacity = o; u.headMat.opacity = o
        if (u.fallT > 2) this.respawnUnit(u, this.beltStart)
      }
    }
  }

  /** World-space AABBs for the solid structures, so the player walks AROUND the
   *  assembly line (not through it). Pushed to Physics.colliders while on the pad. */
  colliderBoxes(): THREE.Box3[] {
    const lineMid = (this.beltStart - 1.5 + this.beltEnd + 1.5) / 2
    const lineHalf = (this.beltEnd + 1.5 - (this.beltStart - 1.5)) / 2
    return [
      this.worldBox(0, 1.6, lineMid, 6.6, 1.8, lineHalf), // the whole assembly line (belt + arms)
      this.worldBox(0, 4, this.beltStart, 5, 4, 1.2), // head gantry
    ]
  }

  private worldBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): THREE.Box3 {
    const box = new THREE.Box3()
    const v = new THREE.Vector3()
    for (let i = 0; i < 8; i++) {
      v.set(cx + (i & 1 ? hx : -hx), cy + (i & 2 ? hy : -hy), cz + (i & 4 ? hz : -hz))
      v.applyMatrix4(this.group.matrixWorld)
      box.expandByPoint(v)
    }
    return box
  }

  /** Left the deck - walked/fell off the edge, or flew clearly past the rim. */
  steppedOff(x: number, y: number, z: number): boolean {
    const d = Math.hypot(x - this.center.x, z - this.center.z)
    if (d <= this.radius - 4) return false
    return y < this.topY - 1.5 || d > this.radius + 12
  }

  private signTex(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 384
    const ctx = cv.getContext('2d')!
    // Dark panel with a subtle scanline texture.
    ctx.fillStyle = '#070b14'; ctx.fillRect(0, 0, 1024, 384)
    ctx.fillStyle = 'rgba(39,231,255,0.05)'; for (let y = 0; y < 384; y += 6) ctx.fillRect(0, y, 1024, 2)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = '#ff2bd0'; ctx.shadowBlur = 30
    ctx.fillStyle = '#ff2bd0'
    ctx.font = '900 150px ui-monospace, Menlo, monospace'
    ctx.fillText('DROP ZONE', 512, 150)
    ctx.shadowColor = '#27e7ff'; ctx.shadowBlur = 18
    ctx.fillStyle = '#bfefff'
    ctx.font = '800 62px ui-monospace, Menlo, monospace'
    ctx.fillText('STEP OFF TO SKYDIVE  ▼', 512, 285)
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
