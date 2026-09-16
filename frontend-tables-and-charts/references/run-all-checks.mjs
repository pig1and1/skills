/* 一次跑完 references/ 下所有检查，给一张总表。
 *
 * 为什么需要它：检查已经攒到六个，散在目录里，而且**其中一个是特殊的** ——
 * `query-console-check.mjs` 需要外部静态服务（它自己的注释里就记着"我忘了起服务、
 * 然后去怀疑页面"那次）。没有一个统一入口，就等于每次都要靠记忆。
 *
 * ⚠️ 它按**三种输出**归类，不是两种：
 *   通过 / 失败 / **未校验**（例如 `linechart-check.mjs` 找不到 tsc 时会这样）。
 *   把"未校验"混进"通过"就是假通过 —— 那是这个工程里出现过最多次的毛病。
 *
 * 用法：node run-all-checks.mjs
 *       SKIP=query-console-check node run-all-checks.mjs    # 跳过某个（名字子串）
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const HTTP_PORT = Number(process.env.CHECK_HTTP_PORT || 4191)
const SKIP = process.env.SKIP || ''

if (!existsSync(EDGE)) {
  console.log('找不到 Edge: ' + EDGE + '（这些检查都要靠它驱动无头浏览器）')
  process.exit(2)
}

/* 哪些脚本是"要自己起服务"的 —— 目前只有 query-console-check。 */
const NEEDS_SERVER = new Set(['query-console-check.mjs'])

const scripts = readdirSync(HERE)
  .filter(f => /-(check|smoke)\.mjs$/.test(f) && f !== 'run-all-checks.mjs')
  .sort()

if (!scripts.length) { console.log('没找到任何 *-check.mjs / *-smoke.mjs'); process.exit(2) }

/* 给需要服务的那个起一个（只服务本目录，只读）。 */
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
let server = null
if (scripts.some(s => NEEDS_SERVER.has(s) && !SKIP.includes(s))) {
  server = createServer(async (req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '')
    const full = join(HERE, rel)
    if (!full.startsWith(HERE)) { res.writeHead(403).end(); return }
    let body
    try { body = await readFile(full) } catch { res.writeHead(404).end('nope'); return }
    res.writeHead(200, { 'content-type': types[extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body)
  })
  await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r))
}

/* ⚠️ 必须用**异步 spawn**，不能用 spawnSync。
 *    spawnSync 会把事件循环**整个阻塞住**，于是上面那个静态服务在子进程运行的全程
 *    都无法响应 —— 需要服务的 `query-console-check.mjs` 前置检查取不到页面，直接退出。
 *    （第一版就是这么写的：5 个不需要服务的脚本全绿，恰好那一个红。
 *      红灯的形状直接指向了原因，但如果不查，它看起来就像"页面坏了"。） */
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, opts)
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { out += d })
    p.on('error', e => resolve({ status: -1, out: out + '\n' + e.message }))
    p.on('close', code => resolve({ status: code, out }))
  })
}

const rows = []
try {
  for (const s of scripts) {
    if (SKIP && s.includes(SKIP)) { rows.push({ s, status: '跳过' }); continue }
    const env = { ...process.env }
    if (NEEDS_SERVER.has(s)) env.BASE = `http://127.0.0.1:${HTTP_PORT}`
    const r = await run(process.execPath, [join(HERE, s)], { env })
    const out = r.out || ''
    // 「未校验」是第三种结果，不能混进通过
    const unverified = /未校验/.test(out)
    const status = r.status !== 0 ? '失败' : unverified ? '未校验' : '通过'
    const tail = out.split(/\r?\n/).filter(l => l.trim()).pop() || ''
    rows.push({ s, status, tail: tail.slice(0, 60) })
    const mark = status === '通过' ? 'ok  ' : status === '未校验' ? '??  ' : 'FAIL'
    console.log(`  ${mark}  ${s.padEnd(30)} ${status}${status === '通过' ? '' : '  — ' + tail}`)
  }
} finally {
  if (server) server.close()
}

const n = (st) => rows.filter(r => r.status === st).length
console.log('')
console.log(`  ${rows.length} 个检查：通过 ${n('通过')} · 失败 ${n('失败')} · 未校验 ${n('未校验')}` +
  (SKIP ? ` · 跳过 ${n('跳过')}` : ''))
if (n('未校验')) console.log('  ⚠️ 「未校验」不是通过 —— 它意味着这台机器上验不了，别当成绿灯。')

process.exit(n('失败') ? 1 : 0)
