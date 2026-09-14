#!/usr/bin/env node
/* 技能仓库的机械完整性检查。
 *
 * 为什么要有它：这几项检查我每轮都在手动跑，而且**每次手写的版本都会误报** ——
 * 一天之内三次：
 *   1. 找字面量 `★`，而那些表用的是裸数字的 stars 列 → 14 行全错
 *   2. 找"引用不存在的文件"，但命中的是 URL、HTML 注释和正文叙述 → 4 处全错
 *   3. 把一个真实的缺陷（URL 硬编码）盖住了，因为我在临时目录里改了文件名才跑通
 *
 * **一个总在喊狼来了的检查器会被无视，那和假通过一样糟。** 所以这里把
 * "URL / 注释 / 正文" 的排除规则写进代码，而不是靠人看的时候心里过滤。
 *
 * 用法：node tools/check-skills.mjs [repoRoot]
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename, relative } from 'node:path'

const ROOT = process.argv[2] || process.cwd()
let fails = 0
const fail = (msg) => { fails++; console.log('  FAIL  ' + msg) }
const ok = (msg) => console.log('  ok    ' + msg)

/** 去掉那些"看起来像引用、其实不是"的东西：URL 和 HTML 注释。
 *
 *  ⚠️ **不要把行内代码也剥掉。** 正文里的引用就写在反引号里 ——
 *  `` `references/table.css` `` —— 剥掉反引号等于**把真实引用当噪音删了**。
 *  第一版就是这么错的：它报出 9 个文件"存在但没被索引"，而它们全都老老实实地列在正文里。
 *
 *  **每加一条排除规则，都可能引入一种新的漏报。** 排除规则要盯的是
 *  "这段文字是不是在**别的语境**里出现"（URL / 注释），不是"它长得像不像代码"。 */
function stripNoise(text, { comments = false } = {}) {
  let t = text.replace(/https?:\/\/[^\s)\]"'<>]+/g, ' ')
  if (comments) t = t.replace(/<!--[\s\S]*?-->/g, ' ')
  return t
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) {
      if (e !== 'node_modules' && e !== '.git') walk(p, out)
    } else out.push(p)
  }
  return out
}

const skills = readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name !== 'tools' && d.name !== 'charts' && d.name !== '.git')
  .map(d => d.name)
  .filter(n => existsSync(join(ROOT, n, 'SKILL.md')))

if (!skills.length) { console.log('没找到任何含 SKILL.md 的技能目录'); process.exit(1) }

for (const name of skills) {
  const dir = join(ROOT, name)
  const refDir = join(dir, 'references')
  console.log(`\n=== ${name} ===`)

  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8')

  /* ---- 1. 正文里引用的 references/ 文件都真实存在 ---- */
  const cited = new Set()
  for (const m of stripNoise(skill).matchAll(/references\/([A-Za-z0-9_.-]+)/g)) cited.add(m[1])
  const present = existsSync(refDir) ? readdirSync(refDir, { withFileTypes: true })
    .filter(e => e.isFile()).map(e => e.name) : []

  const dead = [...cited].filter(f => !present.includes(f))
  if (dead.length) fail(`正文引用了不存在的文件: ${dead.join(', ')}`)
  else ok(`正文引用的 ${cited.size} 个 references 文件都存在`)

  /* ---- 2. references/ 里的每个文件都被正文索引 ---- */
  const unindexed = present.filter(f => !cited.has(f))
  if (unindexed.length) fail(`存在但没被索引（等于不存在）: ${unindexed.join(', ')}`)
  else ok(`references/ 里 ${present.length} 个文件都已被索引`)

  /* ---- 3. §N 交叉引用都指向存在的节 ---- */
  // `meta/environment.md §12` 这种是引用**别的文件**的节号，不在本文件内校验，只报出来备查。
  const secs = new Set([...skill.matchAll(/^## (\d+)\./gm)].map(m => Number(m[1])))
  // 文件名可能被反引号包着（`meta/environment.md` §12），所以中间允许反引号与空白。
  const allRefs = [...skill.matchAll(/([\w./\\-]*\.\w+)?[`\s]*§(\d+)/g)]
  const refs = new Set(allRefs.filter(m => !m[1]).map(m => Number(m[2])))
  const external = [...new Set(allRefs.filter(m => m[1]).map(m => `${m[1]} §${m[2]}`))]
  const note = external.length ? `（另有 ${external.length} 个跨文件 § 引用，未校验: ${external.join(' / ')}）` : ''
  const dangling = [...refs].filter(n => !secs.has(n))
  if (dangling.length) fail(`悬空的 §N 引用: ${dangling.map(n => '§' + n).join(', ')}`)
  else if (!refs.size) ok(`没有内部节号引用${note}`)
  else ok(`§0–§${Math.max(...secs)} 连续，${refs.size} 个交叉引用都有落点${note}`)

  /* ---- 4. references/*.html 必须自包含 ---- */
  for (const f of present.filter(x => x.endsWith('.html'))) {
    const t = stripNoise(readFileSync(join(refDir, f), 'utf8'), { comments: true })
    const local = [...t.matchAll(/(?:href|src)\s*=\s*["'](?!https?:|data:|#)([^"']+)/g)].map(m => m[1])
    if (local.length) fail(`${f} 有本地依赖（复制到别处会静默 404）: ${local.join(', ')}`)
  }
  const htmls = present.filter(x => x.endsWith('.html'))
  if (htmls.length) ok(`${htmls.length} 个 HTML 参考实现都自包含`)

  /* ---- 5. references 里的相对 import / require 都能解析 ---- */
  for (const f of present.filter(x => /\.(tsx?|mjs|js)$/.test(x))) {
    const t = stripNoise(readFileSync(join(refDir, f), 'utf8'))
    for (const m of t.matchAll(/(?:from|require\()\s*['"](\.\/[^'"]+)['"]/g)) {
      if (!existsSync(join(refDir, m[1]))) fail(`${f} 里 import 了不存在的 ${m[1]}`)
    }
  }
  ok('相对 import / require 都能解析')

  /* ---- 6. evidence.md：含出处的节必须声明自己的等级 ---- */
  const evPath = join(refDir, 'evidence.md')
  if (existsSync(evPath)) {
    const lines = readFileSync(evPath, 'utf8').split('\n')
    let cur = '(文件头)', start = 0, hasLink = false, checked = 0
    const flush = (end) => {
      if (!hasLink) return
      checked++
      const body = stripNoise(lines.slice(start, end + 1).join('\n'))
      if (!/\*\*[ABCD]\s*级|③|经验默认值/.test(body)) fail(`evidence.md 的「${cur}」节有出处却没声明等级`)
    }
    for (let i = 0; i < lines.length; i++) {
      if (/^## /.test(lines[i])) { flush(i - 1); cur = lines[i]; start = i; hasLink = false }
      else if (/\]\(http/.test(lines[i])) hasLink = true
    }
    flush(lines.length - 1)
    ok(`evidence.md 里 ${checked} 个含出处的节都声明了等级`)
  }
}

console.log(`\n${fails ? fails + ' 项失败' : '全部通过'}`)
process.exit(fails ? 1 : 0)
