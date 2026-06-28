#!/usr/bin/env node
/**
 * PER-TIER PERF SWEEP — a render-cost regression catcher across EVERY quality
 * tier (low / medium / high) and EVERY zone (earth / moon / mars).
 *
 * Unit 7 ships three render paths, not one (see CLAUDE.md "Non-negotiable:
 * quality tiers"). A change that's free on the high tier can blow the mobile
 * (low) budget — so a single-tier smoke gate (ci-smoke.mjs) can't see per-device
 * regressions. This sweep forces each tier via `?tier=low|medium|high` (detectTier
 * honors it), hard-swaps through all three zones, and records the GPU work the
 * scene submits at each (tier, zone): draw calls, triangles, geometries, textures,
 * renderScale.
 *
 * WHAT IS MEANINGFUL HERE:
 *   The COUNTS — drawCalls, triangles, geometries, textures — are the real,
 *   hardware-independent signal. They are the same on a CI runner, a laptop, or a
 *   phone, because they describe what the scene graph asks the GPU to do, not how
 *   fast a particular GPU does it. A refactor that doubles draw calls shows up here
 *   identically everywhere.
 *
 * WHAT IS NOT MEANINGFUL HERE:
 *   The absolute frame TIMES (avgMs/p95/fps from perfSample) under headless
 *   software WebGL (swiftshader, no GPU) are nothing like real-device numbers. We
 *   capture one earth perfSample per tier purely for DRIFT VISIBILITY in CI history
 *   (a refactor that doubles frame time on the SAME runner is visible relative to
 *   the committed baseline) — they are NEVER a pass/fail gate.
 *
 * The budgets below are generous regression catchers, NOT hardware targets. They
 * sit well above measured swiftshader counts so normal content tweaks don't trip
 * them; tighten only when a real regression slips under.
 *
 * Run locally against a preview server:
 *     npm run build && npm run preview -- --port 4173 &
 *     SWEEP_URL=http://localhost:4173 node scripts/perf-sweep.mjs
 *   (a system Chromium can be used via SMOKE_CHROME=/path/to/chrome)
 *
 * In CI the Chromium binary comes from `npx playwright install chromium`, so we
 * launch with NO executablePath (SMOKE_CHROME unset) and let Playwright find its
 * managed install. Exit non-zero on any budget breach or unexpected runtime error.
 */
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = join(__dirname, 'perf-baseline.json')

const BASE_URL = (process.env.SWEEP_URL || 'http://localhost:4173').replace(/\/+$/, '')
const READY_TIMEOUT = 45_000
const ZONE_TIMEOUT = 15_000
const SETTLE_MS = 1200
const PERF_SAMPLE_MS = 1500

const TIERS = ['low', 'medium', 'high']
const ZONES = ['earth', 'moon', 'mars']

// --- Per-tier soft regression gates -----------------------------------------
// Generous ceilings, chosen with healthy headroom over what the swiftshader
// runner actually submits, scaled by tier (low has aggressive culling / no accent
// lights, high has full particle & light counts). These exist ONLY to catch a
// refactor that suddenly multiplies the scene's GPU work — they are NOT a
// statement about real-device performance.
const BUDGETS = {
  low: { draws: 2200, triangles: 700_000 },
  medium: { draws: 3000, triangles: 1_000_000 },
  high: { draws: 4000, triangles: 1_600_000 },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Collected gate results: { ok, label, detail }
const checks = []
function check(ok, label, detail = '') {
  checks.push({ ok: !!ok, label, detail })
}

const consoleErrors = []
const pageErrors = []

// Full structured results, written to perf-baseline.json at the end.
const results = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  note:
    'Per-tier render-cost regression baseline. The COUNTS (drawCalls, triangles, ' +
    'geometries, textures) are the meaningful, hardware-independent signal. Absolute ' +
    'frame times under headless swiftshader are meaningless vs real hardware and are ' +
    'recorded for drift visibility only, never gated.',
  budgets: BUDGETS,
  tiers: {}, // tier -> { zones: { zone -> metrics }, perfSample }
}

let browser
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SMOKE_CHROME || undefined,
    args: [
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-gpu-sandbox',
    ],
  })

  for (const tier of TIERS) {
    const url = `${BASE_URL}/?tier=${tier}&debug&bot`
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()

    // Tag captured errors with the tier so the summary points at the culprit.
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`[${tier}] ${m.text()}`)
    })
    page.on('pageerror', (e) => {
      pageErrors.push(`[${tier}] ${e.message || String(e)}`)
    })

    const tierResult = { url, zones: {}, perfSample: null }
    results.tiers[tier] = tierResult

    console.log(`\n[perf-sweep] booting tier=${tier} ${url}`)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT })

      // Wait for harness + free roam.
      let ready = false
      try {
        await page.waitForFunction(() => !!window.__unit7nav, null, { timeout: READY_TIMEOUT })
        await page.waitForFunction(() => window.__unit7nav?.ready() === true, null, {
          timeout: READY_TIMEOUT,
        })
        ready = true
      } catch {
        ready = false
      }
      check(ready, `tier=${tier}: reached free roam (ready)`)

      if (ready) {
        // Sweep every zone with a hard swap, settle, then capture counts.
        for (const zone of ZONES) {
          await page.evaluate((z) => window.__unit7nav.goto(z), zone)
          // Wait for the zone transition to actually land before settling.
          const deadline = Date.now() + ZONE_TIMEOUT
          let landed = false
          while (Date.now() < deadline) {
            const cur = await page.evaluate(() => window.__unit7nav.metrics().zone)
            if (cur === zone) {
              landed = true
              break
            }
            await sleep(250)
          }
          await sleep(SETTLE_MS)

          const metrics = await page.evaluate(() => window.__unit7nav.metrics())
          tierResult.zones[zone] = metrics
          check(landed, `tier=${tier}: goto('${zone}') reached zone`, `zone=${metrics.zone}`)

          // Apply the per-tier draw + triangle budgets as soft regression gates.
          const budget = BUDGETS[tier]
          check(
            metrics.drawCalls <= budget.draws,
            `tier=${tier} zone=${zone}: drawCalls <= ${budget.draws}`,
            `drawCalls=${metrics.drawCalls}`,
          )
          check(
            metrics.triangles <= budget.triangles,
            `tier=${tier} zone=${zone}: triangles <= ${budget.triangles}`,
            `triangles=${metrics.triangles}`,
          )
        }

        // One earth frame-time sample per tier (drift visibility only, not gated).
        await page.evaluate((z) => window.__unit7nav.goto(z), 'earth')
        await sleep(SETTLE_MS)
        const perf = await page.evaluate(async (ms) => {
          if (typeof window.__unit7nav.perfSample !== 'function') return null
          return window.__unit7nav.perfSample(ms)
        }, PERF_SAMPLE_MS)
        tierResult.perfSample = perf
        if (perf) {
          console.log(`[perf-sweep] perfSample @ earth tier=${tier}: ${JSON.stringify(perf.perf)}`)
        } else {
          console.log(`[perf-sweep] perfSample not available on this build (tier=${tier})`)
        }
      }
    } catch (e) {
      check(false, `tier=${tier}: sweep ran to completion`, e?.message || String(e))
    } finally {
      await context.close().catch(() => {})
    }
  }
} catch (e) {
  // A launch-level failure is itself a failure.
  check(false, 'perf-sweep harness ran to completion', e?.message || String(e))
} finally {
  if (browser) await browser.close().catch(() => {})
}

// --- Filter console/page errors ---------------------------------------------
// Local `vite preview` has no Netlify Functions, so the app's calls to those
// endpoints 404. Those are expected in local preview and must NOT fail the gate.
const isKnownLocal404 = (msg) =>
  /Failed to load resource/i.test(msg) || /\b404\b/.test(msg)
const realConsoleErrors = consoleErrors.filter((m) => !isKnownLocal404(m))
const realPageErrors = pageErrors.filter((m) => !isKnownLocal404(m))
const ignoredErrors = consoleErrors.length + pageErrors.length -
  (realConsoleErrors.length + realPageErrors.length)

check(
  realConsoleErrors.length + realPageErrors.length === 0,
  'no unexpected console/page errors during run',
  `real=${realConsoleErrors.length + realPageErrors.length}, ignored-local-404s=${ignoredErrors}`,
)

results.consoleErrors = realConsoleErrors
results.pageErrors = realPageErrors
results.ignoredLocal404Count = ignoredErrors

// --- Readable per-tier x per-zone table -------------------------------------
function pad(s, n) {
  s = String(s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}
function padNum(v, n) {
  const s = v == null ? '-' : String(v)
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

console.log('\n[perf-sweep] render-cost table (counts are the hardware-independent signal):')
console.log(
  `  ${pad('tier', 7)}${pad('zone', 7)}${padNum('draws', 8)}${padNum('triangles', 12)}${padNum('geoms', 8)}${padNum('textures', 10)}${padNum('rScale', 9)}`,
)
console.log(`  ${'-'.repeat(7 + 7 + 8 + 12 + 8 + 10 + 9)}`)
for (const tier of TIERS) {
  const tr = results.tiers[tier]
  if (!tr) continue
  for (const zone of ZONES) {
    const m = tr.zones[zone]
    if (!m) {
      console.log(`  ${pad(tier, 7)}${pad(zone, 7)}${padNum('-', 8)}${padNum('-', 12)}${padNum('-', 8)}${padNum('-', 10)}${padNum('-', 9)}`)
      continue
    }
    const rs = m.renderScale != null ? Number(m.renderScale).toFixed(2) : '-'
    console.log(
      `  ${pad(tier, 7)}${pad(zone, 7)}${padNum(m.drawCalls, 8)}${padNum(m.triangles, 12)}${padNum(m.geometries, 8)}${padNum(m.textures, 10)}${padNum(rs, 9)}`,
    )
  }
}

// --- Earth perfSample percentiles per tier (drift visibility only) ----------
console.log('\n[perf-sweep] earth perfSample percentiles per tier (NOT gated — swiftshader times are meaningless vs real hardware):')
console.log(
  `  ${pad('tier', 7)}${padNum('frames', 8)}${padNum('avgMs', 9)}${padNum('p95Ms', 9)}${padNum('p99Ms', 9)}${padNum('maxMs', 9)}${padNum('avgFps', 9)}${padNum('1%lowFps', 10)}`,
)
console.log(`  ${'-'.repeat(7 + 8 + 9 + 9 + 9 + 9 + 9 + 10)}`)
for (const tier of TIERS) {
  const p = results.tiers[tier]?.perfSample?.perf
  if (!p) {
    console.log(`  ${pad(tier, 7)}${padNum('-', 8)}${padNum('-', 9)}${padNum('-', 9)}${padNum('-', 9)}${padNum('-', 9)}${padNum('-', 9)}${padNum('-', 10)}`)
    continue
  }
  const f = (v) => (v == null ? '-' : Number(v).toFixed(1))
  console.log(
    `  ${pad(tier, 7)}${padNum(p.frames, 8)}${padNum(f(p.avgMs), 9)}${padNum(f(p.p95Ms), 9)}${padNum(f(p.p99Ms), 9)}${padNum(f(p.maxMs), 9)}${padNum(f(p.avgFps), 9)}${padNum(f(p.onePercentLowFps), 10)}`,
  )
}

console.log('\n[perf-sweep] NOTE: budgets below are REGRESSION CATCHERS, not hardware targets.')
for (const tier of TIERS) {
  const b = BUDGETS[tier]
  console.log(`  tier=${tier}: draws <= ${b.draws}, triangles <= ${b.triangles}`)
}

// --- Gate summary -----------------------------------------------------------
console.log('\n[perf-sweep] results:')
for (const c of checks) {
  const mark = c.ok ? '✓' : '✗'
  console.log(`  ${mark} ${c.label}${c.detail ? `  (${c.detail})` : ''}`)
}

if (realConsoleErrors.length) {
  console.log('\n[perf-sweep] unexpected console errors:')
  for (const e of realConsoleErrors) console.log(`  - ${e}`)
}
if (realPageErrors.length) {
  console.log('\n[perf-sweep] unexpected page errors:')
  for (const e of realPageErrors) console.log(`  - ${e}`)
}
if (ignoredErrors) {
  console.log(`\n[perf-sweep] (ignored ${ignoredErrors} known local-preview 404 / failed-resource message(s))`)
}

// --- Write the committed baseline -------------------------------------------
const failures = checks.filter((c) => !c.ok).length
results.pass = failures === 0
try {
  writeFileSync(BASELINE_PATH, JSON.stringify(results, null, 2) + '\n')
  console.log(`\n[perf-sweep] wrote baseline: ${BASELINE_PATH}`)
} catch (e) {
  console.log(`\n[perf-sweep] WARNING: failed to write baseline ${BASELINE_PATH}: ${e?.message || e}`)
}

console.log(
  `\n[perf-sweep] ${failures ? 'FAIL' : 'PASS'} — ${checks.length - failures}/${checks.length} checks passed.`,
)
process.exit(failures ? 1 : 0)
