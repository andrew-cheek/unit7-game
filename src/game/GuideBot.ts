import * as THREE from 'three'

/**
 * A friendly greeter that onboards new players to the arcade. A slightly oversized
 * robot stands near spawn waving, with a glowing "FOLLOW ME" arrow on the ground
 * pointing at it. Walk up and it turns and walks you to the arcade entrance, then
 * waves you in. Purely cosmetic guidance - no collision, Earth only.
 */
export class GuideBot {
  readonly group = new THREE.Group()

  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private bot = new THREE.Group()
  private armPivot = new THREE.Group()
  private arrow = new THREE.Group()
  private arrowMat!: THREE.MeshBasicMaterial
  private label!: THREE.Sprite // speech bubble floating over the bot's head
  private beacon = new THREE.Group() // glowing ground ring + light beam so the bot reads from afar
  private beaconMats: THREE.Material[] = []

  private t = 0
  private phase: 'idle' | 'leading' | 'greeting' = 'idle'
  private done = false // latched once you reach the arcade, so the arrow stays gone
  private px: number; private pz: number // current bot ground position
  private readonly start: THREE.Vector2
  private readonly dest: THREE.Vector2 // arcade entrance
  private readonly arrowAt: THREE.Vector2
  private arrowGroundY = 0 // arrowAt's ground height, sampled once (it never moves)
  private getGround: (x: number, z: number) => number

  constructor(
    scene: THREE.Scene,
    getGround: (x: number, z: number) => number,
    opts: { start: THREE.Vector2; arcade: THREE.Vector2; arrowAt: THREE.Vector2 },
  ) {
    this.getGround = getGround
    this.start = opts.start.clone()
    this.dest = opts.arcade.clone()
    this.arrowAt = opts.arrowAt.clone()
    this.arrowGroundY = getGround(this.arrowAt.x, this.arrowAt.y) // static; sample once
    this.px = this.start.x
    this.pz = this.start.y

    const own = <T extends THREE.Material>(m: T) => { this.mats.push(m); return m }
    const ownG = <T extends THREE.BufferGeometry>(g: T) => { this.geos.push(g); return g }

    // --- the robot (built a bit bigger than a normal NPC so it stands out) ---
    const accent = 0x57ff9c
    const bodyMat = own(new THREE.MeshStandardMaterial({ color: 0x24304a, emissive: accent, emissiveIntensity: 0.35, metalness: 0.5, roughness: 0.4 }))
    const headMat = own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: accent, emissiveIntensity: 2.6, roughness: 0.4 }))

    const torso = new THREE.Mesh(ownG(new THREE.CapsuleGeometry(0.55, 1.1, 6, 12)), bodyMat)
    torso.position.y = 1.6
    this.bot.add(torso)
    const head = new THREE.Mesh(ownG(new THREE.BoxGeometry(0.62, 0.62, 0.62)), headMat)
    head.position.y = 2.55
    this.bot.add(head)
    const visor = new THREE.Mesh(ownG(new THREE.BoxGeometry(0.5, 0.16, 0.04)), own(new THREE.MeshBasicMaterial({ color: 0xeafff2, fog: false })))
    visor.position.set(0, 2.58, 0.32)
    this.bot.add(visor)
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(ownG(new THREE.BoxGeometry(0.34, 1.1, 0.34)), bodyMat)
      leg.position.set(sx * 0.3, 0.55, 0)
      this.bot.add(leg)
    }
    // Left arm hangs; right arm lives on a shoulder pivot so it can wave.
    const armGeo = ownG(new THREE.BoxGeometry(0.26, 1.0, 0.26))
    const leftArm = new THREE.Mesh(armGeo, bodyMat)
    leftArm.position.set(-0.78, 1.6, 0)
    this.bot.add(leftArm)
    this.armPivot.position.set(0.78, 2.1, 0) // right shoulder
    this.armPivot.rotation.order = 'YXZ' // aim the point: X tilts the arm up to horizontal, Y swings it onto the arcade bearing
    const rightArm = new THREE.Mesh(armGeo, bodyMat)
    rightArm.position.set(0, -0.5, 0) // hang down from the pivot
    this.armPivot.add(rightArm)
    const hand = new THREE.Mesh(ownG(new THREE.SphereGeometry(0.22, 10, 8)), own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: accent, emissiveIntensity: 2.0, roughness: 0.4 })))
    hand.position.set(0, -1.0, 0)
    this.armPivot.add(hand)
    this.bot.add(this.armPivot)
    this.bot.scale.setScalar(1.35) // oversized so the greeter clearly stands apart from NPC crowds
    this.group.add(this.bot)

    // --- beacon: a glowing ground ring + a soft light column, so the bot is an
    // unmistakable landmark from anywhere in the plaza (follows the bot if it walks) ---
    const beaconMat = (m: THREE.Material) => { this.beaconMats.push(m); return m }
    const ring = new THREE.Mesh(
      ownG(new THREE.RingGeometry(2.6, 3.2, 40)),
      beaconMat(new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.06
    this.beacon.add(ring)
    const beam = new THREE.Mesh(
      ownG(new THREE.CylinderGeometry(0.9, 1.9, 26, 18, 1, true)),
      beaconMat(new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })),
    )
    beam.position.y = 13
    this.beacon.add(beam)
    this.group.add(this.beacon)

    // --- ground arrow + FOLLOW ME label (additive, so it reads as lit neon) ---
    this.arrowMat = own(new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    // Points along +z in local space; the group's Y rotation aims it at the bot.
    const shaft = new THREE.Mesh(ownG(new THREE.PlaneGeometry(0.9, 3)), this.arrowMat)
    shaft.rotation.x = -Math.PI / 2
    shaft.position.z = 1.4
    this.arrow.add(shaft)
    const headTri = new THREE.Mesh(ownG(new THREE.CircleGeometry(1.3, 3)), this.arrowMat)
    headTri.rotation.x = -Math.PI / 2
    headTri.rotation.z = -Math.PI / 2 // point the triangle along +z
    headTri.position.z = 3.4
    this.arrow.add(headTri)
    this.group.add(this.arrow)

    // Speech bubble over the bot's head - it greets you and nudges you to the arcade.
    this.label = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: speechBubble('Want to play an', 'old-school game?', accent), transparent: true, opacity: 0, depthWrite: false, fog: false })) as THREE.SpriteMaterial)
    this.label.scale.set(9, 4.5, 1)
    this.group.add(this.label)

    scene.add(this.group)
  }

  /** Drive the guide: trigger leading when the player walks up, animate the wave /
   *  walk, and keep the arrow + label pointed at the bot (fading near the arcade). */
  update(dt: number, playerX: number, playerZ: number) {
    this.t += dt

    const dToBot = Math.hypot(playerX - this.px, playerZ - this.pz)
    // Only start leading once the player actually walks UP to the greeter (you land
    // ~7m away, so a smaller radius keeps it waving/greeting first instead of
    // marching off the instant you touch down).
    if (this.phase === 'idle' && dToBot < 4.5) this.phase = 'leading'

    let walking = false
    if (this.phase === 'leading') {
      const dx = this.dest.x - this.px
      const dz = this.dest.y - this.pz
      const dd = Math.hypot(dx, dz)
      if (dd < 1) this.phase = 'greeting'
      else {
        const step = Math.min(dd, 3.6 * dt)
        this.px += (dx / dd) * step
        this.pz += (dz / dd) * step
        this.bot.rotation.y = Math.atan2(dx, dz) // face the way it walks
        walking = true
      }
    }

    const gy = this.getGround(this.px, this.pz)
    if (walking) {
      this.bot.position.set(this.px, gy + Math.abs(Math.sin(this.t * 9)) * 0.14, this.pz)
      this.armPivot.rotation.set(0, 0, Math.sin(this.t * 9) * 0.5) // arm swings with the stride
    } else {
      // idle / greeting: face the player but POINT the right arm at the arcade so
      // the gesture, the speech bubble, and the ground arrow all say "go play".
      this.bot.position.set(this.px, gy + Math.abs(Math.sin(this.t * 2.4)) * 0.12, this.pz)
      this.bot.rotation.y = Math.atan2(playerX - this.px, playerZ - this.pz)
      const yawArcade = Math.atan2(this.dest.x - this.px, this.dest.y - this.pz)
      // X raises the arm to ~horizontal-and-up; Y (YXZ order) swings it onto the
      // arcade bearing in world space, minus the bot's own facing.
      this.armPivot.rotation.set(-Math.PI / 2 - 0.35 + Math.sin(this.t * 3) * 0.06, yawArcade - this.bot.rotation.y, 0)
    }

    // Beacon (ground ring + light column) tracks the bot's feet.
    this.beacon.position.set(this.px, gy, this.pz)

    // Speech bubble floats over the bot's head, bobbing gently (sprite billboards).
    this.label.position.set(this.px, gy + 5.6 + Math.sin(this.t * 2) * 0.12, this.pz)

    // Arrow sits near spawn and always points at the bot; pulse it, and fade it
    // out once the player has reached the arcade so it doesn't linger.
    const agy = this.arrowGroundY // cached: arrowAt never moves
    this.arrow.position.set(this.arrowAt.x, agy + 0.07, this.arrowAt.y)
    this.arrow.rotation.y = Math.atan2(this.px - this.arrowAt.x, this.pz - this.arrowAt.y)

    // Latch everything off once you actually REACH the arcade (proximity to the
    // entrance, not just a z line) and keep it off, so it doesn't glow back when you
    // walk out - and, crucially, doesn't pre-latch if you happened to land north of
    // it. Distance-based so any landing spot keeps the guide active until you arrive.
    if (Math.hypot(playerX - this.dest.x, playerZ - this.dest.y) < 10) this.done = true
    const pulse = 0.6 + Math.sin(this.t * 4) * 0.25
    const target = this.done ? 0 : pulse
    this.arrowMat.opacity = THREE.MathUtils.damp(this.arrowMat.opacity, target, 5, dt)
    // Bubble + beacon stay up while guiding (full strength, not the arrow's pulse),
    // then fade together once you've made it inside.
    const guideVis = THREE.MathUtils.damp((this.label.material as THREE.SpriteMaterial).opacity, this.done ? 0 : 1, 5, dt)
    ;(this.label.material as THREE.SpriteMaterial).opacity = guideVis
    ;(this.beaconMats[0] as THREE.MeshBasicMaterial).opacity = guideVis * (0.4 + Math.sin(this.t * 4) * 0.18)
    ;(this.beaconMats[1] as THREE.MeshBasicMaterial).opacity = guideVis * 0.16
  }

  dispose() {
    this.group.parent?.remove(this.group)
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
    this.beaconMats.forEach((m) => m.dispose())
    ;(this.label.material as THREE.SpriteMaterial).map?.dispose()
  }
}

/** A neon speech-bubble texture (rounded panel + tail) with up to two text lines. */
function speechBubble(line1: string, line2: string, color: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = 512; cv.height = 256
  const ctx = cv.getContext('2d')!
  const hex = '#' + color.toString(16).padStart(6, '0')
  // Rounded panel.
  const x = 24, y = 18, w = 464, h = 168, r = 30
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
  // Tail pointing down toward the bot's head.
  ctx.moveTo(236, y + h)
  ctx.lineTo(256, y + h + 46)
  ctx.lineTo(290, y + h)
  ctx.closePath()
  ctx.fillStyle = 'rgba(6,10,18,0.86)'
  ctx.fill()
  ctx.lineWidth = 5
  ctx.strokeStyle = hex
  ctx.shadowColor = hex
  ctx.shadowBlur = 22
  ctx.stroke()
  // Text.
  ctx.shadowBlur = 10
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillStyle = '#eafff2'
  ctx.font = '800 52px ui-monospace, Menlo, monospace'
  ctx.fillText(line1, 256, y + 58)
  ctx.fillText(line2, 256, y + 116)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
