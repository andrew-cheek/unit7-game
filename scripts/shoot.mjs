// Headless VISUAL-verification harness (companion to smoke.mjs, which only checks
// for boot crashes). Boots the DEV game (window.__unit7 is exposed in dev), drives
// it via that debug handle, and screenshots a scenario to .shots/ so changes to the
// camera, drop-in, guide bot, world edge, etc. can actually be eyeballed.
//   1. npm run dev            (in another shell)
//   2. SCENE=spawn|spawn_far|rim|rimtest|dive|canopy|underroad|at node scripts/shoot.mjs
// playwright-core is a devDependency; the pre-installed Chromium is used via EXE.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

let chromium
try { ({ chromium } = await import('playwright-core')) } catch {
  console.error('[shoot] playwright-core not installed. Run: npm i -D playwright-core'); process.exit(2)
}

const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const URL = (process.env.URL || 'http://127.0.0.1:5173/') + '?time=20' // full daylight
const OUT = process.env.OUT || join(process.cwd(), '.shots')
const SCENE = process.env.SCENE || 'spawn'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await mkdir(OUT, { recursive: true })
const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message))

await page.goto(URL, { waitUntil: 'load', timeout: 60000 })
await sleep(1500)
// Click "Play Solo".
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /play solo/i.test(x.textContent || '')); if (b) b.click() })
await sleep(1200)
// Wait for the game handle.
await page.waitForFunction(() => !!window.__unit7, { timeout: 20000 }).catch(() => {})

const shot = async (name) => { await page.screenshot({ path: join(OUT, name + '.png') }); console.log('shot', name) }
const ev = (fn, arg) => page.evaluate(fn, arg)
const skip = async () => {
  // Skip the opening, then WAIT for the handoff to free roam (dropIn cleared).
  await ev(() => { const g = window.__unit7; g.intro?.skip?.(); g.dropIn?.skip?.() })
  await page.waitForFunction(() => { const g = window.__unit7; return g && !g.dropIn && !g.intro }, { timeout: 20000 }).catch(() => {})
  await sleep(600)
}
// Firmly drop the player at x,z looking along yaw, zero velocity, settle, re-affirm.
const place = async (x, z, yaw, pitch = 0.1) => {
  for (let i = 0; i < 2; i++) {
    await ev(([x, z, yaw, pitch]) => {
      const g = window.__unit7
      const gy = (g.physics.sampleGround(x, z, 200)?.y ?? 0) + 1
      g.player.position.set(x, gy, z)
      g.player.velocity.set(0, 0, 0)
      g.input.yaw = yaw; g.input.pitch = pitch
      g.player.resetInterp?.() // sync render anchors so the teleport sticks (not lerped back)
      g.camera.snap(g.player.position)
    }, [x, z, yaw, pitch])
    await sleep(700)
  }
}

if (SCENE === 'dive') {
  // Don't skip: capture the opening drop-in (portals + descent).
  await sleep(1500); await shot('dive_1')
  await sleep(2500); await shot('dive_2')
  const st = await ev(() => { const d = window.__unit7.dropIn; return d ? { phase: d.hud?.phase, alt: Math.round(d.hud?.alt), nPlatforms: d.platforms?.length } : 'no dropIn' })
  console.log('dive state', JSON.stringify(st))
} else if (SCENE === 'canopy') {
  await sleep(1800)
  await ev(() => window.__unit7.dropIn?.deploy?.()) // pop the chute
  await sleep(1600); await shot('canopy_1')
  await sleep(1200); await shot('canopy_2')
} else if (SCENE === 'spawn') {
  await skip(); await sleep(800)
  // Stand south of the guide (bot ~(3,14), arrow (0,6)) and look north (+z) at it.
  await place(0, -6, 0, 0.08)
  await shot('spawn')
  const info = await ev(() => { const g = window.__unit7; return { pos: g.player.position.toArray().map((n) => Math.round(n)) } })
  console.log('spawn info', JSON.stringify(info))
} else if (SCENE === 'spawn_far') {
  await skip(); await sleep(800)
  await place(0, -22, 0, 0.16) // pulled back to see the whole guide + arrow
  await shot('spawn_far')
} else if (SCENE === 'rim') {
  await skip(); await sleep(800)
  // Stand just inside the rim looking outward (+x) at the blob ring.
  await place(190, 0, Math.PI / 2, 0.04)
  await shot('rim')
} else if (SCENE === 'rimtest') {
  await skip()
  // Shove the player past the rim and confirm the boundary clamps + bounces.
  const before = await ev(() => { const g = window.__unit7; g.player.position.set(260, 30, 0); g.player.velocity.set(40, 0, 0); return g.player.position.toArray().map((n) => Math.round(n)) })
  await sleep(1200)
  const after = await ev(() => { const g = window.__unit7; return { pos: g.player.position.toArray().map((n) => Math.round(n)), vel: g.player.velocity.toArray().map((n) => Math.round(n)) } })
  console.log('rimtest before', JSON.stringify(before), 'after', JSON.stringify(after))
  await shot('rimtest')
} else if (SCENE === 'at') {
  await skip(); await sleep(800)
  await place(Number(process.env.AX || 0), Number(process.env.AZ || 0), Number(process.env.AYAW || 0), Number(process.env.APITCH || 0.1))
  await shot('at')
  const info = await ev(() => { const g = window.__unit7; return { pos: g.player.position.toArray().map((n) => Math.round(n)) } })
  console.log('at info', JSON.stringify(info))
} else if (SCENE === 'guide') {
  await skip()
  // Dismiss any welcome / multiplayer prompt so it doesn't cover the bot.
  await ev(() => { const b = [...document.querySelectorAll('button')].find((x) => /roam|play solo/i.test(x.textContent || '')); if (b) b.click() })
  await sleep(3600) // let the TOUCHDOWN banner fade
  // Stand a little south-east of the guide (bot at (0,27)) and aim up at it, so
  // the bubble, the pointing arm, and the beacon all frame cleanly.
  await place(9, 17, Math.atan2(-9, 10), 0.28)
  await sleep(800)
  await shot('guide')
} else if (SCENE === 'underroad') {
  await skip(); await sleep(800)
  await place(Number(process.env.UX || 0), Number(process.env.UZ || -120), Math.PI, 0.12)
  await shot('underroad')
}

if (errs.length) console.log('CONSOLE ERRORS:\n' + errs.slice(0, 8).join('\n'))
await browser.close()
process.exit(0)
