/* 冒烟测试：每个参考实现**真的能跑起来吗**。
 *
 * 为什么需要它：2026-09-14 发现 `dashboard.html`（skill 里被列为"复杂示例"的那一份）
 * **加载即抛异常**，三个图表一个都没画出来 —— 而它已经坏了不知道多久，
 * 期间**所有静态检查全部通过**：文件自包含、引用能解析、字号在阶梯上、四条 grep 命令也没话说。
 *
 * **静态检查能验"写得对不对"，验不了"跑不跑得起来"。** 少掉这一条，
 * 一个死页面可以安静地待在"参考实现"里，还被正文推荐。
 *
 * 它只断言一件事：**页面加载后没有未捕获异常。**
 * （有页面需要静态服务才能 fetch，那种"取不到数据"是被页面自己处理的，不算未捕获异常。）
 *
 * 用法：node reference-smoke.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.SMOKE_PORT || 9463)
const HERE = fileURLToPath(new URL('.', import.meta.url))
const PAGES = readdirSync(HERE).filter(f => f.endsWith('.html')).sort()

if (!existsSync(EDGE)) { console.log('找不到 Edge: ' + EDGE); process.exit(2) }
if (!PAGES.length) { console.log('references/ 下没有 html'); process.exit(2) }

const profile = mkdtempSync(join(tmpdir(), 'smoke-'))
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })

let ws = null, id = 0
const pending = new Map()
let errors = []
const send = (m, p) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej })
  ws.send(JSON.stringify({ id: i, method: m, params: p || {} }))
})
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  return r.exceptionDetails ? null : r.result.value
}

let failures = 0
try {
  let list = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const j = await r.json(); if (j.length) { list = j; break } } catch {}
  }
  if (!list) throw new Error('CDP 没起来')
  const t = list.find(x => x.type === 'page') || list[0]
  ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      errors.push((d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text))
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const s = (m.params.args || []).map(a => a.value || a.description || '').join(' ')
      if (s) errors.push('console.error: ' + s)
    }
    /* ⚠️ **还要听 Log 域。** 模块脚本 / 资源加载被挡（`file://` 下的 CORS）**不抛未捕获异常**，
     * 它只出现在浏览器日志里 —— 只监听 Runtime 会**整类失败都看不见**。
     * 这条是实测出来的：`<script type="module" src="…">` 在 `file://` 下被挡时，
     * Runtime 一声不响，Log 里有一句 `Access to script … blocked`。
     *
     * ⚠️ **但只收 `network` / `security` 两类。** 第一版收全部 `level === 'error'`，
     * 结果 `dirty-data-cases.html` 当场报红 —— 而那个页面的**全部意义**就是渲染"朴素实现算出的
     * NaN 路径"，`<path> attribute d: Expected number, "M4.0 NaN"` 是它**该有**的输出。
     * **一个故意演示坏输出的页面，会合法地产生错误。**
     * 我要补的盲区是"**资源没能加载**"，那是 `network` / `security`；渲染警告是另一类。 */
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' &&
        (m.params.entry.source === 'network' || m.params.entry.source === 'security')) {
      errors.push(`log[${m.params.entry.source}]: ` + m.params.entry.text)
    }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id)
      m.error ? rej(new Error(m.error.message)) : res(m.result)
    }
  }
  // Log.enable 必须开，否则上面那个 Log.entryAdded 永远不来 —— **加了监听却没开域，
  // 是一类很安静的假通过**（监听器在，条件永远不成立）。
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 2000, deviceScaleFactor: 1, mobile: false })

  console.log('')
  for (const page of PAGES) {
    errors = []
    await send('Page.navigate', { url: pathToFileURL(join(HERE, page)).href })
    // 等到 DOM 完成，再多给一点时间让 rAF / 定时器里的绘制跑完
    for (let i = 0; i < 60; i++) {
      await sleep(100)
      if (await ev('document.readyState === "complete"')) break
    }
    await sleep(900)
    const svgCount = await ev('document.querySelectorAll("svg").length')
    const ok = errors.length === 0
    if (!ok) failures++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${page.padEnd(34)} svg=${svgCount}` +
      (ok ? '' : '  —— ' + errors.slice(0, 2).join(' | ')))
  }
  console.log(`\n${failures ? failures + ' 个页面跑不起来' : '全部页面加载无异常'}`)
} catch (e) {
  console.log('冒烟测试自己跑挂了: ' + e.message)
  failures++
} finally {
  try { ws && ws.close() } catch {}
  try { edge.kill() } catch {}
  await sleep(150)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  process.exit(failures ? 1 : 0)
}
