/* 逐条验证索引里对 `stacked-bars-average-line.html` 的 6 条声称：
 *   「三段堆叠柱 + 同量纲平均折线共用从 0 起的轴；整柱透明命中区、柱顶圆角 path、
 *     点击选中并保持（区别于悬停）、图例全隐藏自动恢复」
 *
 * 为什么要它：索引里那 6 条是**对读者的承诺**，而在此之前没有任何东西验过它们 ——
 * 同一个目录里，`dashboard.html` 曾经加载即抛异常、`verify.html` 曾经打印
 * 与自身测量相反的结论，两件都是静态检查全绿时发生的。
 *
 * 用 CDP 派发**真鼠标事件**：合成 `click()` 对 SVG 元素不可靠，而"悬停 vs 选中并保持"
 * 这一条本来就必须靠真事件才测得出来。
 *
 * 用法：node composite-chart-check.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const HERE = fileURLToPath(new URL('.', import.meta.url))
const PAGE = join(HERE, 'stacked-bars-average-line.html')
const PORT = Number(process.env.CC_CDP_PORT || 9473)
let fails = 0
const check = (n, ok, d) => { if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const profile = mkdtempSync(join(tmpdir(), 'sb-'))
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })

let ws = null, id = 0
const pending = new Map(), errors = []
const send = (m, p) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })) })
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + e.slice(0, 70))
  return r.result.value
}
const mouseTo = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await sleep(140)
}
const mouseClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(160)
}

try {
  let list = null
  for (let i = 0; i < 60; i++) { await sleep(250); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const j = await r.json(); if (j.length) { list = j; break } } catch {} }
  const t = list.find(x => x.type === 'page') || list[0]
  ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) }
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1200, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: pathToFileURL(PAGE).href })
  for (let i = 0; i < 80; i++) { await sleep(120); if (await ev('document.readyState === "complete" && !!document.querySelector("#chart svg")')) break }
  await sleep(600)

  /* ---- 1. 三段堆叠柱 ---- */
  const seg = await ev(`(() => {
    const g = (q) => document.querySelectorAll(q).length
    const one = [...document.querySelectorAll('#chart svg path[data-i]')].filter(p => p.getAttribute('data-i') === '0').length
    return { day0: one, all: g('#chart svg path[data-i]'), days: g('#chart svg rect[data-i][fill="transparent"]') }
  })()`)
  check('三段堆叠柱：第 0 天正好 3 段，柱数 == 天数', seg.day0 === 3 && seg.all === seg.days * 3,
    `day0=${seg.day0} 总柱段=${seg.all} 天数=${seg.days}`)

  /* ---- 2. 轴从 0 起 ---- */
  // ⚠️ 逐 span 读。整个 .ylab 的 textContent 会把 "0" "19" "39" "58" 拼成 "0193958"，
  //    解析成一个数 —— 第一版就是这么误判的。
  const labels = await ev(`[...document.querySelectorAll('#chart .ylab span')].map(e => e.textContent.trim())`)
  const nums = (labels || []).map(Number)
  check('Y 轴从 0 起（刻度里最小的是 0）', nums.length > 0 && Math.min(...nums) === 0,
    `刻度 = ${JSON.stringify(labels)}`)

  /* ---- 3. 整柱透明命中区 ---- */
  const hit = await ev(`(() => {
    const r = document.querySelector('#chart svg rect[data-i="0"][fill="transparent"]')
    if (!r) return null
    const svg = document.querySelector('#chart svg')
    return { y: r.getAttribute('y'), h: Number(r.getAttribute('height')), vbH: Number(svg.getAttribute('viewBox').split(/\\s+/)[3]) }
  })()`)
  check('整柱透明命中区：从 y=0 起、高度等于画布高（细段也点得中）',
    !!hit && hit.y === '0' && hit.h === hit.vbH, JSON.stringify(hit))

  /* ---- 4. 柱顶圆角 path ---- */
  // 判据要和代码的意图对上：**只有最上面那一段**是圆的，底部两段直角。
  // （第一版断言"三段都有曲线"，可 `barPath` 只在 isTop 时加 Q，于是报了假失败。）
  const rounded = await ev(`(() => {
    const day0 = [...document.querySelectorAll('#chart svg path[data-i]')]
      .filter(p => p.getAttribute('data-i') === '0')
    return { n: day0.length, curves: day0.map(p => /[AQ]/.test(p.getAttribute('d') || '')),
             tag: day0.map(p => p.tagName.toLowerCase()) }
  })()`)
  check('柱顶圆角：三段柱里**只有顶段**有曲线命令（底部直角）',
    rounded.n === 3 && rounded.curves[2] === true && !rounded.curves[0] && !rounded.curves[1],
    `curves=${JSON.stringify(rounded.curves)} tags=${JSON.stringify(rounded.tag)}`)

  /* ---- 5. 点击选中并保持（区别于悬停） ---- */
  const box = await ev(`(() => {
    const r = document.querySelector('#chart svg rect[data-i="5"][fill="transparent"]')
    const b = r.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  })()`)
  await mouseTo(box.x, box.y)
  const tipAfterHover = await ev(`(document.querySelector('#tip').textContent || '').trim().replace(/\\s+/g,' ').slice(0,60)`)
  const detailAfterHover = await ev(`(document.querySelector('#detail').textContent || '').trim().slice(0, 40)`)
  await mouseClick(box.x, box.y)
  const detailAfterClick = await ev(`(document.querySelector('#detail').textContent || '').trim().replace(/\\s+/g,' ').slice(0, 80)`)
  await mouseTo(8, 8)                                    // 移开鼠标
  await sleep(250)
  const detailAfterLeave = await ev(`(document.querySelector('#detail').textContent || '').trim().replace(/\\s+/g,' ').slice(0, 80)`)
  console.log(`  悬停时 tip="${tipAfterHover}"`)
  console.log(`  点击后 detail="${detailAfterClick}"`)
  console.log(`  移开后 detail="${detailAfterLeave}"`)
  check('悬停给出读数', tipAfterHover.length > 0, tipAfterHover)
  check('点击选中：detail 里出现了那一天的日期', /\d{4}-\d{2}-\d{2}/.test(detailAfterClick), detailAfterClick)
  check('**选中要能保持**：鼠标移开后 detail 不变（悬停则不会）',
    detailAfterClick === detailAfterLeave && detailAfterLeave.length > 0, '移开后变了或为空')

  await ev(`document.getElementById('clear').click(), 1`)
  await sleep(200)
  const detailAfterClear = await ev(`(document.querySelector('#detail').textContent || '').trim().slice(0, 30)`)
  check('「清除选择」回到占位文案', /点击任意柱子/.test(detailAfterClear), detailAfterClear)

  /* ---- 6. 图例全隐藏自动恢复 ---- */
  const lg = await ev(`(() => {
    const btns = [...document.querySelectorAll('#legend button[data-legend]')]
    return { total: btns.length, keys: btns.map(b => b.getAttribute('data-legend')) }
  })()`)
  const seriesKeys = lg.keys.filter(k => k !== '__avg' && k !== '__all')
  for (const k of seriesKeys) {
    await ev(`document.querySelector('#legend button[data-legend="' + ${JSON.stringify(k)} + '"]').click(), 1`)
    await sleep(120)
  }
  const afterAllOff = await ev(`(() => {
    const pressed = [...document.querySelectorAll('#legend button[data-legend]')].map(b => b.getAttribute('aria-pressed'))
    return { bars: document.querySelectorAll('#chart svg path[data-i]').length, pressed }
  })()`)
  console.log(`  图例按钮: ${JSON.stringify(lg.keys)}`)
  console.log(`  逐个关掉 ${JSON.stringify(seriesKeys)} 之后：柱段数=${afterAllOff.bars} aria-pressed=${JSON.stringify(afterAllOff.pressed)}`)
  check('图例全隐藏不留空图：全部关掉后柱仍然画着', afterAllOff.bars > 0, 'bars=' + afterAllOff.bars)

  check('没有未捕获异常', errors.length === 0, errors.join(' | '))
  console.log(`\n${fails ? fails + ' 项失败' : '全部通过'}`)
} catch (e) {
  console.log('探针跑挂: ' + e.message); fails++
} finally {
  try { ws && ws.close() } catch {}; try { edge.kill() } catch {}
  await sleep(150); try { rmSync(profile, { recursive: true, force: true }) } catch {}
  process.exit(fails ? 1 : 0)
}
