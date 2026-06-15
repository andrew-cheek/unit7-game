import * as THREE from 'three'

/** Clamp a number to [min, max]. */
export const clamp = (x: number, min: number, max: number) => (x < min ? min : x > max ? max : x)

/** Linear interpolation. */
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Frame-rate independent exponential smoothing toward a target. */
export function damp(current: number, target: number, lambda: number, dt: number) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt))
}

/** Shortest-path angular damp (handles wrap-around at ±π). */
export function dampAngle(current: number, target: number, lambda: number, dt: number) {
  let delta = (target - current) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return current + delta * (1 - Math.exp(-lambda * dt))
}

/** Damp a Vector3 toward a target in place. */
export function dampVec3(current: THREE.Vector3, target: THREE.Vector3, lambda: number, dt: number) {
  const t = 1 - Math.exp(-lambda * dt)
  current.x = lerp(current.x, target.x, t)
  current.y = lerp(current.y, target.y, t)
  current.z = lerp(current.z, target.z, t)
  return current
}

export const randRange = (min: number, max: number) => min + Math.random() * (max - min)
export const randInt = (min: number, max: number) => Math.floor(randRange(min, max + 1))
export const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

/** Deterministic-ish hash for stable per-index variation without Math.random. */
export function hash01(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

/**
 * Recursively dispose an object's geometries, materials and any textures the
 * materials reference. Used by the engine teardown so nothing leaks the GPU.
 */
export function disposeObject(root: THREE.Object3D) {
  root.traverse((obj: THREE.Object3D) => {
    const mesh = obj as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const material = (mesh as THREE.Mesh).material
    if (material) {
      if (Array.isArray(material)) material.forEach(disposeMaterial)
      else disposeMaterial(material)
    }
  })
}

export function disposeMaterial(material: THREE.Material) {
  const record = material as unknown as Record<string, unknown>
  for (const key of Object.keys(material)) {
    const value = record[key]
    if (value && (value as THREE.Texture).isTexture) {
      ;(value as THREE.Texture).dispose()
    }
  }
  material.dispose()
}

/** True when the device looks touch-primary (used to pick the control scheme). */
export function isTouchDevice() {
  if (typeof window === 'undefined') return false
  return (
    'ontouchstart' in window ||
    (navigator.maxTouchPoints ?? 0) > 0 ||
    window.matchMedia?.('(pointer: coarse)').matches
  )
}
