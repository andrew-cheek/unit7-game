// Renders the OTHER players in the shared world: one tinted robot avatar with a
// floating name tag per connected player, smoothly interpolated toward the
// latest networked transform. Avatars are filtered by zone so you only see the
// players who are on the same world (earth / mars / moon) as you.
//
// For this first phase every remote player is drawn as the robot avatar even
// when they are piloting a vehicle (it is placed at their reported position),
// which keeps presence robust; vehicle-accurate remote avatars are a follow-up.

import * as THREE from 'three'
import { createRobot, type RobotModel } from './procedural'
import type { NetState, RemoteSnapshot } from './Net'
import type { Zone } from './types'

interface Remote {
  name: string
  model: RobotModel
  group: THREE.Group
  tag: THREE.Sprite
  tagMat: THREE.SpriteMaterial
  tagTex: THREE.CanvasTexture
  tagLabel: string // last-rendered tag text (so we only rebuild on change)
  accent: number // applied accent colour (so we only re-tint on change)
  pos: THREE.Vector3 // rendered (smoothed) position
  targetPos: THREE.Vector3 // latest from the network
  yaw: number
  targetYaw: number
  speed01: number
  grounded: boolean
  zone: Zone
}

// A spread of neon trims so players are visually distinct at a glance.
const TRIMS = [0x27e7ff, 0xff2bd0, 0x8a5cff, 0xff8a1e, 0x9bff4d, 0xffd24a, 0xff5c5c, 0x4affc1]

export class RemotePlayers {
  private scene: THREE.Scene
  private players = new Map<string, Remote>()
  private localZone: Zone = 'earth'

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  get count(): number {
    return this.players.size
  }

  setLocalZone(z: Zone) {
    this.localZone = z
  }

  private add(id: string, name: string) {
    if (this.players.has(id)) return
    const trim = TRIMS[hashId(id) % TRIMS.length]
    const model = createRobot({ trim, accent: trim })
    const group = new THREE.Group()
    group.add(model.group)
    const { sprite, mat, tex } = makeNameTag(name)
    group.add(sprite)
    this.scene.add(group)
    this.players.set(id, {
      name,
      model,
      group,
      tag: sprite,
      tagMat: mat,
      tagTex: tex,
      tagLabel: name,
      accent: -1,
      pos: new THREE.Vector3(),
      targetPos: new THREE.Vector3(),
      yaw: 0,
      targetYaw: 0,
      speed01: 0,
      grounded: true,
      zone: 'earth',
    })
  }

  remove(id: string) {
    const r = this.players.get(id)
    if (!r) return
    this.scene.remove(r.group)
    r.model.dispose()
    r.tagMat.dispose()
    r.tagTex.dispose()
    this.players.delete(id)
  }

  /** Add (if new) and snap a player to a roster snapshot, with no slide-in. */
  applySnapshot(s: RemoteSnapshot) {
    this.add(s.id, s.name)
    this.onState(s.id, s)
    const r = this.players.get(s.id)
    if (r) {
      r.pos.set(s.p[0], s.p[1], s.p[2])
      r.yaw = s.y
    }
  }

  /** Update a player's networked target transform. */
  onState(id: string, s: NetState) {
    const r = this.players.get(id)
    if (!r) return
    r.targetPos.set(s.p[0], s.p[1], s.p[2])
    r.targetYaw = s.y
    r.speed01 = s.s
    r.grounded = s.g
    r.zone = s.z
  }

  /**
   * Dress remote avatars from the room's profiles: tint each robot to its
   * owner's accent cosmetic and show "name · LVn · TIER" on the nametag. Only
   * re-tints / rebuilds the tag when something actually changed (canvas work).
   */
  applyProfiles(list: { id: string; name: string; accent: number; level: number; tier: string }[]) {
    for (const p of list) {
      const r = this.players.get(p.id)
      if (!r) continue
      if (p.accent !== r.accent) {
        r.model.setAccent(p.accent)
        r.accent = p.accent
      }
      const label = `${p.name}  LV${p.level}  ${p.tier.replace('CLASS ', '')}`
      if (label !== r.tagLabel) {
        drawNameTag(r.tagTex, label, p.accent)
        r.tagLabel = label
      }
    }
  }

  update(dt: number) {
    const k = 1 - Math.exp(-dt * 12) // ease rendered transform toward the target
    for (const r of this.players.values()) {
      const visible = r.zone === this.localZone
      r.group.visible = visible
      if (!visible) continue
      r.pos.lerp(r.targetPos, k)
      let dy = r.targetYaw - r.yaw
      while (dy > Math.PI) dy -= Math.PI * 2
      while (dy < -Math.PI) dy += Math.PI * 2
      r.yaw += dy * k
      r.group.position.copy(r.pos)
      r.model.group.rotation.y = r.yaw
      r.model.setFlyPose(r.grounded ? 0 : 0.7)
      r.model.setThrust(r.grounded ? 0 : 0.6)
      r.model.update(dt, r.speed01, r.grounded)
    }
  }

  dispose() {
    for (const id of [...this.players.keys()]) this.remove(id)
  }
}

function hashId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** A camera-facing label rendered to a canvas sprite, sits above the head. */
function makeNameTag(name: string): { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; tex: THREE.CanvasTexture } {
  const cv = document.createElement('canvas')
  cv.width = 256
  cv.height = 64
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  drawNameTag(tex, name, 0x27e7ff)
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false })
  const sprite = new THREE.Sprite(mat)
  sprite.position.set(0, 3.0, 0)
  sprite.scale.set(3.6, 0.9, 1)
  sprite.renderOrder = 10
  return { sprite, mat, tex }
}

/** (Re)draw a nametag onto its canvas texture: a dark pill with an accent-coloured
 *  border and the label (name + level + rank) in legible mono. */
function drawNameTag(tex: THREE.CanvasTexture, label: string, accent: number) {
  const cv = tex.image as HTMLCanvasElement
  const ctx = cv.getContext('2d')!
  const w = cv.width
  const h = cv.height
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(6,10,20,0.7)'
  roundRect(ctx, 5, 12, w - 10, 40, 14)
  ctx.fill()
  ctx.strokeStyle = '#' + (accent & 0xffffff).toString(16).padStart(6, '0')
  ctx.lineWidth = 2.5
  ctx.stroke()
  ctx.font = '700 22px ui-monospace, Menlo, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#eaf4ff'
  ctx.fillText(label, w / 2, 33, w - 20)
  tex.needsUpdate = true
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
