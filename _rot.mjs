import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto('http://localhost:5215/?debug&bot&tier=high', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__unit7nav?.ready(), null, { timeout: 25000 })
// sample max draws over a 360 rotation at two spots
async function scan(landmark){
  await page.evaluate((l)=>window.__unit7nav.gotoLandmark(l), landmark)
  await page.waitForTimeout(1000)
  let mx=0,mn=1e9,sum=0,n=0
  for(let d=0; d<360; d+=30){
    await page.evaluate((yaw)=>window.__unit7nav.setYaw(yaw*Math.PI/180), d)
    await page.waitForTimeout(220)
    const dc = await page.evaluate(()=>window.__unit7nav.metrics().drawCalls)
    mx=Math.max(mx,dc); mn=Math.min(mn,dc); sum+=dc; n++
  }
  return {landmark, max:mx, min:mn, avg:Math.round(sum/n)}
}
console.log(JSON.stringify(await scan('spawn')))
console.log(JSON.stringify(await scan('factory')))
console.log(JSON.stringify(await scan('arcade')))
await browser.close()
