/* Browser-level verification for the six renderers, driven over CDP against
 * headless Edge. Zero dependencies -- it uses only the global `fetch` and
 * `WebSocket` that Node 22+ provides.
 *
 * Why this layer cannot be skipped: unit tests do not cover pixels, CSS
 * cascade, or real events. And the most damaging defect this package has
 * shipped lived exactly there -- a tooltip shown with `style.display = ''`
 * while `.chart-tip` is `display: none` in the stylesheet, so it fell back to
 * none and the tooltip never appeared. Nothing threw. The page looked correct.
 * No screenshot could show it. Only getComputedStyle could.
 *
 * Usage:
 *   node serve.js 4173        # in another terminal
 *   node browser-check.mjs
 *
 * Env: EDGE, CDP_PORT, PAGE, SHOTS=1
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = process.env.EDGE ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.CDP_PORT || 9333)
const PAGE = process.env.PAGE || 'http://127.0.0.1:4173/renderers.html'
const SHOTS = process.env.SHOTS === '1'
const IDS = ['line', 'bar', 'scatter', 'histogram', 'heatmap', 'boxplot']

const results = []
let failures = 0
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' })
  if (!ok) failures++
}

// A dedicated profile is mandatory: a running Edge would ignore
// --remote-debugging-port and we would attach to the user's browser instead.
const profile = mkdtempSync(join(tmpdir(), 'dsh-charts-'))
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' })

let ws = null
let msgId = 0
const pending = new Map()
const exceptions = []
const consoleErrors = []

function send(method, params) {
  const id = ++msgId
  return new Promise((res, rej) => {
    pending.set(id, { res, rej, method })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
}

async function evalJS(expression) {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' :: ' + expression.slice(0, 100))
  }
  return r.result.value
}

function cleanup() {
  try { if (ws) ws.close() } catch {}
  try { edge.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

/* Probe a renderer's tooltip by actually moving the pointer over the plot.
 *
 * Several positions are tried because a renderer's hit area may not cover the
 * whole plot (a bar chart only reacts over its bands, for instance). Nothing
 * here inspects the implementation: it dispatches a real MouseEvent and then
 * asks the browser what the computed display is. */
const hoverProbe = (id) => `(async () => {
  const host = document.getElementById('c-${id}')
  if (!host) return { found: false, why: 'no host element' }
  const svg = host.querySelector('svg')
  const tip = host.querySelector('.chart-tip')
  if (!svg) return { found: false, why: 'no <svg>' }
  if (!tip) return { found: false, why: 'no .chart-tip element' }
  const b = svg.getBoundingClientRect()
  let probes = 0
  for (const fx of [0.5, 0.42, 0.58, 0.35, 0.65, 0.28, 0.72, 0.21, 0.79]) {
    for (const fy of [0.5, 0.62, 0.38]) {
      const x = Math.round(b.left + b.width * fx)
      const y = Math.round(b.top + b.height * fy)
      const targets = [document.elementFromPoint(x, y), svg, host].filter(Boolean)
      for (const t of targets) {
        t.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }))
      }
      probes++
      // Renderers coalesce redraws into requestAnimationFrame.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      const cs = getComputedStyle(tip)
      if (cs.display !== 'none') {
        return {
          found: true, probes, fx, fy, display: cs.display,
          visible: cs.visibility !== 'hidden' && Number(cs.opacity) > 0,
          text: (tip.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90),
        }
      }
    }
  }
  return { found: false, probes, why: 'tooltip stayed display:none across ' + probes + ' probe points' }
})()`

try {
  // ---- bring CDP up ------------------------------------------------------
  let list = null
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const j = await r.json()
      if (Array.isArray(j) && j.length) { list = j; break }
    } catch { /* not listening yet */ }
  }
  if (!list) throw new Error(`CDP did not come up on port ${PORT}`)

  const target = list.find(t => t.type === 'page') || list[0]
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { res, rej, method } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) rej(new Error(`${method}: ${m.error.message}`))
      else res(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      exceptions.push((d.text || '') + ' ' + ((d.exception && d.exception.description) || ''))
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map(a => a.value ?? a.description).join(' '))
    }
  }

  await send('Page.enable')
  await send('Runtime.enable')

  // Desktop metrics with touch OFF. With touch emulation on, `hover: none`
  // becomes true and the interaction under test could not be tested at all.
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setTouchEmulationEnabled', { enabled: false })

  await send('Page.navigate', { url: PAGE })

  let ready = false
  for (let i = 0; i < 100; i++) {
    await sleep(100)
    try { ready = await evalJS('!!window.__ready') } catch { /* still loading */ }
    if (ready) break
  }
  check('page mounted all six renderers', ready === true,
    ready ? '' : 'window.__ready never became true')
  await sleep(300)

  // ---- every renderer drew something ------------------------------------
  const mounts = await evalJS(`(() => {
    const ids = window.__rendererIds || []
    return ids.map(id => {
      const host = document.getElementById('c-' + id)
      const svg = host && host.querySelector('svg')
      const tip = host && host.querySelector('.chart-tip')
      const box = host ? host.getBoundingClientRect() : { width: 0, height: 0 }
      return {
        id,
        svg: !!svg,
        marks: svg ? svg.querySelectorAll('path,rect,circle,line,polyline').length : 0,
        texts: svg ? svg.querySelectorAll('text').length : 0,
        tipElement: !!tip,
        tipHiddenAtRest: tip ? getComputedStyle(tip).display === 'none' : null,
        w: Math.round(box.width),
        h: Math.round(box.height),
      }
    })
  })()`)

  check('all six are present', mounts.length === 6,
    `got ${mounts.length}: ${mounts.map(m => m.id).join(',')}`)

  for (const m of mounts) {
    check(`${m.id}: <svg> exists`, m.svg)
    check(`${m.id}: drew marks`, m.marks > 0, `marks=${m.marks}`)
    check(`${m.id}: height reserved`, m.h > 100, `h=${m.h}`)
    check(`${m.id}: has .chart-tip`, m.tipElement)
    check(`${m.id}: tooltip hidden at rest`, m.tipHiddenAtRest === true,
      `display=${m.tipHiddenAtRest}`)
    // Text must stay in the HTML overlay: the plot is scaled with
    // preserveAspectRatio="none", so SVG text would be stretched.
    check(`${m.id}: no <text> inside svg`, m.texts === 0, `texts=${m.texts}`)
  }

  // ---- hover: the check no screenshot can make --------------------------
  for (const id of IDS) {
    const r = await evalJS(hoverProbe(id))
    check(`${id}: hover reveals the tooltip`, r.found && r.display === 'block',
      r.found ? `display=${r.display}` : r.why)
    check(`${id}: hover readout is non-empty`, r.found && r.text.length > 0,
      r.found ? JSON.stringify(r.text) : 'no tooltip appeared')
    check(`${id}: tooltip is visually on`, r.found && r.visible === true,
      r.found ? 'visibility:hidden or opacity:0' : 'no tooltip appeared')
  }

  // ---- programmatic pin, and a redraw that must not throw ----------------
  for (const id of IDS) {
    const r = await evalJS(`(() => {
      const c = window.__charts['${id}']
      if (!c) return { ok: false, why: 'not exposed' }
      try {
        if (typeof c.select === 'function') c.select(1)
        if (typeof c.update === 'function') c.update({})
        return { ok: true, api: Object.keys(c).sort().join(',') }
      } catch (e) { return { ok: false, why: String(e && e.message || e) } }
    })()`)
    check(`${id}: select()/update() do not throw`, r.ok, r.why || `api=${r.api}`)
  }

  // ---- both colour schemes, and hover must survive the flip -------------
  for (const scheme of ['light', 'dark']) {
    await send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await sleep(250)
    const bg = await evalJS('getComputedStyle(document.body).backgroundColor')
    check(`${scheme}: surface color resolves`, typeof bg === 'string' && bg.startsWith('rgb'), bg)
    const r = await evalJS(hoverProbe('line'))
    check(`${scheme}: hover still works`, r.found && r.display === 'block',
      r.found ? `display=${r.display}` : r.why)
    if (SHOTS) {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(process.cwd(), `shot-renderers-${scheme}.png`),
        Buffer.from(shot.data, 'base64'))
    }
  }

  // ---- nothing threw anywhere -------------------------------------------
  check('no uncaught exceptions', exceptions.length === 0,
    exceptions.slice(0, 3).join(' | '))
  check('no console errors', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '))

} catch (err) {
  check('harness itself', false, String(err && err.message || err))
}

// ---- report --------------------------------------------------------------
const pad = Math.max(...results.map(r => r.name.length))
for (const r of results) {
  const detail = r.detail ? '  ' + r.detail : ''
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(pad)}${r.ok ? '' : detail}`)
}
console.log(`\n${results.length - failures}/${results.length} passed` +
  (failures ? `  --  ${failures} FAILED` : ''))
process.exit(failures ? 1 : 0)
