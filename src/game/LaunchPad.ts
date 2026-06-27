import * as THREE from 'three'
import { config } from './config'

/**
 * The opening you stand on, not fall into: a big floating robot FACTORY high above
 * the city. An assembly line runs LEFT-TO-RIGHT right in front of where you spawn:
 * raw chassis drop in at the glowing forge, ride the belt while worker arms weld on
 * legs, torso, arms and head, then finished units step off the end, walk across the
 * deck and dive off the ledge under a neon DROP ZONE sign. Follow them off the edge.
 *
 * The deck collider, the visual floor and the step-off test all share ONE radius,
 * so there's no invisible lip to "walk on the sky" past the visible edge.
 *
 * Local space: +Z is the ledge / dive direction (you face it at spawn). The belt
 * runs along X at z = beltZ, a short distance in front of the spawn, so the whole
 * build-and-march-off sequence plays out across your view up close.
 */
export class LaunchPad {
  readonly group = new THREE.Group()
  readonly topY: number
  readonly radius = 50
  readonly collider: THREE.Mesh
  readonly spawn = new THREE.Vector3()
  readonly spawnYaw: number

  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private t = 0
  private yaw: number
  private center: THREE.Vector3

  private units: {
    g: THREE.Group; parts: THREE.Object3D[]; legL: THREE.Mesh; legR: THREE.Mesh
    bodyMat: THREE.MeshStandardMaterial; headMat: THREE.MeshStandardMaterial
    x: number; z: number; tx: number; tz: number; state: 'build' | 'wander' | 'edge' | 'fall'
    v: number; ph: number; fallT: number; wait: number; lane: number
  }[] = []
  private arms: { pivot: THREE.Group; elbow: THREE.Group; spark: THREE.Mesh; sparkMat: THREE.MeshBasicMaterial; ph: number }[] = []
  private cores: THREE.Mesh[] = []
  private beltSeams: THREE.Mesh[] = []
  private arrowMat!: THREE.MeshBasicMaterial
  private arrowChevs: THREE.Mesh[] = []
  private edgeGlow!: THREE.MeshBasicMaterial

  // Belt runs along X (forge at beltX0, output at beltX1), sitting at z = beltZ
  // just in front of the spawn so the line crosses your view head-on.
  private readonly beltX0 = -17
  private readonly beltX1 = 17
  private readonly beltZ = 8
  private get lenX() { return this.beltX1 - this.beltX0 }

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

    // Circular collider with enough segments to read as a true circle, matching the
    // visual floor radius exactly - so you fall off right at the visible edge.
    this.collider = new THREE.Mesh(
      this.ownG(new THREE.CylinderGeometry(this.radius, this.radius, 1, 48)),
      this.own(new THREE.MeshBasicMaterial({ visible: false })),
    )
    this.collider.position.set(this.center.x, this.topY - 0.5, this.center.z)
    scene.add(this.collider)
    this.collider.updateMatrixWorld(true)

    // Spawn a short way back from the belt, dead-centre, facing the line and the
    // ledge beyond it - so the assembly line fills your view the instant you land.
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw))
    this.spawn.copy(this.center).addScaledVector(fwd, -4)
    this.spawn.y = this.topY + 0.1
    this.spawnYaw = this.yaw

    scene.add(this.group)
    this.group.updateMatrixWorld(true)
  }

  /** Detailed circular deck: paneled floor with a neon grid, a raised rim wall with
   *  a glowing lip, warning chevrons at the edge, a central core. */
  private buildDeck() {
    const R = this.radius
    const floorTex = this.deckTexture(); this.texs.push(floorTex)
    const floor = new THREE.Mesh(
      this.ownG(new THREE.CircleGeometry(R, 48)),
      this.own(new THREE.MeshStandardMaterial({ map: floorTex, metalness: 0.5, roughness: 0.55, emissive: 0x0c1a30, emissiveIntensity: 0.35 })),
    )
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0.02
    this.group.add(floor)
    // Lighting so it isn't dark up at altitude.
    const key = new THREE.PointLight(0xdcecff, 4.6, 180, 2); key.position.set(0, 26, this.beltZ - 4); this.group.add(key)
    const fill = new THREE.PointLight(0x6fa8ff, 2.4, 140, 2); fill.position.set(0, 12, R * 0.5); this.group.add(fill)
    const forge = new THREE.PointLight(0xff8a3c, 2.2, 42, 2); forge.position.set(this.beltX0, 6, this.beltZ); this.group.add(forge)
    const ambient = new THREE.HemisphereLight(0x9fc0ff, 0x0a1020, 0.7); this.group.add(ambient)

    // Raised rim wall + glowing top lip (so the edge is unmistakable).
    const wall = new THREE.Mesh(
      this.ownG(new THREE.CylinderGeometry(R, R, 1.8, 48, 1, true)),
      this.own(new THREE.MeshStandardMaterial({ color: 0x141d30, metalness: 0.6, roughness: 0.45, side: THREE.DoubleSide, emissive: 0x0a1830, emissiveIntensity: 0.4 })),
    )
    wall.position.y = 0.9; this.group.add(wall)
    this.edgeGlow = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, fog: false }))
    const lip = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(R, 0.32, 10, 64)), this.edgeGlow)
    lip.rotation.x = -Math.PI / 2; lip.position.y = 1.7; this.group.add(lip)
    // Warning chevrons painted just inside the rim, all the way around.
    const warnMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const chevGeo = this.ownG(new THREE.RingGeometry(R - 3.2, R - 1.2, 2, 1, 0, 0.32))
    for (let i = 0; i < 24; i++) {
      const ch = new THREE.Mesh(chevGeo, warnMat); ch.rotation.x = -Math.PI / 2
      ch.rotation.z = (i / 24) * Math.PI * 2; ch.position.y = 0.06; this.group.add(ch)
    }
    // Central core hub.
    const hub = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(4, 5, 0.7, 24)), this.own(new THREE.MeshStandardMaterial({ color: 0x121a2c, metalness: 0.7, roughness: 0.4, emissive: 0x0a2a3a, emissiveIntensity: 0.7 })))
    hub.position.set(0, 0.12, this.beltZ); this.group.add(hub)
    // Under-glow + engine pods so it reads as a hovering rig.
    const glow = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(R * 1.05, 48)), this.own(new THREE.MeshBasicMaterial({ color: 0x1a5cff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })))
    glow.rotation.x = -Math.PI / 2; glow.position.y = -1.8; this.group.add(glow)
    const podMat = this.own(new THREE.MeshStandardMaterial({ color: 0x10182a, metalness: 0.7, roughness: 0.4, emissive: 0x1a5cff, emissiveIntensity: 0.5 }))
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      const pod = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.5, 0.7, 5, 8)), podMat)
      pod.position.set(Math.cos(a) * R * 0.82, -2.8, Math.sin(a) * R * 0.82); this.group.add(pod)
    }
  }

  /** Conveyor running along X with an open overhead gantry framing it. */
  private buildConveyor() {
    const len = this.lenX
    const cx = (this.beltX0 + this.beltX1) / 2
    const Z = this.beltZ
    const beltMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1c2740, metalness: 0.6, roughness: 0.55, emissive: 0x0c1a30, emissiveIntensity: 0.4 }))
    const belt = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(len, 0.6, 7)), beltMat)
    belt.position.set(cx, 0.6, Z); this.group.add(belt)
    const stripeMat = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    for (let i = 0; i < 12; i++) {
      const st = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.6, 0.02, 6.4)), stripeMat)
      st.position.set(this.beltX0 + (i / 12) * len, 0.92, Z); this.group.add(st); this.beltSeams.push(st)
    }
    const railMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2438, metalness: 0.7, roughness: 0.4 }))
    for (const sz of [-3.6, 3.6]) { const rail = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(len, 1.3, 0.5)), railMat); rail.position.set(cx, 0.85, Z + sz); this.group.add(rail) }
    // Open overhead gantry: thin top rails + end legs only - NO tall side walls,
    // so nothing stands between the camera and the robots on the belt.
    const frameMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2336, metalness: 0.65, roughness: 0.4, emissive: 0x123a52, emissiveIntensity: 0.5 }))
    for (const sz of [-6.5, 6.5]) {
      const rail = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(len + 4, 0.45, 0.45)), frameMat); rail.position.set(cx, 7.3, Z + sz); this.group.add(rail)
      for (const ex of [cx - (len + 4) / 2, cx + (len + 4) / 2]) { const leg = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.5, 7.5, 0.5)), frameMat); leg.position.set(ex, 3.75, Z + sz); this.group.add(leg) }
    }
    const trimMat = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    for (let i = 0; i <= 5; i++) {
      const bx = this.beltX0 + (i / 5) * len
      const beam = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.4, 0.4, 13)), frameMat); beam.position.set(bx, 7.6, Z); this.group.add(beam)
      const trim = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.06, 0.06, 13)), trimMat); trim.position.set(bx, 7.38, Z); this.group.add(trim)
    }
    // Hot forge arch at the head where raw chassis drop in.
    const forgeMat = this.own(new THREE.MeshStandardMaterial({ color: 0x0c1018, emissive: 0xff6a1e, emissiveIntensity: 1.9, roughness: 0.3 }))
    const forge = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.6, 0.5, 7)), forgeMat); forge.position.set(this.beltX0, 2.4, Z); this.group.add(forge)
    const forgeGlow = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(3, 5)), this.own(new THREE.MeshBasicMaterial({ color: 0xff7a2e, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    forgeGlow.position.set(this.beltX0 - 0.4, 2.4, Z); forgeGlow.rotation.y = Math.PI / 2; this.group.add(forgeGlow)
    // Status screens hung on the far girder facing the player.
    const screenTex = this.screenTexture(); this.texs.push(screenTex)
    for (let i = 0; i < 3; i++) {
      const scr = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(2.8, 1.7)), this.own(new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false })))
      scr.position.set(this.beltX0 + 6 + i * 9, 5.4, Z - 6.7); scr.rotation.y = Math.PI; this.group.add(scr)
    }
    // Conduits running along the gantry.
    const pipeMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.75, roughness: 0.35, emissive: 0x112233, emissiveIntensity: 0.3 }))
    for (const sz of [-6.85, 6.85]) for (const yy of [2.4, 3.4]) { const pipe = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.18, 0.18, len + 4, 8)), pipeMat); pipe.rotation.z = Math.PI / 2; pipe.position.set(cx, yy, Z + sz); this.group.add(pipe) }
  }

  /** Industrial worker arms at stations down both sides of the belt. */
  private buildArms() {
    const baseMat = this.own(new THREE.MeshStandardMaterial({ color: 0x222c44, metalness: 0.7, roughness: 0.35 }))
    const segMat = this.own(new THREE.MeshStandardMaterial({ color: 0x33405e, metalness: 0.7, roughness: 0.35 }))
    const armGeo = this.ownG(new THREE.BoxGeometry(0.5, 0.5, 3.6))
    const foreGeo = this.ownG(new THREE.BoxGeometry(0.4, 0.4, 2.6))
    const baseGeo = this.ownG(new THREE.CylinderGeometry(0.9, 1.1, 1.8, 10))
    const sparkGeo = this.ownG(new THREE.SphereGeometry(0.22, 8, 6))
    const stations = 4
    let s = 0
    for (let i = 0; i < stations; i++) {
      const x = this.beltX0 + 5 + (i / (stations - 1)) * (this.lenX - 10)
      for (const sz of [-1, 1]) {
        const root = new THREE.Group(); root.position.set(x, 0, this.beltZ + sz * 5)
        const base = new THREE.Mesh(baseGeo, baseMat); base.position.y = 0.9; root.add(base)
        const pivot = new THREE.Group(); pivot.position.set(0, 1.8, 0); root.add(pivot)
        const upper = new THREE.Mesh(armGeo, segMat); upper.position.set(0, 0, -sz * 1.6); pivot.add(upper)
        const elbow = new THREE.Group(); elbow.position.set(0, 0, -sz * 3.2); pivot.add(elbow)
        const fore = new THREE.Mesh(foreGeo, segMat); fore.position.set(0, -0.4, -sz * 1.1); elbow.add(fore)
        const sparkMat = this.own(new THREE.MeshBasicMaterial({ color: 0xfff1c4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
        const spark = new THREE.Mesh(sparkGeo, sparkMat); spark.position.set(0, -0.8, -sz * 2.2); elbow.add(spark)
        this.group.add(root)
        this.arms.push({ pivot, elbow, spark, sparkMat, ph: s * 1.3 }); s++
      }
    }
  }

  /** Neon DROP ZONE billboard + a big animated down-arrow at the ledge. */
  private buildSign() {
    const R = this.radius
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2336, metalness: 0.6, roughness: 0.4 }))
    for (const sx of [-11, 11]) { const post = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.8, 15, 0.8)), postMat); post.position.set(sx, 7.5, R + 5); this.group.add(post) }
    const tex = this.signTex(); this.texs.push(tex)
    const panel = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(26, 9)), this.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.DoubleSide })))
    panel.position.set(0, 12.5, R + 5); panel.rotation.y = Math.PI; this.group.add(panel)
    const frameMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff2bd0, fog: false }))
    for (const y of [17.4, 7.6]) { const bar = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(27, 0.45, 0.45)), frameMat); bar.position.set(0, y, R + 5); this.group.add(bar) }
    // Down-arrow chevrons flowing toward the drop.
    this.arrowMat = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const chevGeo = this.ownG(new THREE.ConeGeometry(2.6, 2.8, 4))
    for (let i = 0; i < 4; i++) {
      const chev = new THREE.Mesh(chevGeo, this.arrowMat)
      chev.rotation.x = Math.PI; chev.rotation.y = Math.PI / 4
      chev.position.set(0, 6 - i * 2.3, R - 3); this.group.add(chev); this.arrowChevs.push(chev)
    }
  }

  private buildProps() {
    const R = this.radius
    const coreMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9b6bff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const coreGeo = this.ownG(new THREE.IcosahedronGeometry(1.6, 0))
    const cageMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.7, roughness: 0.4, emissive: 0x27e7ff, emissiveIntensity: 0.4 }))
    const cageGeo = this.ownG(new THREE.TorusGeometry(2.1, 0.12, 6, 16))
    // Tucked toward the rim on the sides so they accent the deck without blocking
    // the line-to-ledge sightline.
    for (const [ax, az] of [[-0.82, -0.2], [0.82, -0.2], [-0.82, 0.5], [0.82, 0.5]] as [number, number][]) {
      const core = new THREE.Mesh(coreGeo, coreMat); core.scale.setScalar(0.6); core.position.set(ax * R, 2.6, this.beltZ + az * R)
      this.group.add(core); this.cores.push(core)
      for (let k = 0; k < 2; k++) { const cage = new THREE.Mesh(cageGeo, cageMat); cage.scale.setScalar(0.6); cage.position.copy(core.position); cage.rotation.x = k * Math.PI / 2; this.group.add(cage) }
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
    const n = config.tier.name === 'low' ? 6 : 12
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2; const r = 60 + (i % 3) * 34
      const puff = new THREE.Sprite(mat); puff.position.set(Math.cos(a) * r, -34 - (i % 4) * 18, this.beltZ + Math.sin(a) * r); puff.scale.set(90, 54, 1); this.group.add(puff)
    }
  }

  private buildUnits() {
    const torsoGeo = this.ownG(new THREE.BoxGeometry(0.95, 1.1, 0.6))
    const headGeo = this.ownG(new THREE.BoxGeometry(0.55, 0.55, 0.55))
    const legGeo = this.ownG(new THREE.BoxGeometry(0.26, 0.95, 0.26))
    const armGeo = this.ownG(new THREE.BoxGeometry(0.22, 0.9, 0.22))
    const baseGeo = this.ownG(new THREE.BoxGeometry(0.9, 0.3, 0.7))
    const tints = [0x27e7ff, 0xff2bd0, 0x9dff5a, 0xffd24a, 0xb98cff, 0xff8a1e]
    const n = config.tier.name === 'low' ? 8 : 13
    for (let i = 0; i < n; i++) {
      const g = new THREE.Group()
      g.scale.setScalar(1.45)
      const col = tints[i % tints.length]
      // Self-illuminating in the unit's tint so robots pop against the dark deck
      // (scene lights alone left them camouflaged at distance).
      const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x5a6f96, emissive: col, emissiveIntensity: 0.55, metalness: 0.4, roughness: 0.5, transparent: true, opacity: 1 }))
      const headMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: col, emissiveIntensity: 2.4, roughness: 0.4, transparent: true, opacity: 1 }))
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
      const u = { g, parts, legL, legR, bodyMat, headMat, x: 0, z: 0, tx: 0, tz: 0, state: 'build' as const, v: 4.8 + Math.random() * 1.8, ph: Math.random() * 6.28, fallT: 0, wait: 0, lane: (Math.random() - 0.5) * 1.4 }
      this.units.push(u)
      // Seed a lively mix: most mid-build along the belt, a couple already finished
      // and walking the deck - so the instant you spawn you see robots being built
      // AND robots walking off to dive.
      if (i % 3 === 1) this.startWalker(u)
      else this.respawnUnit(u, this.beltX0 + (i / n) * this.lenX * 0.95)
    }
  }

  /** Drop a finished unit on the open deck in front of the line, already walking
   *  toward the ledge - used to seed visible foot traffic at startup. */
  private startWalker(u: LaunchPad['units'][number]) {
    for (const p of u.parts) p.visible = true
    u.bodyMat.opacity = 1; u.headMat.opacity = 1; u.headMat.emissiveIntensity = 2.4; u.bodyMat.emissiveIntensity = 0.55
    u.fallT = 0; u.wait = 0
    u.x = (Math.random() - 0.5) * this.radius * 0.8
    u.z = this.beltZ + 6 + Math.random() * (this.radius - this.beltZ - 12)
    u.g.rotation.set(0, 0, 0)
    u.g.position.set(u.x, 0, u.z) // local to the deck (group already sits at topY)
    this.headToEdge(u)
  }

  /** Send a unit on a straight walk to the ledge near its current lane, then dive. */
  private headToEdge(u: LaunchPad['units'][number]) {
    u.state = 'edge'
    u.tx = THREE.MathUtils.clamp(u.x, -this.radius * 0.55, this.radius * 0.55)
  }

  /** Reset a unit to the head of the belt to be built again. */
  private respawnUnit(u: LaunchPad['units'][number], x: number) {
    u.x = x; u.z = this.beltZ + u.lane; u.state = 'build'; u.fallT = 0; u.wait = 0
    u.g.position.set(u.x, 0.9, u.z) // sitting on the belt (local deck space)
    u.g.rotation.set(0, 0, 0)
    u.bodyMat.opacity = 1; u.headMat.opacity = 1; u.headMat.emissiveIntensity = 2.4; u.bodyMat.emissiveIntensity = 0.25
  }

  /** A random point on the deck in front of the line for a unit to wander to. */
  private wanderPoint(): { x: number; z: number } {
    return { x: (Math.random() - 0.5) * this.radius * 1.1, z: this.beltZ + 5 + Math.random() * (this.radius - this.beltZ - 11) }
  }

  update(dt: number, _x: number, _z: number) {
    this.t += dt
    for (const st of this.beltSeams) { st.position.x += 6 * dt; if (st.position.x > this.beltX1) st.position.x = this.beltX0 }
    for (const a of this.arms) {
      a.pivot.rotation.x = Math.sin(this.t * 2 + a.ph) * 0.5 - 0.3
      a.elbow.rotation.x = Math.sin(this.t * 3 + a.ph) * 0.6
      a.sparkMat.opacity = Math.max(0, Math.sin(this.t * 18 + a.ph)) * 0.85
      a.spark.scale.setScalar(1 + a.sparkMat.opacity * 0.9)
    }
    for (let i = 0; i < this.cores.length; i++) { const c = this.cores[i]; c.rotation.x += dt * 1.1; c.rotation.y += dt * 0.8; c.position.y = 3.4 + Math.sin(this.t * 1.4 + i) * 0.5 }
    this.arrowMat.opacity = 0.5 + Math.sin(this.t * 4) * 0.35
    for (let i = 0; i < this.arrowChevs.length; i++) this.arrowChevs[i].position.y = 6 - i * 2.3 - ((this.t * 3 + i) % 1) * 0.6

    const ledgeZ = this.radius - 2
    const lenX = this.lenX
    for (const u of this.units) {
      if (u.state === 'build') {
        u.x += (lenX / 5) * dt
        const f = THREE.MathUtils.clamp((u.x - this.beltX0) / lenX, 0, 1)
        u.parts[0].visible = true
        u.parts[1].visible = u.parts[2].visible = f > 0.15
        u.parts[3].visible = f > 0.38
        u.parts[4].visible = u.parts[5].visible = f > 0.58
        u.parts[6].visible = f > 0.78
        u.bodyMat.emissiveIntensity = 0.25 + f * 0.4 // "powers up" as it's assembled
        u.g.rotation.y = Math.PI / 2 // face along the belt (+x)
        u.g.position.set(u.x, 0.9, this.beltZ + u.lane)
        if (u.x >= this.beltX1) {
          for (const p of u.parts) p.visible = true; u.bodyMat.emissiveIntensity = 0.55
          u.z = this.beltZ + u.lane
          // Fresh off the line: most stroll out across the deck first (so you see
          // robots milling around), then head to the ledge and dive.
          if (Math.random() < 0.35) this.headToEdge(u)
          else { const w = this.wanderPoint(); u.tx = w.x; u.tz = w.z; u.state = 'wander'; u.wait = 0.4 + Math.random() * 1.2 }
        }
      } else if (u.state === 'wander' || u.state === 'edge') {
        const tx = u.tx
        const tz = u.state === 'edge' ? ledgeZ : u.tz
        const dx = tx - u.x, dz = tz - u.z, d = Math.hypot(dx, dz) || 1
        if (d > 0.4) {
          u.x += (dx / d) * u.v * dt; u.z += (dz / d) * u.v * dt
          u.g.rotation.y = Math.atan2(dx, dz)
          const sw = Math.sin(this.t * 8 + u.ph) * 0.5; u.legL.rotation.x = sw; u.legR.rotation.x = -sw
          u.g.position.set(u.x, Math.abs(Math.sin(this.t * 8 + u.ph)) * 0.06, u.z)
        } else if (u.state === 'edge') {
          u.state = 'fall'; u.fallT = 0
        } else {
          u.legL.rotation.x = 0; u.legR.rotation.x = 0
          u.wait -= dt
          u.g.position.set(u.x, 0, u.z)
          if (u.wait <= 0) {
            if (Math.random() < 0.85) this.headToEdge(u)
            else { const w = this.wanderPoint(); u.tx = w.x; u.tz = w.z; u.wait = 0.4 + Math.random() * 1.2 }
          }
        }
      } else {
        u.fallT += dt
        u.z += u.v * dt
        u.g.position.set(u.x, -0.5 * 9.8 * u.fallT * u.fallT * 0.6, u.z)
        u.g.rotation.x = Math.min(Math.PI / 2, u.fallT * 2.2)
        const o = Math.max(0, 1 - u.fallT * 0.8); u.bodyMat.opacity = o; u.headMat.opacity = o
        if (u.fallT > 2) this.respawnUnit(u, this.beltX0)
      }
    }
  }

  colliderBoxes(): THREE.Box3[] {
    const cx = (this.beltX0 + this.beltX1) / 2
    return [
      // The assembly line (belt + arms): walk around either end to reach the ledge.
      this.worldBox(cx, 1.6, this.beltZ, this.lenX / 2 + 1.5, 1.8, 5.5),
    ]
  }

  private worldBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): THREE.Box3 {
    const box = new THREE.Box3(); const v = new THREE.Vector3()
    for (let i = 0; i < 8; i++) { v.set(cx + (i & 1 ? hx : -hx), cy + (i & 2 ? hy : -hy), cz + (i & 4 ? hz : -hz)); v.applyMatrix4(this.group.matrixWorld); box.expandByPoint(v) }
    return box
  }

  /** Left the deck - off the edge of the (circular) floor, which the collider and
   *  this test now share a radius with, so there's no invisible lip to walk on. */
  steppedOff(x: number, y: number, z: number): boolean {
    const d = Math.hypot(x - this.center.x, z - this.center.z)
    if (d <= this.radius - 3) return false
    return y < this.topY - 1.5 || d > this.radius + 6
  }

  private deckTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#0e1626'; ctx.fillRect(0, 0, 256, 256)
    ctx.strokeStyle = 'rgba(20,40,70,0.9)'; ctx.lineWidth = 4
    for (let i = 0; i <= 256; i += 64) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke() }
    ctx.strokeStyle = 'rgba(39,231,255,0.22)'; ctx.lineWidth = 1.5
    for (let i = 0; i <= 256; i += 32) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke() }
    ctx.fillStyle = 'rgba(39,231,255,0.06)'
    for (const [px, py] of [[32, 96], [160, 32], [192, 192], [64, 192]]) ctx.fillRect(px, py, 60, 60)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(6, 6)
    return tex
  }

  private screenTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 160
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#04101a'; ctx.fillRect(0, 0, 256, 160)
    ctx.strokeStyle = '#27e7ff'; ctx.lineWidth = 2; ctx.strokeRect(8, 8, 240, 144)
    ctx.strokeStyle = '#9dff5a'; ctx.lineWidth = 3
    ctx.strokeRect(110, 40, 36, 44)
    ctx.strokeRect(116, 18, 24, 20)
    ctx.beginPath(); ctx.moveTo(110, 50); ctx.lineTo(92, 70); ctx.moveTo(146, 50); ctx.lineTo(164, 70); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(120, 84); ctx.lineTo(120, 112); ctx.moveTo(136, 84); ctx.lineTo(136, 112); ctx.stroke()
    ctx.fillStyle = '#27e7ff'; ctx.font = '700 16px monospace'; ctx.fillText('UNIT BUILD', 20, 30); ctx.fillText('OK', 200, 140)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  private signTex(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 384
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#070b14'; ctx.fillRect(0, 0, 1024, 384)
    ctx.fillStyle = 'rgba(39,231,255,0.05)'; for (let y = 0; y < 384; y += 6) ctx.fillRect(0, y, 1024, 2)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = '#ff2bd0'; ctx.shadowBlur = 30; ctx.fillStyle = '#ff2bd0'
    ctx.font = '900 150px ui-monospace, Menlo, monospace'; ctx.fillText('DROP ZONE', 512, 150)
    ctx.shadowColor = '#27e7ff'; ctx.shadowBlur = 18; ctx.fillStyle = '#bfefff'
    ctx.font = '800 62px ui-monospace, Menlo, monospace'; ctx.fillText('STEP OFF TO SKYDIVE  ▼', 512, 285)
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
