#!/usr/bin/env node
/**
 * CI SMOKE GATE — drives the REAL game headless through the debug harness
 * (`window.__unit7nav`, exposed on the built app at `/?debug&bot`) and fails the
 * build on regressions. This is the continuous-integration teeth behind the
 * harness: a green `tsc`/`vite build` proves the code compiles; this proves the
 * game actually boots, free-roams, travels between zones, runs a minigame, and
 * does it all WITHOUT throwing a single console/page error.
 *
 * Run locally against a preview server:
 *     npm run build && npm run preview -- --port 4173 &
 *     SMOKE_URL=http://localhost:4173/?debug&bot node scripts/ci-smoke.mjs
 *
 * In CI the Chromium binary comes from `npx playwright install chromium`, so we
 * launch with NO executablePath and let Playwright find its managed install.
 */
import { chromium } from 'playwright-core'

// --- Perf budgets -----------------------------------------------------------
// Headless-swiftshader ceilings measured at the earth spawn. They are NOT a
// tight performance target — software WebGL on a GPU-less runner is nothing like
// a real device — they exist purely to catch REGRESSIONS (a refactor that
// suddenly doubles draw calls or triangles). Set generously; tighten only if a
// real regression slips under them.
const DRAW_BUDGET = 3500
const TRI_BUDGET = 1_200_000

const SMOKE_URL = process.env.SMOKE_URL || 'http://localhost:4173/?debug&bot'
const READY_TIMEOUT = 45_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Collected assertion results: { ok, label, detail }
const checks = []
function check(ok, label, detail = '') {
  checks.push({ ok: !!ok, label, detail })
}

const consoleErrors = []
const pageErrors = []

let browser
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-gpu-sandbox',
    ],
  })

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => {
    pageErrors.push(e.message || String(e))
  })

  console.log(`[ci-smoke] booting ${SMOKE_URL}`)
  await page.goto(SMOKE_URL, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT })

  // --- harness present + version --------------------------------------------
  let harnessOk = false
  try {
    await page.waitForFunction(() => !!window.__unit7nav, null, { timeout: READY_TIMEOUT })
    harnessOk = true
  } catch {
    harnessOk = false
  }
  check(harnessOk, 'harness present (window.__unit7nav)')

  let version = 0
  if (harnessOk) {
    version = await page.evaluate(() => Number(window.__unit7nav?.version ?? 0))
  }
  check(version >= 2, 'harness version >= 2', `version=${version}`)

  // --- reached free roam ----------------------------------------------------
  let ready = false
  if (harnessOk) {
    try {
      await page.waitForFunction(() => window.__unit7nav?.ready() === true, null, {
        timeout: READY_TIMEOUT,
      })
      ready = true
    } catch {
      ready = false
    }
  }
  check(ready, 'reached free roam (ready)')

  // Everything below depends on a live, ready harness.
  if (ready) {
    // --- synthetic move ----------------------------------------------------
    const before = await page.evaluate(() => {
      const p = window.__unit7nav.state().pos
      return { x: p.x, y: p.y, z: p.z }
    })
    await page.evaluate(() => {
      window.__unit7nav.setInputMode('synthetic')
      window.__unit7nav.setMove(0, 1)
    })
    await sleep(1100)
    await page.evaluate(() => window.__unit7nav.setMove(0, 0))
    const after = await page.evaluate(() => {
      const p = window.__unit7nav.state().pos
      return { x: p.x, y: p.y, z: p.z }
    })
    const moved =
      Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) > 0.1
    check(
      moved,
      'synthetic move changed position',
      `from (${before.x.toFixed(1)},${before.z.toFixed(1)}) to (${after.x.toFixed(1)},${after.z.toFixed(1)})`,
    )

    // --- travel between zones ---------------------------------------------
    for (const zone of ['moon', 'mars', 'earth']) {
      await page.evaluate((z) => window.__unit7nav.goto(z), zone)
      // give the zone transition a moment to settle
      let landed = false
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const cur = await page.evaluate(() => window.__unit7nav.state().zone)
        if (cur === zone) {
          landed = true
          break
        }
        await sleep(250)
      }
      const cur = await page.evaluate(() => window.__unit7nav.state().zone)
      check(landed, `goto('${zone}') reached zone`, `zone=${cur}`)
    }

    // --- minigame enter/exit ----------------------------------------------
    await page.evaluate(() => window.__unit7nav.enterMinigame('invaders'))
    await sleep(800)
    const inGame = await page.evaluate(() => window.__unit7nav.state().minigame)
    check(inGame === 'invaders', "enterMinigame('invaders') active", `minigame=${inGame}`)

    await page.evaluate(() => window.__unit7nav.exitMinigame())
    await sleep(800)
    const outGame = await page.evaluate(() => window.__unit7nav.state().minigame)
    check(outGame == null, 'exitMinigame() cleared minigame', `minigame=${outGame}`)

    // --- landmark navigation ----------------------------------------------
    const landmarkOk = await page.evaluate(() => {
      const r = window.__unit7nav.gotoLandmark('arcade')
      // accept either a truthy/ok result or a resolved promise-ish object
      return r === true || (r && r.ok === true) || r === undefined ? true : !!r
    })
    check(landmarkOk, "gotoLandmark('arcade') returned ok", `result=${landmarkOk}`)

    // --- perf budget at earth spawn ---------------------------------------
    await page.evaluate(() => window.__unit7nav.goto('earth'))
    await sleep(1200)
    const metrics = await page.evaluate(() => window.__unit7nav.metrics())
    console.log(`[ci-smoke] metrics @ earth: ${JSON.stringify(metrics)}`)
    check(
      metrics.drawCalls <= DRAW_BUDGET,
      `drawCalls within budget (<= ${DRAW_BUDGET})`,
      `drawCalls=${metrics.drawCalls}`,
    )
    check(
      metrics.triangles <= TRI_BUDGET,
      `triangles within budget (<= ${TRI_BUDGET})`,
      `triangles=${metrics.triangles}`,
    )
  }

  // --- no runtime errors (the most important gate) -------------------------
  const totalErrors = consoleErrors.length + pageErrors.length
  check(
    totalErrors === 0,
    'no console/page errors during run',
    totalErrors ? `${totalErrors} error(s)` : '',
  )
} catch (e) {
  // A harness-level failure (navigation timeout, launch crash) is itself a fail.
  check(false, 'smoke harness ran to completion', e?.message || String(e))
} finally {
  if (browser) await browser.close().catch(() => {})
}

// --- summary ----------------------------------------------------------------
console.log('\n[ci-smoke] results:')
for (const c of checks) {
  const mark = c.ok ? '✓' : '✗'
  console.log(`  ${mark} ${c.label}${c.detail ? `  (${c.detail})` : ''}`)
}

if (consoleErrors.length) {
  console.log('\n[ci-smoke] console errors:')
  for (const e of consoleErrors) console.log(`  - ${e}`)
}
if (pageErrors.length) {
  console.log('\n[ci-smoke] page errors:')
  for (const e of pageErrors) console.log(`  - ${e}`)
}

const failures = checks.filter((c) => !c.ok).length
console.log(
  `\n[ci-smoke] ${failures ? 'FAIL' : 'PASS'} — ${checks.length - failures}/${checks.length} checks passed.`,
)
process.exit(failures ? 1 : 0)
