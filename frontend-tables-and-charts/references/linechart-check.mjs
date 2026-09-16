/* 把 LineChart.ts 真编译、真跑起来。
 *
 * 为什么需要它：这个骨架**全库没有任何消费者** —— 没有页面 import 它，
 * 也没人打开它。于是 `tsc --noEmit` 通过**根本不等于它能跑**：类型对，代码照样可以是死的。
 * （2026-09-14 发现：给它补 X 轴那一次，代码从没被执行过；
 *   同一天还发现 `dashboard.html` 加载即抛异常、而所有静态检查全绿。）
 *
 * 判据（一条）：**三个区域都有墨** —— 左槽（Y 轴标签）、底槽（X 轴标签）、绘图区（折线）。
 * 用 canvas 像素来判，因为这是唯一能区分"画出来了"和"代码跑了但什么都没画"的办法。
 *
 * ⚠️ 它需要 `tsc`。找不到就报"未校验"并退出 0 —— **不假装通过**。
 *    （其它检查是零依赖的；这一条是全库唯一需要编译器的，因为它验的是 TS 骨架。）
 *
 * 用法：node linechart-check.mjs
 *       TSC=/path/to/tsc node linechart-check.mjs     # 指定编译器
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const HERE = fileURLToPath(new URL('.', import.meta.url))
const SRC = join(HERE, 'LineChart.ts')
const PORT_HTTP = Number(process.env.LC_HTTP_PORT || 9481)
const PORT_CDP = Number(process.env.LC_CDP_PORT || 9482)

/** 找一个能用的 tsc；找不到就返回 null（调用方报"未校验"）。 */
function findTsc() {
  if (process.env.TSC) return existsSync(process.env.TSC) ? process.env.TSC : null
  const cands = []
  let d = HERE
  for (let i = 0; i < 6; i++) {                      // 往上找 node_modules/.bin
    cands.push(join(d, 'node_modules', '.bin', 'tsc.cmd'))
    cands.push(join(d, 'node_modules', '.bin', 'tsc'))
    const up = dirname(d); if (up === d) break
    d = up
  }
  for (const c of cands) if (existsSync(c)) return c
  const which = spawnSync('where', ['tsc'], { encoding: 'utf8', shell: true })
  if (which.status === 0) return (which.stdout || '').split(/\r?\n/)[0].trim() || null
  return null
}

const TSC = findTsc()
if (!TSC) {
  console.log('  未校验  LineChart.ts —— 这台机器上找不到 tsc。')
  console.log('          （它验的是 TS 骨架，必须真编译一次；其余检查都是零依赖的。）')
  console.log('          装了 TypeScript，或用 TSC=<路径> 指一个再跑。')
  process.exit(0)                                   // 未校验 ≠ 失败
}
if (!existsSync(SRC)) { console.log('找不到 ' + SRC); process.exit(2) }
if (!existsSync(EDGE)) { console.log('找不到 Edge: ' + EDGE); process.exit(2) }

let fails = 0
const check = (n, ok, d) => { if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const work = mkdtempSync(join(tmpdir(), 'lc-'))
const profile = mkdtempSync(join(tmpdir(), 'lc-prof-'))
let server = null, edge = null, ws = null

try {
  /* ---- 1. 编译。类型错就到此为止：连编译都过不了的骨架没有可运行性可言。 ---- */
  const r = spawnSync(TSC, [SRC, '--outDir', work, '--target', 'es2020',
    '--module', 'es2020', '--lib', 'dom,es2020', '--strict'], { encoding: 'utf8', shell: true })
  check('tsc --strict 编译通过', r.status === 0, r.status === 0 ? '' : (r.stdout || '') + (r.stderr || ''))
  if (r.status !== 0) throw new Error('编译没过，后面的运行检查没有意义')
  if (!existsSync(join(work, 'LineChart.js'))) throw new Error('tsc 没产出 LineChart.js')

  /* ---- 2. 测试页。ES 模块不能走 file://，所以要起服务。 ---- */
  writeFileSync(join(work, 'index.html'), `<!doctype html><meta charset="utf-8">
<style>body{margin:0}#c{width:600px;height:220px}</style>
<div id="c"></div>
<script type="module">
import { createLineChart } from './LineChart.js'
const data = Array.from({ length: 40 }, (_, i) => ({ i, v: 10 + Math.sin(i / 4) * 5 }))
try {
  const chart = createLineChart(document.getElementById('c'), {
    height: 220,
    xLabels: data.map(d => 'D' + d.i),     // §6：两条轴都要有标签，X 是最常漏的那条
  })
  chart.setData([{ label: 'series', color: '#3366cc', values: data.map(d => d.v) }])
  window.__ok = true
} catch (e) { window.__err = String((e && e.stack) || e) }
</script>`)

  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
  server = createServer(async (req, res) => {
    const p = join(work, decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html')
    if (!p.startsWith(work)) { res.writeHead(403).end(); return }
    // ⚠️ 先读完再 writeHead。写成 `writeHead(200).end(await readFile(p))` 的话，
    //    读取失败时 catch 里的 writeHead(404) 会撞上已发出的 200 → ERR_HTTP_HEADERS_SENT，
    //    整个检查脚本会崩在服务端。（第一版就是这么写的。）
    let body
    try { body = await readFile(p) }
    catch { res.writeHead(404).end('nope'); return }
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }).end(body)
  })
  await new Promise(r2 => server.listen(PORT_HTTP, '127.0.0.1', r2))

  /* ---- 3. 浏览器 ---- */
  edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT_CDP, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })

  let id = 0
  const pending = new Map(), errors = []
  const send = (m, p) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }))
  })
  const ev = async (e) => {
    const rr = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
    if (rr.exceptionDetails) throw new Error(rr.exceptionDetails.text)
    return rr.result.value
  }

  let list = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try { const rr = await fetch(`http://127.0.0.1:${PORT_CDP}/json/list`); const j = await rr.json(); if (j.length) { list = j; break } } catch {}
  }
  if (!list) throw new Error('CDP 没起来')
  const t = list.find(x => x.type === 'page') || list[0]
  ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) }
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT_HTTP}/index.html` })
  for (let i = 0; i < 80; i++) {
    await sleep(120)
    if (await ev('document.readyState === "complete" && (window.__ok === true || !!window.__err)')) break
  }
  await sleep(500)

  const err = await ev('window.__err || null')
  check('createLineChart 构造没抛异常', !err, err || '')
  if (err) throw new Error('构造失败，后面不用测')

  /* ---- 4. 判据：三个区域各要有墨。 ---- */
  const m = await ev(`(() => {
    const c = document.querySelector('#c canvas')
    if (!c) return { noCanvas: true }
    const g = c.getContext('2d'), W = c.width, H = c.height
    const ink = (x0, y0, x1, y1) => {
      const d = g.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data
      let n = 0
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++
      return n
    }
    return { noCanvas: false, W, H, cssW: c.clientWidth, cssH: c.clientHeight,
             yBand: ink(0, 0, 44, H), xBand: ink(44, H - 20, W, H), plot: ink(44, 0, W, H - 20) }
  })()`)
  if (m.noCanvas) throw new Error('容器里没有 canvas')

  console.log(`  canvas ${m.W}×${m.H}（CSS ${m.cssW}×${m.cssH}）墨迹：Y 槽 ${m.yBand} · X 槽 ${m.xBand} · 绘图区 ${m.plot}`)
  check('canvas 尺寸等于容器（DPR=1）', m.cssW === 600 && m.cssH === 220, `${m.cssW}×${m.cssH}`)
  check('Y 轴标签画出来了（左槽有墨）', m.yBand > 20, 'yBand=' + m.yBand)
  check('X 轴标签画出来了（底槽有墨）—— §6 说这是最常漏的一条', m.xBand > 20, 'xBand=' + m.xBand)
  check('折线画出来了（绘图区有墨）', m.plot > 200, 'plot=' + m.plot)
  check('没有未捕获异常', errors.length === 0, errors.join(' | '))

  console.log(`\n${fails ? fails + ' 项失败' : '全部通过'}`)
} catch (e) {
  console.log('跑挂了: ' + e.message)
  fails++
} finally {
  try { ws && ws.close() } catch {}
  try { edge && edge.kill() } catch {}
  try { server && server.close() } catch {}
  await sleep(150)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  try { rmSync(work, { recursive: true, force: true }) } catch {}
  process.exit(fails ? 1 : 0)
}
