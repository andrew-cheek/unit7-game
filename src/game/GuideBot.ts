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
  private label!: THREE.Sprite

  private t = 0
  private phase: 'idle' | 'leading' | 'greeting' = 'idle'
  private px: number; private pz: number // current bot ground position
  private readonly start: THREE.Vector2
  private readonly dest: THREE.Vector2 // arcade entrance
  private readonly arrowAt: THREE.Vector2
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
    this.px = this.start.x
    this.pz = this.start.y

    const own = <T extends THREE.Material>(m: T) => { this.mats.push(m); return m }
    const ownG = <T extends THREE.BufferGeometry>(g: T) => { this.geos.push(g); return g }

    // --- the robot (built a bit bigger than a normal NPC so it stands out) ---
    const accent = 0x57ff9c
    const bodyMat = own(new THREE.MeshStandardMaterial({ color: 0x1b2336, metalness: 0.5, roughness: 0.45 }))
    const headMat = own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: accent, emissiveIntensity: 1.6, roughness: 0.4 }))

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
    const rightArm = new THREE.Mesh(armGeo, bodyMat)
    rightArm.position.set(0, -0.5, 0) // hang down from the pivot
    this.armPivot.add(rightArm)
    const hand = new THREE.Mesh(ownG(new THREE.SphereGeometry(0.2, 10, 8)), own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: accent, emissiveIntensity: 1.2, roughness: 0.4 })))
    hand.position.set(0, -1.0, 0)
    this.armPivot.add(hand)
    this.bot.add(this.armPivot)
    this.group.add(this.bot)

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

    this.label = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: neonText('FOLLOW ME', accent), transparent: true, opacity: 0, depthWrite: false, fog: false })) as THREE.SpriteMaterial)
    this.label.scale.set(8, 3, 1)
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
      this.armPivot.rotation.z = Math.sin(this.t * 9) * 0.5 // arm swings with the stride
    } else {
      // idle / greeting: face the player and wave the raised arm
      this.bot.position.set(this.px, gy + Math.abs(Math.sin(this.t * 2.4)) * 0.12, this.pz)
      this.bot.rotation.y = Math.atan2(playerX - this.px, playerZ - this.pz)
      this.armPivot.rotation.z = 2.3 + Math.sin(this.t * 8) * 0.4 // up + waving
    }

    // Arrow sits near spawn and always points at the bot; pulse it, and fade it
    // out once the player has reached the arcade so it doesn't linger.
    const agy = this.getGround(this.arrowAt.x, this.arrowAt.y)
    this.arrow.position.set(this.arrowAt.x, agy + 0.07, this.arrowAt.y)
    this.arrow.rotation.y = Math.atan2(this.px - this.arrowAt.x, this.pz - this.arrowAt.y)
    this.label.position.set(this.arrowAt.x, agy + 3.4, this.arrowAt.y)

    // Fade the arrow only once the player is actually INSIDE the arcade hall (its
    // front door is at z~28), not merely near the lead target - otherwise it
    // vanishes the instant you land in the plaza (you touch down close to it).
    const insideArcade = playerZ > 32
    const pulse = 0.6 + Math.sin(this.t * 4) * 0.25
    const target = insideArcade ? 0 : pulse
    this.arrowMat.opacity = THREE.MathUtils.damp(this.arrowMat.opacity, target, 5, dt)
    ;(this.label.material as THREE.SpriteMaterial).opacity = Math.min(1, this.arrowMat.opacity * 1.6)
  }

  dispose() {
    this.group.parent?.remove(this.group)
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
    ;(this.label.material as THREE.SpriteMaterial).map?.dispose()
  }
}

/** A glowing neon text texture for the floating label. */
function neonText(text: string, color: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = 256; cv.height = 96
  const ctx = cv.getContext('2d')!
  ctx.font = '800 52px ui-monospace, Menlo, monospace'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.shadowColor = '#' + color.toString(16).padStart(6, '0')
  ctx.shadowBlur = 18
  ctx.fillStyle = '#eafff2'
  ctx.fillText(text, 128, 48)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
