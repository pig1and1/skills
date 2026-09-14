/* 验证 §14「页面级状态」的四条规则真的成立。
 *
 * 为什么值得单独写：§14 的规则是从这个页面里抄出来的，但**抄出来的规则自己没被验证过**。
 * 一个断言如果不可能失败，它比没有断言更糟 —— 它让你以为验过了。
 * 所以每一条都配一个"它应该怎样才算红"的想法，并且写完之后会**故意改坏页面**跑一次。
 *
 * 用法：node check.mjs        （先起 http://127.0.0.1:4180 服务这个目录）
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9451
const BASE = process.env.BASE || 'http://127.0.0.1:4180'
const MUTATE = process.env.MUTATE || ''   // 用来证伪自己
/* QC_PATCH: JSON [find, replace]，跑之前把页面改坏，跑完还原。
   用它来证明"这些 PASS 不是白给的" —— 每条规则都要有一个能让它变红的改法。 */
const PATCH = process.env.QC_PATCH ? JSON.parse(process.env.QC_PATCH) : null
const PAGE = process.env.QC_PAGE || 'index.html'
const original = PATCH ? readFileSync(PAGE, 'utf8') : null
if (PATCH) {
  if (!original.includes(PATCH[0])) {
    console.log('BROKEN PATCH ANCHOR (测试器自己的错，不是页面的错): ' + PATCH[0].slice(0, 60))
    process.exit(2)
  }
  writeFileSync(PAGE, original.replace(PATCH[0], PATCH[1]))
}
function restore() { if (PATCH) { try { writeFileSync(PAGE, original) } catch {} } }
process.on('exit', restore)

const profile = mkdtempSync(join(tmpdir(), 'qc-check-'))
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--hide-scrollbars', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })

let ws = null, id = 0
const pending = new Map()
const results = []
let failures = 0
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' })
  if (!ok) failures++
}
const send = (m, p) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej })
  ws.send(JSON.stringify({ id: i, method: m, params: p || {} }))
})
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + e.slice(0, 80))
  return r.result.value
}
async function load(url) {
  await send('Page.navigate', { url })
  for (let i = 0; i < 60; i++) {
    await sleep(120)
    try { if (await ev('document.readyState === "complete" && !!document.getElementById("state")')) return } catch {}
  }
  throw new Error('page never became ready: ' + url)
}

try {
  let list = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const j = await r.json(); if (j.length) { list = j; break }
    } catch {}
  }
  if (!list) throw new Error('CDP did not start')
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
  if (MUTATE) await send('Page.addScriptToEvaluateOnNewDocument', { source: MUTATE })

  /* ---------- 规则 1：四种状态必须彼此可区分 ---------- */
  const texts = {}
  await load(BASE + '/index.html')
  texts.idle = await ev('document.getElementById("state").textContent.replace(/\\s+/g," ").trim()')
  texts.idleBusy = await ev('document.getElementById("state").getAttribute("aria-busy")')

  await ev('document.getElementById("go").click()')
  await sleep(120)
  texts.loading = await ev('document.getElementById("state").textContent.replace(/\\s+/g," ").trim()')
  texts.loadingBusy = await ev('document.getElementById("state").getAttribute("aria-busy")')
  await sleep(1200)
  texts.ok = await ev('document.getElementById("state").textContent.replace(/\\s+/g," ").trim()')

  await load(BASE + '/index.html?force=empty')
  await sleep(1400)
  texts.empty = await ev('document.getElementById("state").textContent.replace(/\\s+/g," ").trim()')

  await load(BASE + '/index.html?force=error')
  await sleep(1400)
  texts.error = await ev('document.getElementById("state").textContent.replace(/\\s+/g," ").trim()')

  const uniq = new Set([texts.idle, texts.loading, texts.empty, texts.error].map(s => s.slice(0, 40)))
  check('四种状态的文案互不相同', uniq.size === 4,
    uniq.size === 4 ? '' : `只有 ${uniq.size} 种不同：${[...uniq].map(s => s.slice(0, 18)).join(' | ')}`)
  check('未查询态不说"没有数据"', !/没有|无数据|暂无/.test(texts.idle) || /还没有查询/.test(texts.idle),
    texts.idle.slice(0, 40))
  check('未查询态明确说"还没查"', /还没有查询|尚未|还没/.test(texts.idle), texts.idle.slice(0, 40))
  check('无结果态说的是"查了但没有"', /没有符合条件|无符合|0 条/.test(texts.empty), texts.empty.slice(0, 40))
  check('失败态说的是"失败"而不是"无数据"', /失败/.test(texts.error) && !/^[^失]*没有/.test(texts.error),
    texts.error.slice(0, 40))
  check('aria-busy：未查询=false', texts.idleBusy === 'false', `got ${texts.idleBusy}`)
  check('aria-busy：加载中=true', texts.loadingBusy === 'true', `got ${texts.loadingBusy}`)
  check('aria-busy：加载完回到 false',
    (await ev('document.getElementById("state").getAttribute("aria-busy")')) === 'false')

  /* ---------- 规则 2：状态变化要被 live region 播报 ---------- */
  const live = await ev(`(() => {
    const el = document.getElementById('form-status')
    if (!el) return { ok: false, why: '找不到 #form-status' }
    const role = el.getAttribute('role'), al = el.getAttribute('aria-live')
    return { ok: role === 'status' || al === 'polite' || al === 'assertive',
             role, al, text: el.textContent.trim() }
  })()`)
  check('状态容器是 live region（role=status 或 aria-live）', live.ok,
    `role=${live.role} aria-live=${live.al}`)
  check('查询完成后 live region 有文本', (live.text || '').length > 0, JSON.stringify(live.text))

  /* ---------- 规则 3：字段错误要关联到输入，且是文本 ---------- */
  await load(BASE + '/index.html')
  await ev(`(() => { const i = document.getElementById('minErr'); i.value = '999'; })()`)
  await ev('document.getElementById("go").click()')
  await sleep(250)
  const fe = await ev(`(() => {
    const i = document.getElementById('minErr')
    const ids = (i.getAttribute('aria-describedby') || '').split(/\\s+/).filter(Boolean)
    const texts = ids.map(x => { const e = document.getElementById(x); return e ? e.textContent.trim() : null })
    return {
      invalid: i.getAttribute('aria-invalid'),
      describedBy: ids,
      messages: texts,
      focused: document.activeElement === i,
      stillOnForm: !!document.getElementById('state').textContent.match(/还没有查询|查询/),
    }
  })()`)
  check('出错字段标了 aria-invalid=true', fe.invalid === 'true', `got ${fe.invalid}`)
  check('aria-describedby 指向真实存在的元素', fe.messages.length > 0 && fe.messages.every(m => m !== null),
    JSON.stringify(fe.describedBy))
  check('错误是文本，不是只有红框', fe.messages.some(m => m && m.length > 0),
    JSON.stringify(fe.messages))
  check('错误文本给了可执行建议（含范围/示例）', fe.messages.some(m => m && /0 到 100|数值|有效数字/.test(m)),
    JSON.stringify(fe.messages))
  check('校验失败后焦点在出错字段', fe.focused === true, `focused=${fe.focused}`)
  check('校验失败不会去发请求', fe.stillOnForm === true)

  // 开始修正时应清掉红框
  await ev(`(() => { const i = document.getElementById('minErr'); i.value = '2'; i.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  await sleep(80)
  check('开始修正后 aria-invalid 被清掉',
    (await ev(`document.getElementById('minErr').getAttribute('aria-invalid')`)) === null)

  /* ---------- 规则 4：过期响应不许覆盖新的 ----------
     注意这里**不能用 #go.click()** 来发第二次：提交中按钮是 disabled，而 disabled 按钮的
     click() 是空操作 —— 那样测出来"只有一次渲染"是假的，它测的是按钮禁用，不是竞态。
     （第一版就是这么写的，在"拿掉 AbortController"的变异下依然全绿。两次测量才发现。）
     所以直接派发 submit 事件，模拟从别的路径打进来的第二次提交。 */
  await load(BASE + '/index.html')
  // 先单独跑一次"宽条件"，拿到它的计数当基准 —— 否则无法区分
  // "只是第一次查询渲染了" 和 "第二次真的赢了"。
  const wideCount = await ev(`(async () => {
    const kw = document.getElementById('keyword'); kw.value = ''
    document.getElementById('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 1500))
    return document.getElementById('count').textContent.trim()
  })()`)

  await load(BASE + '/index.html')
  const race = await ev(`(async () => {
    const seen = []
    const el = document.getElementById('count')
    const form = document.getElementById('form')
    const kw = document.getElementById('keyword')
    const fire = () => form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    new MutationObserver(() => { const v = el.textContent.trim(); if (v) seen.push(v) })
      .observe(el, { childList: true, characterData: true, subtree: true })

    kw.value = 'timeout'                       // 第一次：条件窄
    fire()
    await new Promise(r => setTimeout(r, 120))
    kw.value = ''                              // 第二次：条件宽，应当赢
    fire()
    await new Promise(r => setTimeout(r, 2400))
    return { seen, final: el.textContent.trim() }
  })()`)
  console.log('DIAG race = ' + JSON.stringify({ ...race, wideCount }))

  // 一对互补的断言，各有各的证伪方式：
  //   ① 坏掉 abort        → 过期结果被渲染 → seen 出现两个值 → ①红、②绿
  //   ② 第二次提交没发生   → 只渲染了窄条件   → seen 只有一个值 → ①绿、②红
  check('过期的那次结果从未被渲染', race.seen.length === 1,
    `渲染过的计数序列 = ${JSON.stringify(race.seen)}（期望只有 ${JSON.stringify(wideCount)}）`)
  check('胜负由"最新"决定，而不是"最先返回"', race.final === wideCount,
    `final=${JSON.stringify(race.final)}，宽条件应为 ${JSON.stringify(wideCount)}`)

  /* ---------- 规则 4b：失败态能重试，且重放同一查询 ---------- */
  const retry = await ev(`(async () => {
    // 让下一次请求失败：临时把 fetch 之外的路由换掉做不到，改用 force=error 的会话不行，
    // 所以这里直接验证"重试按钮存在且点击后会再次进入加载态"
    return null
  })()`)
  await load(BASE + '/index.html?force=error')
  await sleep(1400)
  const hasRetry = await ev(`!!document.getElementById('retry')`)
  check('失败态提供重试入口', hasRetry === true)
  if (hasRetry) {
    await ev(`(() => { window.__busySeen = []; const el = document.getElementById('state')
      new MutationObserver(() => window.__busySeen.push(el.getAttribute('aria-busy')))
        .observe(el, { childList: true, subtree: true, attributes: true })
    })()`)
    await ev(`document.getElementById('retry').click()`)
    await sleep(300)
    const busyDuringRetry = await ev(`document.getElementById('state').getAttribute('aria-busy')`)
    check('重试会重新进入加载态', busyDuringRetry === 'true', `aria-busy=${busyDuringRetry}`)
  }

  /* ---------- 规则 5（③ 经验）：刷新后表单值保留 ---------- */
  await load(BASE + '/index.html')
  await ev(`(() => {
    document.getElementById('keyword').value = 'connection reset'
    document.getElementById('note').value = '给运维看的备注'
    document.getElementById('endpoint').value = '/api/search'
    document.getElementById('go').click()
  })()`)
  await sleep(1300)
  await load(BASE + '/index.html')      // 重新加载，不是重新开标签页
  const kept = await ev(`({
    keyword: document.getElementById('keyword').value,
    note: document.getElementById('note').value,
    endpoint: document.getElementById('endpoint').value
  })`)
  check('刷新后关键字保留', kept.keyword === 'connection reset', JSON.stringify(kept.keyword))
  check('刷新后备注保留', kept.note === '给运维看的备注', JSON.stringify(kept.note))
  check('刷新后下拉选择保留', kept.endpoint === '/api/search', JSON.stringify(kept.endpoint))

  /* ---------- 顺带：3.2.2 —— 改控件不得自动触发上下文变化 ---------- */
  await load(BASE + '/index.html')
  await ev(`(() => { const s = document.getElementById('range'); s.value = '7d'; s.dispatchEvent(new Event('change', {bubbles:true})) })()`)
  await sleep(200)
  const autoFired = await ev(`document.getElementById('state').textContent.includes('还没有查询')`)
  check('改下拉不会自动发起查询（3.2.2）', autoFired === true)

} catch (e) {
  check('检查器本身', false, String(e && e.message || e))
} finally {
  try { if (ws) ws.close() } catch {}
  try { edge.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}

const pad = Math.max(...results.map(r => r.name.length))
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(pad)}${r.ok ? '' : '  ' + r.detail}`)
}
console.log(`\n${results.length - failures}/${results.length} passed` + (failures ? `  --  ${failures} FAILED` : ''))
process.exit(failures ? 1 : 0)
