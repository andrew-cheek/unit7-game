#!/usr/bin/env node
/**
 * Headless smoke test — the guardrail that catches what `tsc`/`vite build` can't:
 * runtime startup crashes and console errors. It boots the *built* game in a
 * headless browser (software WebGL), dismisses the menus, and:
 *   - FAILS (exit 1) if there's a page error / "startup failed" console error,
 *   - saves a screenshot to .smoke/boot.png so you can eyeball it,
 *   - prints live render stats (fps/draw calls/triangles).
 *
 * Puppeteer is intentionally NOT a project dependency, so production installs
 * (Netlify) never download Chromium. First time, install it locally:
 *     npm i -D puppeteer
 * Optional: TIME=<sec> jumps the day/night clock (e.g. TIME=20 for full sun).
 *
 *     npm run smoke
 */
import http from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = process.cwd()
const DIST = join(ROOT, 'dist')
const OUTDIR = join(ROOT, '.smoke')
const PORT = 4173
const TIME = process.env.TIME || '' // set to jump the day clock; default = real morning start

let puppeteer
try {
  puppeteer = (await import('puppeteer')).default
} catch {
  console.error('\n[smoke] puppeteer is not installed (kept out of deps so prod installs stay clean).')
  console.error('[smoke] install it once:  npm i -D puppeteer\n')
  process.exit(2)
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.log('[smoke] no dist/ found — running `npm run build` first...')
  execSync('npm run build', { stdio: 'inherit' })
}
await mkdir(OUTDIR, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm' }
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0])
    if (p === '/') p = '/index.html'
    const data = await readFile(join(DIST, normalize(p).replace(/^(\.\.[/\\])+/, '')))
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
}).catch((e) => {
  console.error('[smoke] could not launch Chromium. Try:  npx puppeteer browsers install chrome')
  console.error(e.message)
  process.exit(2)
})

const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const errors = []
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning') errors.push(`[${t}] ${m.text()}`) })
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

let ok = true
try {
  await page.goto(`http://127.0.0.1:${PORT}/${TIME ? `?time=${TIME}` : ''}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(2000)
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /play solo/i.test(x.textContent || '')); if (b) b.click() })
  await sleep(400)
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /skip/i.test(x.textContent || '')); if (b) b.click() })
  await sleep(4000)
  await page.screenshot({ path: join(OUTDIR, 'boot.png') })
  const stats = await page.evaluate(() => { const u = window.__UNIT7__; return u ? { fps: Math.round(u.fps), drawCalls: u.drawCalls, triangles: u.triangles } : null })
  console.log('[smoke] stats:', JSON.stringify(stats))
} catch (e) {
  errors.push(`[harness] ${e.message}`)
}

// Ignore the harmless favicon 404; fail on real runtime errors.
const fatal = errors.filter((e) => /pageerror|startup failed|TypeError|ReferenceError/i.test(e))
const ignorable = errors.filter((e) => /favicon\.ico|404/i.test(e))
if (errors.length) console.log('[smoke] console:\n' + errors.join('\n'))
console.log(`[smoke] screenshot: ${join(OUTDIR, 'boot.png')}`)
if (fatal.length) { ok = false; console.error(`\n[smoke] FAIL — ${fatal.length} runtime error(s).`) }
else console.log(`\n[smoke] PASS — no runtime errors${ignorable.length ? ' (ignored harmless favicon/404)' : ''}.`)

await browser.close()
server.close()
process.exit(ok ? 0 : 1)
