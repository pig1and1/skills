/* 跑 min-width-probe.html，把 §13 的两组判据变成可复现的检查。
 *
 * 为什么值得写：§13 里那张表（无处理 846px vs 应得 438px；min-width:0 / overflow:hidden /
 * overflow:auto 三者 432px）当初是**手量**的，无法复现 —— 换台机器、换个字体就没人能确认。
 *
 * ⚠️ 所以这里**只断言关系，不断言绝对值**：
 *   绝对像素随视口宽度、字体、系统缩放而变；"被撑开 vs 没被撑开""三个做法彼此相等"
 *   这些关系不变。判据落在会漂移的量上，就是给自己埋一个将来会莫名其妙变红的检查。
 *
 * 两组判据：
 *   1) 栅格轨道：无处理的两行会被撑开（轨道宽 ≈ 2 倍应得份额）；
 *      三种修法（min-width:0 / overflow:hidden / overflow:auto）的轨道宽**彼此相等**。
 *   2) 截断：省略号出现的**前置条件**（内容真的溢出 + overflow 不是 visible），
 *      不检查"画没画出来" —— 规范写着 ellipsing 只影响渲染、不影响布局，量不到。
 *      三个用例分别缺不同的条件，期望**两种不同的失败原因**。
 *
 * 用法：node min-width-check.mjs
 * （探针页是纯内联 HTML，走 file:// 就行，不需要起静态服务。）
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.MW_PORT || 9453)
/* 900px：§13 表里的数字就是这个视口下量的，保持一致好对照。
 * 但断言仍然只用关系 —— 见文件头。 */
const VIEWPORT = Number(process.env.MW_WIDTH || 900)
const HERE = fileURLToPath(new URL('.', import.meta.url))
const PROBE = join(HERE, 'min-width-probe.html')

if (!existsSync(PROBE)) { console.log('找不到探针页: ' + PROBE); process.exit(2) }
if (!existsSync(EDGE)) { console.log('找不到 Edge: ' + EDGE); process.exit(2) }

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const profile = mkdtempSync(join(tmpdir(), 'mw-check-'))
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
  await send('Emulation.setDeviceMetricsOverride',
    { width: VIEWPORT, height: 1400, deviceScaleFactor: 1, mobile: false })

  await send('Page.navigate', { url: pathToFileURL(PROBE).href })
  let ready = false
  for (let i = 0; i < 60; i++) {
    await sleep(120)
    try { if (await ev('document.readyState === "complete" && typeof window.__probe === "function"')) { ready = true; break } } catch {}
  }
  if (!ready) throw new Error('探针页没准备好: ' + PROBE)

  const p = await ev('JSON.stringify(window.__probe())').then(JSON.parse)

  /* 把量到的数全部打出来 —— 上一轮就是靠"数值自己露馅"才发现检查器取错了元素。
   * 只报通过/失败的话，你没法怀疑它。 */
  console.log(`\n  ── 栅格轨道（视口 ${VIEWPORT}px） ──`)
  for (const k of ['plain-1fr', 'minwidth0-1fr', 'overflow-hidden-1fr', 'overflow-auto-1fr',
                   'plain-3fr', 'overflow-hidden-3fr']) {
    const v = p[k]
    console.log(`    ${k.padEnd(22)} 轨道 ${String(v.trackW).padStart(4)}px` +
      `  应得 ${String(v.share).padStart(4)}px` +
      `  差 ${String(v.trackW - v.share).padStart(5)}px  行内溢出 ${v.rowOverflow}px`)
  }
  console.log(`\n  ── 截断（盒宽 / 内容宽 / overflow / 条件是否齐） ──`)
  for (const k of ['trunc-fixed-width', 'trunc-content-width', 'trunc-overflow-visible']) {
    const v = p[k]
    console.log(`    ${k.padEnd(22)} 盒 ${String(v.boxW).padStart(4)}px` +
      `  内容 ${String(v.contentW).padStart(4)}px  溢出=${String(v.overflows).padEnd(5)}` +
      `  overflow=${v.overflowValue.padEnd(8)} 省略号条件齐=${v.ellipsisPossible}`)
  }
  console.log('')

  /* ---------- 1. 栅格轨道 ---------- */
  const burst = (v) => v.trackW > v.share * 1.5
  check('无处理：1fr 轨道被内容撑开（轨道宽 > 应得份额的 1.5 倍）',
    burst(p['plain-1fr']), `${p['plain-1fr'].trackW}px vs 应得 ${p['plain-1fr'].share}px`)
  check('无处理：3fr/2fr 同样被撑开',
    burst(p['plain-3fr']), `${p['plain-3fr'].trackW}px vs 应得 ${p['plain-3fr'].share}px`)
  check('无处理：行自身横向溢出（撑破会传出去）',
    p['plain-1fr'].rowOverflow > 0, `rowOverflow=${p['plain-1fr'].rowOverflow}px`)

  const fixed = ['minwidth0-1fr', 'overflow-hidden-1fr', 'overflow-auto-1fr'].map(k => p[k].trackW)
  const spread = Math.max(...fixed) - Math.min(...fixed)
  check('三种修法的轨道宽**彼此相等**（同一个机制的两条路径，不是三种方案）',
    spread <= 1, `min-width:0=${fixed[0]}  overflow:hidden=${fixed[1]}  overflow:auto=${fixed[2]}  极差=${spread}px`)
  check('修好之后轨道宽 ≈ 应得份额（±3px，即不再被内容决定）',
    fixed.every(w => Math.abs(w - p['minwidth0-1fr'].share) <= 3),
    `轨道 ${fixed[0]}px vs 应得 ${p['minwidth0-1fr'].share}px`)
  check('3fr/2fr 加上 overflow:hidden 之后也回到应得份额',
    Math.abs(p['overflow-hidden-3fr'].trackW - p['overflow-hidden-3fr'].share) <= 3,
    `${p['overflow-hidden-3fr'].trackW}px vs 应得 ${p['overflow-hidden-3fr'].share}px`)

  /* ---------- 2. 截断的前置条件 ---------- */
  const f = p['trunc-fixed-width'], c = p['trunc-content-width'], v = p['trunc-overflow-visible']
  check('有确定宽度：内容确实溢出，且 overflow=hidden → 省略号的条件齐',
    f.overflows && f.overflowValue === 'hidden' && f.ellipsisPossible,
    `内容 ${f.contentW}px > 盒 ${f.boxW}px`)
  check('宽度由内容决定：盒子贴着内容走 → **根本没有溢出**，条件不齐',
    !c.overflows && !c.ellipsisPossible,
    `盒 ${c.boxW}px ≈ 内容 ${c.contentW}px`)
  check('overflow: visible：**溢出了**，但 text-overflow 不生效，条件不齐',
    v.overflows && v.overflowValue === 'visible' && !v.ellipsisPossible,
    `内容 ${v.contentW}px > 盒 ${v.boxW}px，但 overflow=${v.overflowValue}`)
  check('两个不齐的用例**失败原因不同**（一个是没溢出，一个是 overflow 不对）',
    c.overflows === false && v.overflows === true,
    `内容决定宽度: 溢出=${c.overflows} ／ overflow:visible: 溢出=${v.overflows}`)

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
