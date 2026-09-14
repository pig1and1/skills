/* 验证 §1「冻结首列」的第四条伴随条件真的存在。
 *
 * 为什么要单独验：前三条（不透明底色 / 右边缘 / z-index 高于表头）都能靠读 CSS 确认，
 * 第四条不能 —— 它的症状**只在有行状态时才出现**。默认状态下两条规则的渲染结果
 * 一模一样，所以"看一眼截图"永远发现不了它。
 *
 * 判据（一条，不是两条）：
 *   冻结格自己的底色 == 这一行实际画出来的底色
 *
 * 页面里放了**两份**表，用同一个判据去测，期望它们**结论相反**：
 *   #t-ok   四条齐全      → 三种状态下都应当相等
 *   #t-bad  故意缺第 4 条 → 默认态相等，选中态与 hover 态**必须不等**
 *
 * 第二份表就是内建的证伪。**如果它对两者都报相等，那说明这个检查本身是坏的** ——
 * 一个从来不会红的断言比没有断言更糟。
 *
 * 用法：node frozen-column-check.mjs
 * （探针页是纯内联 HTML，没有模块，所以走 file:// 就行，不需要起静态服务。）
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.FZ_PORT || 9452)
const HERE = fileURLToPath(new URL('.', import.meta.url))
const PROBE = join(HERE, 'frozen-column-probe.html')

if (!existsSync(PROBE)) { console.log('找不到探针页: ' + PROBE); process.exit(2) }
if (!existsSync(EDGE)) { console.log('找不到 Edge: ' + EDGE); process.exit(2) }

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const profile = mkdtempSync(join(tmpdir(), 'fz-check-'))
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--hide-scrollbars', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })

let ws = null, id = 0
const pending = new Map()
const send = (m, p) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej })
  ws.send(JSON.stringify({ id: i, method: m, params: p || {} }))
})
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + e.slice(0, 80))
  return r.result.value
}

/* 一条判据，两边都用它。
 * 关键：<td> 自己是**透明**的（底色挂在 <tr> 上），所以不能拿 td 和 td 比。
 * 要比的是"冻结格自己画的底色"和"这一行实际会画出来的底色" ——
 * 行透明时，实际画出来的是表格的底色。 */
const MEASURE = (tableId, rowIdx) => `(() => {
  const t = document.getElementById('${tableId}')
  const tr = t.querySelectorAll('tbody tr')[${rowIdx}]
  const frozen = tr.querySelector('.col-id')
  const tableBg = getComputedStyle(t).backgroundColor
  const rowBg   = getComputedStyle(tr).backgroundColor
  const transparent = rowBg === 'rgba(0, 0, 0, 0)' || rowBg === 'transparent'
  const effective = transparent ? tableBg : rowBg
  return {
    frozen: getComputedStyle(frozen).backgroundColor,
    row: rowBg,
    effective,
    matches: getComputedStyle(frozen).backgroundColor === effective,
    z: {
      /* 注意 :not(.col-id) —— 第一版写成 querySelector('thead th')，
       * 而第一个 th 就是冻结列自己，于是量到 3，报出 "1 < 3 < 3" 这种假失败。
       * 要量的是**普通**表头格。 */
      head:     getComputedStyle(t.querySelector('thead th:not(.col-id)')).zIndex,
      headFree: getComputedStyle(t.querySelector('thead .col-id')).zIndex,
      bodyFree: getComputedStyle(t.querySelector('tbody .col-id')).zIndex,
    },
  }
})()`

try {
  let list = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const j = await r.json(); if (j.length) { list = j; break }
    } catch {}
  }
  if (!list) throw new Error('CDP 没起来')
  const t = list.find(x => x.type === 'page') || list[0]
  ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id)
      m.error ? rej(new Error(m.error.message)) : res(m.result)
    }
  }
  await send('Page.enable'); await send('Runtime.enable')
  // 够高，两张表都在视口里 —— 否则 hover 的坐标会落在视口外。
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false })

  await send('Page.navigate', { url: pathToFileURL(PROBE).href })
  let ready = false
  for (let i = 0; i < 60; i++) {
    await sleep(120)
    try { if (await ev('document.readyState === "complete" && document.querySelectorAll("table").length === 2')) { ready = true; break } } catch {}
  }
  if (!ready) throw new Error('探针页没准备好: ' + PROBE)

  /* ---------- 1. 静态两态：默认 / 选中 ---------- */
  const rows = {}
  for (const [label, table] of [['ok', 't-ok'], ['bad', 't-bad']]) {
    rows[label] = {
      default: await ev(MEASURE(table, 0)),
      selected: await ev(MEASURE(table, 1)),
    }
  }

  check('完整版：默认态，冻结格底色 == 行底色',
    rows.ok.default.matches, `${rows.ok.default.frozen} vs ${rows.ok.default.effective}`)
  check('完整版：选中态，冻结格底色 == 行底色',
    rows.ok.selected.matches, `${rows.ok.selected.frozen} vs ${rows.ok.selected.effective}`)

  check('缺第 4 条：默认态**看起来是对的**（所以只看截图发现不了）',
    rows.bad.default.matches, `${rows.bad.default.frozen} vs ${rows.bad.default.effective}`)
  check('缺第 4 条：选中态**必须露馅**（不等才是对的）',
    !rows.bad.selected.matches,
    `冻结格 ${rows.bad.selected.frozen} ≠ 行 ${rows.bad.selected.effective}`)

  /* ---------- 2. hover 态：得派发真的鼠标移动，CSS :hover 才会生效 ---------- */
  for (const [label, table] of [['ok', 't-ok'], ['bad', 't-bad']]) {
    const box = await ev(`(() => {
      const tr = document.querySelectorAll('#${table} tbody tr')[0]
      const r = tr.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' })
    await sleep(80)
    rows[label].hover = await ev(MEASURE(table, 0))
  }

  check('完整版：hover 态，冻结格底色 == 行底色',
    rows.ok.hover.matches, `${rows.ok.hover.frozen} vs ${rows.ok.hover.effective}`)
  check('缺第 4 条：hover 态**必须露馅**',
    !rows.bad.hover.matches,
    `冻结格 ${rows.bad.hover.frozen} ≠ 行 ${rows.bad.hover.effective}`)

  /* ---------- 3. 内建证伪的总检：同一判据必须给出相反结论 ---------- */
  const okAll = ['default', 'selected', 'hover'].every(s => rows.ok[s].matches)
  const badAny = ['default', 'selected', 'hover'].some(s => !rows.bad[s].matches)
  check('同一判据在两份表上结论相反 —— 这个检查是能红的',
    okAll && badAny,
    `完整版全相等=${okAll}，缺条的有不等=${badAny}`)

  /* ---------- 4. z-index 次序（第 3 条伴随条件） ---------- */
  for (const [label, table] of [['ok', 't-ok'], ['bad', 't-bad']]) {
    const z = rows[label].default.z
    check(`${label}：z-index 次序 body 冻结列 < 表头 < 表头里的冻结格`,
      Number(z.bodyFree) < Number(z.head) && Number(z.head) < Number(z.headFree),
      `${z.bodyFree} < ${z.head} < ${z.headFree}`)
  }

  console.log(`\n${failures ? failures + ' 项失败' : '全部通过'}`)
} catch (e) {
  console.log('跑挂了: ' + e.message)
  failures++
} finally {
  try { ws && ws.close() } catch {}
  try { edge.kill() } catch {}
  await sleep(150)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  process.exit(failures ? 1 : 0)
}
