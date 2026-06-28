import * as THREE from 'three'

/**
 * A subtle, tileable surface-detail NORMAL map, generated procedurally in code
 * (no image asset, in keeping with the procedural-first art pipeline). Its only
 * job is to break up the perfectly flat, even shading on the game's big
 * primitive faces — fine micro-noise plus a faint panel-seam grid — so walls and
 * ground read as a material catching light instead of an untextured solid. That
 * flat shading is one of the strongest "built from primitives" tells; a cheap
 * normal map removes it without any new geometry.
 *
 * Desktop ('high') only. It costs one extra texture fetch in the fragment shader
 * plus the VRAM for the map, both of which the mobile tiers skip (see
 * `QualityTier.surfaceDetail`). Returns a FRESH texture each call so the World
 * that creates it can own/dispose it on teardown — no shared-singleton that could
 * be disposed out from under a later zone rebuild.
 */
export function createDetailNormalMap(size = 256): THREE.DataTexture {
  // --- height field: a couple of octaves of tileable value noise + panel grooves
  const height = new Float32Array(size * size)

  // Seeded lattice so the look is deterministic frame-to-frame / build-to-build
  // (same discipline as createWindowTexture's seeded RNG).
  let s = 1
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
  const period = 32
  const lattice = new Float32Array(period * period)
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd()

  const smooth = (t: number) => t * t * (3 - 2 * t)
  // Tileable value noise: integer lattice wraps on `period`, so the result tiles.
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const x0 = ((xi % period) + period) % period
    const y0 = ((yi % period) + period) % period
    const x1 = (x0 + 1) % period
    const y1 = (y0 + 1) % period
    const a = lattice[y0 * period + x0]
    const b = lattice[y0 * period + x1]
    const c = lattice[y1 * period + x0]
    const d = lattice[y1 * period + x1]
    const u = smooth(xf)
    const v = smooth(yf)
    const top = a + (b - a) * u
    const bot = c + (d - c) * u
    return top + (bot - top) * v
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      let h = noise(u * period, v * period) * 0.6 + noise(u * period * 2, v * period * 2) * 0.25
      // Faint recessed panel seams on a 64px grid (tileable: triangle distance to
      // the nearest grid line on each axis). Reads as panel joints, not a glowing
      // grid — it only perturbs the normal, not the colour.
      const gx = Math.min(x % 64, 64 - (x % 64))
      const gy = Math.min(y % 64, 64 - (y % 64))
      if (gx < 2) h -= 0.5
      if (gy < 2) h -= 0.5
      height[y * size + x] = h
    }
  }

  // --- height -> tangent-space normal via wrapped central differences
  const data = new Uint8Array(size * size * 4)
  const strength = 2.2
  const at = (x: number, y: number) =>
    height[(((y % size) + size) % size) * size + (((x % size) + size) % size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength
      const nz = 1
      const len = Math.hypot(dx, dy, nz) || 1
      const i = (y * size + x) * 4
      data[i] = Math.round((dx / len) * 127.5 + 127.5)
      data[i + 1] = Math.round((dy / len) * 127.5 + 127.5)
      data[i + 2] = Math.round((nz / len) * 127.5 + 127.5)
      data[i + 3] = 255
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  // Normal maps are linear data, NOT colour — leave colorSpace as the DataTexture
  // default (NoColorSpace) so it isn't sRGB-decoded.
  tex.needsUpdate = true
  return tex
}
