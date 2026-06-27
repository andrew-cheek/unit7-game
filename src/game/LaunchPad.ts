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
    g: THREE.Group; parts: THREE.Object3D[]; legL: THREE.Object3D; legR: THREE.Object3D
    wheel: THREE.Object3D | null; kind: 'biped' | 'roller'
    bodyMat: THREE.MeshStandardMaterial; headMat: THREE.MeshStandardMaterial
    x: number; z: number; tx: number; tz: number; state: 'build' | 'wander' | 'edge' | 'fall'
    v: number; ph: number; fallT: number; wait: number; lane: number
  }[] = []
  private arms: { pivot: THREE.Group; elbow: THREE.Group; spark: THREE.Mesh; sparkMat: THREE.MeshBasicMaterial; ph: number }[] = []
  private cores: THREE.Mesh[] = []
  private beltSeams: THREE.Mesh[] = []
  // Sci-fi props that animate.
  private drones: { g: THREE.Group; a: number; r: number; h: number; sp: number; rotors: THREE.Object3D[] }[] = []
  private holos: { o: THREE.Object3D; sp: number }[] = []
  private pylons: THREE.MeshBasicMaterial[] = []
  private cargo: { o: THREE.Object3D; ph: number; baseY: number }[] = []
  private rockets: { g: THREE.Group; flame: THREE.Mesh; flameMat: THREE.MeshBasicMaterial; glowMat: THREE.MeshBasicMaterial; smokeMat: THREE.SpriteMaterial; bx: number; bz: number; t: number; vy: number; y: number; ph: number }[] = []
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
    this.buildSciFi()
    this.buildRockets()
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

  /** Two rockets on launch gantries at the sides that ignite, shake and blast off
   *  on a staggered loop. */
  private buildRockets() {
    const R = this.radius
    const smokeTex = this.smokeTexture(); this.texs.push(smokeTex)
    const specs: { x: number; z: number; off: number; hull: number; accent: number }[] = [
      { x: -R * 0.66, z: this.beltZ + 2, off: 0, hull: 0xd8dee8, accent: 0x27e7ff },
      { x: R * 0.66, z: this.beltZ - 4, off: 6.5, hull: 0xc8ccd6, accent: 0xff7a2e },
    ]
    for (const s of specs) {
      const g = new THREE.Group(); g.position.set(s.x, 0, s.z)
      const hullMat = this.own(new THREE.MeshStandardMaterial({ color: s.hull, metalness: 0.5, roughness: 0.45 }))
      const accentMat = this.own(new THREE.MeshStandardMaterial({ color: 0x10151f, emissive: s.accent, emissiveIntensity: 1.1, roughness: 0.4 }))
      const darkMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1a2233, metalness: 0.7, roughness: 0.4 }))
      // Body, nose, engine bell, fins, accent band + window.
      const body = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.5, 1.7, 12, 16)), hullMat); body.position.y = 7; g.add(body)
      const nose = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(1.5, 3.4, 16)), hullMat); nose.position.y = 14.7; g.add(nose)
      const band = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.72, 1.72, 0.7, 16)), accentMat); band.position.y = 10.5; g.add(band)
      const win = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(0.5, 12)), accentMat); win.position.set(0, 12, 1.7); g.add(win)
      const bell = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.0, 1.7, 1.6, 16)), darkMat); bell.position.y = 0.6; g.add(bell)
      for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; const fin = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.3, 3, 2)), darkMat); fin.position.set(Math.cos(a) * 1.6, 2, Math.sin(a) * 1.6); fin.rotation.y = -a; g.add(fin) }
      // Engine flame (cone pointing down) + a bright glow disc, hidden until ignition.
      const flameMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffb24a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const flame = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(1.3, 5, 14)), flameMat); flame.rotation.x = Math.PI; flame.position.y = -2; g.add(flame)
      const glowMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff7a2e, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const glow = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(2.2, 12, 10)), glowMat); glow.position.y = -1.5; g.add(glow)
      this.group.add(g)
      // Static launch gantry tower beside it.
      const towerMat = this.own(new THREE.MeshStandardMaterial({ color: 0x232c40, metalness: 0.6, roughness: 0.45, emissive: 0x0c2030, emissiveIntensity: 0.4 }))
      const tower = new THREE.Group(); tower.position.set(s.x + 3.2, 0, s.z)
      for (const sx of [-0.9, 0.9]) { const leg = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.4, 16, 0.4)), towerMat); leg.position.set(sx, 8, 0); tower.add(leg) }
      for (let i = 0; i < 4; i++) { const rung = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(2.2, 0.25, 0.25)), towerMat); rung.position.set(0, 3 + i * 4, 0); tower.add(rung) }
      const arm = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(2.4, 0.3, 0.3)), towerMat); arm.position.set(-1.6, 11, 0); tower.add(arm)
      this.group.add(tower)
      // Ground smoke sprites at the base.
      const smokeMat = this.own(new THREE.SpriteMaterial({ map: smokeTex, color: 0xcdd6e2, transparent: true, opacity: 0, depthWrite: false, fog: false }))
      for (let i = 0; i < 5; i++) { const sp = new THREE.Sprite(smokeMat); sp.position.set(s.x + (Math.random() - 0.5) * 5, 0.6, s.z + (Math.random() - 0.5) * 5); sp.scale.set(6, 6, 1); this.group.add(sp) }
      this.rockets.push({ g, flame, flameMat, glowMat, smokeMat, bx: s.x, bz: s.z, t: s.off, vy: 0, y: 0, ph: s.off })
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

  // Shared low-poly part geometries (reused across every unit; only materials
  // differ per robot, so the variety is cheap).
  private ug = {
    torso: this.ownG(new THREE.BoxGeometry(0.95, 1.1, 0.6)),
    torsoSlim: this.ownG(new THREE.BoxGeometry(0.7, 1.25, 0.5)),
    headBox: this.ownG(new THREE.BoxGeometry(0.55, 0.55, 0.55)),
    headDome: this.ownG(new THREE.SphereGeometry(0.32, 10, 8)),
    leg: this.ownG(new THREE.BoxGeometry(0.26, 0.95, 0.26)),
    foot: this.ownG(new THREE.BoxGeometry(0.34, 0.18, 0.5)),
    arm: this.ownG(new THREE.BoxGeometry(0.22, 0.9, 0.22)),
    claw: this.ownG(new THREE.BoxGeometry(0.16, 0.32, 0.16)),
    hips: this.ownG(new THREE.BoxGeometry(0.9, 0.32, 0.7)),
    wheel: this.ownG(new THREE.CylinderGeometry(0.6, 0.6, 0.26, 16)),
    hub: this.ownG(new THREE.CylinderGeometry(0.18, 0.18, 0.3, 8)),
    fork: this.ownG(new THREE.BoxGeometry(0.22, 0.8, 0.22)),
    visor: this.ownG(new THREE.BoxGeometry(0.5, 0.13, 0.08)),
    eye: this.ownG(new THREE.BoxGeometry(0.1, 0.1, 0.06)),
    pad: this.ownG(new THREE.BoxGeometry(0.3, 0.22, 0.5)),
    core: this.ownG(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 12)),
    antenna: this.ownG(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 5)),
    tip: this.ownG(new THREE.SphereGeometry(0.07, 6, 5)),
    pack: this.ownG(new THREE.BoxGeometry(0.55, 0.7, 0.28)),
  }

  private buildUnits() {
    const tints = [0x27e7ff, 0xff2bd0, 0x9dff5a, 0xffd24a, 0xb98cff, 0xff8a1e, 0x4af0c0, 0xff5a7a]
    const n = config.tier.name === 'low' ? 8 : 13
    for (let i = 0; i < n; i++) {
      const col = tints[i % tints.length]
      const roller = i % 3 === 2          // every third unit rolls on wheels
      const humanoid = !roller && i % 2 === 0 // half-human variant for some bipeds
      const scale = 0.85 + ((i * 0.37) % 1) * 0.8 // 0.85 .. 1.65, deterministic spread
      const u = this.makeUnit(col, scale, roller ? 'roller' : 'biped', humanoid)
      this.units.push(u)
      // Seed a lively mix: most mid-build along the belt, a couple already finished
      // and walking the deck - so you see robots being built AND walking off to dive.
      if (i % 3 === 1) this.startWalker(u)
      else this.respawnUnit(u, this.beltX0 + (i / n) * this.lenX * 0.95)
    }
  }

  /** Build one varied robot: legs or wheels, with a visor, antenna, chest core,
   *  shoulder pads and a back module - some leaning humanoid. */
  private makeUnit(col: number, scale: number, kind: 'biped' | 'roller', humanoid: boolean) {
    const g = new THREE.Group(); g.scale.setScalar(1.45 * scale)
    const ug = this.ug
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: humanoid ? 0x8a93ab : 0x5a6f96, emissive: col, emissiveIntensity: 0.5, metalness: 0.4, roughness: 0.5, transparent: true, opacity: 1 }))
    const headMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: col, emissiveIntensity: 2.4, roughness: 0.4, transparent: true, opacity: 1 }))
    const darkMat = this.own(new THREE.MeshStandardMaterial({ color: 0x161d2e, metalness: 0.7, roughness: 0.4 }))

    const hips = new THREE.Mesh(ug.hips, bodyMat); hips.position.y = 0.32

    // Locomotion: legs (biped) or a wheel rig (roller).
    let legL: THREE.Object3D, legR: THREE.Object3D, wheel: THREE.Object3D | null = null
    if (kind === 'roller') {
      const rig = new THREE.Group()
      const w = new THREE.Group() // spun while moving
      for (const sx of [-0.42, 0.42]) {
        const tire = new THREE.Mesh(ug.wheel, darkMat); tire.rotation.z = Math.PI / 2; tire.position.x = sx; w.add(tire)
        const hub = new THREE.Mesh(ug.hub, headMat); hub.rotation.z = Math.PI / 2; hub.position.x = sx; w.add(hub)
      }
      w.position.y = 0.6; rig.add(w)
      const fork = new THREE.Mesh(ug.fork, darkMat); fork.position.y = 0.95; rig.add(fork)
      wheel = w; legL = rig; legR = new THREE.Group() // legR unused for rollers
      hips.position.y = 1.15
    } else {
      legL = new THREE.Mesh(ug.leg, bodyMat); legL.position.set(-0.22, 0.75, 0)
      legR = new THREE.Mesh(ug.leg, bodyMat); legR.position.set(0.22, 0.75, 0)
      for (const leg of [legL, legR]) { const foot = new THREE.Mesh(ug.foot, darkMat); foot.position.set(0, -0.52, 0.08); leg.add(foot) }
    }

    const torsoY = kind === 'roller' ? 2.0 : 1.75
    const torso = new THREE.Mesh(humanoid ? ug.torsoSlim : ug.torso, bodyMat); torso.position.y = torsoY
    const core = new THREE.Mesh(ug.core, headMat); core.rotation.x = Math.PI / 2; core.position.set(0, 0.05, (humanoid ? 0.26 : 0.31)); torso.add(core)
    for (const sx of [-0.62, 0.62]) { const pad = new THREE.Mesh(ug.pad, darkMat); pad.position.set(sx, 0.5, 0); torso.add(pad) }
    const pack = new THREE.Mesh(ug.pack, darkMat); pack.position.set(0, 0.1, -0.42); torso.add(pack)

    const armL = new THREE.Mesh(ug.arm, bodyMat); armL.position.set(-0.62, torsoY, 0)
    const armR = new THREE.Mesh(ug.arm, bodyMat); armR.position.set(0.62, torsoY, 0)
    // One hand is a little claw for character.
    for (const dx of [-0.07, 0.07]) { const cl = new THREE.Mesh(ug.claw, darkMat); cl.position.set(dx, -0.55, 0); armR.add(cl) }
    const hand = new THREE.Mesh(ug.tip, headMat); hand.scale.setScalar(1.6); hand.position.y = -0.5; armL.add(hand)

    const headY = torsoY + 0.85
    // Head shell is body-colored metal; the visor/eyes glow. Details parent to the
    // head so they only appear once the head is welded on.
    const headShell = new THREE.Mesh(humanoid ? ug.headDome : ug.headBox, bodyMat); headShell.position.y = headY
    const visor = new THREE.Mesh(ug.visor, headMat); visor.position.set(0, 0.02, humanoid ? 0.26 : 0.29); headShell.add(visor)
    if (humanoid) { for (const sx of [-0.12, 0.12]) { const e = new THREE.Mesh(ug.eye, headMat); e.position.set(sx, 0.03, 0.27); headShell.add(e) } }
    const ant = new THREE.Mesh(ug.antenna, darkMat); ant.position.set(0.18, 0.42, 0); headShell.add(ant)
    const tip = new THREE.Mesh(ug.tip, headMat); tip.position.set(0.18, 0.7, 0); headShell.add(tip)

    // parts[] drives the staged build reveal: [hips, loco, loco, torso, armL, armR, head]
    const parts: THREE.Object3D[] = [hips, legL, legR, torso, armL, armR, headShell]
    for (const p of parts) g.add(p)
    this.group.add(g)

    return {
      g, parts, legL, legR, wheel, kind, bodyMat, headMat,
      x: 0, z: 0, tx: 0, tz: 0, state: 'build' as const,
      v: (5.4 - scale * 1.2) + Math.random() * 1.2, ph: Math.random() * 6.28, fallT: 0, wait: 0, lane: (Math.random() - 0.5) * 1.4,
    }
  }

  /** Wild sci-fi set dressing around the deck: hover drones, hologram projectors,
   *  energy pylons and floating cargo. */
  private buildSciFi() {
    const R = this.radius, low = config.tier.name === 'low'
    // Hologram projectors to the sides: a pedestal beaming a rotating wireframe.
    const holoMat = this.own(new THREE.MeshBasicMaterial({ color: 0x36e0ff, wireframe: true, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const beamMat = this.own(new THREE.MeshBasicMaterial({ color: 0x36e0ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const padMat = this.own(new THREE.MeshStandardMaterial({ color: 0x141d30, metalness: 0.7, roughness: 0.4, emissive: 0x0c3050, emissiveIntensity: 0.6 }))
    const holoGeos = [this.ownG(new THREE.IcosahedronGeometry(1.5, 0)), this.ownG(new THREE.TorusKnotGeometry(0.9, 0.32, 48, 6))]
    const spots: [number, number, number][] = [[-R * 0.62, 6, 0], [R * 0.62, 6, 0]]
    spots.forEach((s, i) => {
      const ped = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.3, 1.6, 0.6, 16)), padMat); ped.position.set(s[0], 0.3, s[2]); this.group.add(ped)
      const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(1.4, 0.08, 8, 24)), this.own(new THREE.MeshBasicMaterial({ color: 0x36e0ff, fog: false }))); ring.rotation.x = -Math.PI / 2; ring.position.set(s[0], 0.65, s[2]); this.group.add(ring)
      const beam = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(1.3, 4.5, 16, 1, true)), beamMat); beam.position.set(s[0], 2.9, s[2]); this.group.add(beam)
      const holo = new THREE.Mesh(holoGeos[i % holoGeos.length], holoMat); holo.position.set(s[0], 3.4, s[2]); this.group.add(holo)
      this.holos.push({ o: holo, sp: i ? -0.6 : 0.8 })
    })

    // Energy pylons at the back corners: poles capped with a pulsing orb.
    const poleMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1a2336, metalness: 0.7, roughness: 0.4 }))
    for (const sx of [-R * 0.66, R * 0.66]) {
      const pole = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.35, 0.5, 9, 10)), poleMat); pole.position.set(sx, 4.5, -R * 0.5); this.group.add(pole)
      const cage = new THREE.Mesh(this.ownG(new THREE.IcosahedronGeometry(1.1, 0)), this.own(new THREE.MeshBasicMaterial({ color: 0x9b6bff, wireframe: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))); cage.position.set(sx, 9.4, -R * 0.5); this.group.add(cage); this.holos.push({ o: cage, sp: 1.4 })
      const orbMat = this.own(new THREE.MeshBasicMaterial({ color: 0xbf9bff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const orb = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.6, 12, 10)), orbMat); orb.position.set(sx, 9.4, -R * 0.5); this.group.add(orb); this.pylons.push(orbMat)
    }

    // Floating cargo pods scattered near the rim.
    const crateMat = this.own(new THREE.MeshStandardMaterial({ color: 0x223052, metalness: 0.6, roughness: 0.45, emissive: 0x16324f, emissiveIntensity: 0.5 }))
    const stripeMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const crateGeo = this.ownG(new THREE.BoxGeometry(2.4, 2.4, 2.4))
    const stGeo = this.ownG(new THREE.BoxGeometry(2.46, 0.18, 2.46))
    const cpos: [number, number][] = [[-R * 0.5, -R * 0.66], [R * 0.46, -R * 0.6], [-R * 0.72, R * 0.18], [R * 0.7, R * 0.2]]
    cpos.forEach(([cx, cz], i) => {
      const crate = new THREE.Group()
      const box = new THREE.Mesh(crateGeo, crateMat); crate.add(box)
      const st = new THREE.Mesh(stGeo, stripeMat); st.position.y = 0.4; crate.add(st)
      crate.scale.setScalar(0.7 + (i % 3) * 0.18); crate.rotation.y = i * 0.7
      const baseY = 1.6 + (i % 2) * 0.8
      crate.position.set(cx, baseY, cz); this.group.add(crate)
      // anti-grav glow under it
      const ag = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(1.6, 16)), this.own(new THREE.MeshBasicMaterial({ color: 0x36e0ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
      ag.rotation.x = -Math.PI / 2; ag.position.set(cx, 0.1, cz); this.group.add(ag)
      this.cargo.push({ o: crate, ph: i * 1.7, baseY })
    })

    // Hover drones that orbit the deck, bobbing, with spinning rotors and an eye.
    const droneBody = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.6, roughness: 0.4, emissive: 0x0c2030, emissiveIntensity: 0.6 }))
    const droneEye = this.own(new THREE.MeshBasicMaterial({ color: 0xff4a6a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const rotorMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const bodyGeo = this.ownG(new THREE.SphereGeometry(0.6, 10, 8))
    const eyeGeo = this.ownG(new THREE.SphereGeometry(0.16, 8, 6))
    const armGeo = this.ownG(new THREE.BoxGeometry(1.5, 0.06, 0.12))
    const rotorGeo = this.ownG(new THREE.CircleGeometry(0.34, 12))
    const nD = low ? 2 : 4
    for (let i = 0; i < nD; i++) {
      const d = new THREE.Group()
      const body = new THREE.Mesh(bodyGeo, droneBody); d.add(body)
      const eye = new THREE.Mesh(eyeGeo, droneEye); eye.position.set(0, 0, 0.55); d.add(eye)
      const rotors: THREE.Object3D[] = []
      for (let k = 0; k < 2; k++) { const a = new THREE.Mesh(armGeo, droneBody); a.rotation.y = k * Math.PI / 2; d.add(a) }
      for (const [rx, rz] of [[0.72, 0], [-0.72, 0], [0, 0.72], [0, -0.72]] as [number, number][]) {
        const r = new THREE.Mesh(rotorGeo, rotorMat); r.rotation.x = -Math.PI / 2; r.position.set(rx, 0.12, rz); d.add(r); rotors.push(r)
      }
      this.group.add(d)
      this.drones.push({ g: d, a: (i / nD) * Math.PI * 2, r: R * 0.5 + (i % 2) * 7, h: 9 + (i % 3) * 3, sp: 0.25 + (i % 2) * 0.12, rotors })
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
    // Sci-fi props.
    for (const h of this.holos) { h.o.rotation.y += h.sp * dt; h.o.rotation.x += h.sp * 0.4 * dt }
    for (const m of this.pylons) m.opacity = 0.45 + Math.sin(this.t * 3.2) * 0.4
    for (const c of this.cargo) { c.o.position.y = c.baseY + Math.sin(this.t * 1.2 + c.ph) * 0.3; c.o.rotation.y += 0.2 * dt }
    for (const d of this.drones) {
      d.a += d.sp * dt
      const cz = this.beltZ * 0.4
      d.g.position.set(Math.cos(d.a) * d.r, d.h + Math.sin(this.t * 1.5 + d.a) * 1.3, cz + Math.sin(d.a) * d.r)
      d.g.rotation.y = -d.a
      for (const r of d.rotors) r.rotation.z += dt * 40
    }
    // Launching rockets: idle -> ignite -> blast off on a staggered loop.
    const CYCLE = 13, IGNITE = 4.2, LIFT = 5.8
    for (const r of this.rockets) {
      r.t += dt
      if (r.t > CYCLE) { r.t -= CYCLE; r.y = 0; r.vy = 0 }
      let flame = 0, shake = 0, smoke = 0
      if (r.t < IGNITE) { flame = 0; r.y = 0 }
      else if (r.t < LIFT) { const f = (r.t - IGNITE) / (LIFT - IGNITE); flame = f; shake = f * 0.14; smoke = f }
      else { r.vy += 17 * dt; r.y += r.vy * dt; flame = 1; smoke = Math.max(0, 1 - (r.t - LIFT) * 0.5) }
      const flick = 0.7 + Math.abs(Math.sin(this.t * 38 + r.ph)) * 0.3
      r.flameMat.opacity = flame * flick * 0.95
      r.flame.scale.set(1, (0.85 + flame * 0.7) * flick, 1)
      r.glowMat.opacity = flame * 0.5 * flick
      r.smokeMat.opacity = smoke * 0.55
      r.g.position.set(r.bx + (Math.random() - 0.5) * shake, r.y, r.bz + (Math.random() - 0.5) * shake)
    }
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
        if (u.wheel) u.wheel.rotation.x -= dt * 2.2
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
          if (u.kind === 'roller') {
            if (u.wheel) u.wheel.rotation.x -= u.v * dt * 1.7
            u.g.position.set(u.x, 0, u.z)
          } else {
            const sw = Math.sin(this.t * 8 + u.ph) * 0.5; u.legL.rotation.x = sw; u.legR.rotation.x = -sw
            u.g.position.set(u.x, Math.abs(Math.sin(this.t * 8 + u.ph)) * 0.06, u.z)
          }
        } else if (u.state === 'edge') {
          u.state = 'fall'; u.fallT = 0
        } else {
          if (u.kind === 'biped') { u.legL.rotation.x = 0; u.legR.rotation.x = 0 }
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

  private smokeTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128
    const ctx = cv.getContext('2d')!
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,255,255,0.85)'); g.addColorStop(0.5, 'rgba(210,220,235,0.35)'); g.addColorStop(1, 'rgba(210,220,235,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128)
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
