#!/usr/bin/env node
/* 技能仓库的机械完整性检查。
 *
 * 为什么要有它：这几项检查我每轮都在手动跑，而且**每次手写的版本都会误报** ——
 * 一天之内三次：
 *   1. 找字面量 `★`，而那些表用的是裸数字的 stars 列 → 14 行全错
 *   2. 找"引用不存在的文件"，但命中的是 URL、HTML 注释和正文叙述 → 4 处全错
 *   3. 把一个真实的缺陷（URL 硬编码）盖住了，因为我在临时目录里改了文件名才跑通
 *   4. 把 `` `meta/environment.md` §12 `` 当成**本文件**的节号 → 误报"悬空引用"。
 *      文件名被反引号包着，正则只允许中间是空白，于是没认出来。
 *
 * **一个总在喊狼来了的检查器会被无视，那和假通过一样糟。** 所以这里把
 * "URL / 注释 / 正文" 的排除规则写进代码，而不是靠人看的时候心里过滤。
 * 推论：**检查器报 FAIL 时，第一个假设应该是"检查器错了"**，
 * 然后手工去核实那个所谓的缺陷（这次一查，`environment.md` 的 §12 确实存在）。
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
function stripNoise(text, { comments = false, templates = false } = {}) {
  let t = text.replace(/https?:\/\/[^\s)\]"'<>]+/g, ' ')
  if (comments) t = t.replace(/<!--[\s\S]*?-->/g, ' ')
  /* 模板字符串里的内容**不是这个文件自己的代码**，是它生成的产物。
   * 实例：`linechart-check.mjs` 会写一个 HTML 交给浏览器，里面有一行
   * `import { … } from './LineChart.js'` —— 那是**产物**的相对路径，
   * 不是这个脚本的 import。（2026-09-14 第 5 次误报，同一个毛病：分不清代码与数据。）
   * 只做保守匹配：反引号成对才剥。匹配不上就退回原样。 */
  if (templates) t = t.replace(/`[^`]*`/g, ' ')
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
    // templates: true —— 这些脚本会**生成 HTML**，产物里的 import 不是它自己的 import
    const t = stripNoise(readFileSync(join(refDir, f), 'utf8'), { templates: true })
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

  /* ---- 7. 施工路径必须把人带到每一个节 ---- */
  // 判据：照着「施工路径」从第 1 步走到最后一步，有没有哪一节**始终没被要求读过**？
  // 有的话那一节等于不存在 —— 它不会因为写得好而被用上，只会因为没人被带过去而被跳过。
  // 真实发生过：§13/§14 是后加的，路径里一直没有它们的名字，走完第 8 步也没人读过。
  const pathMatch = skill.match(/^## 施工路径[\s\S]*?(?=^## (?!施工路径))/m)
  if (pathMatch && secs.size) {
    const unreached = [...secs]
      .filter(n => !new RegExp(`§${n}(?![0-9])`).test(pathMatch[0]))
      .sort((a, b) => a - b)
    if (unreached.length) fail(`施工路径到不了这些节（等于没写）: ${unreached.map(n => '§' + n).join(', ')}`)
    else ok(`施工路径覆盖全部 ${secs.size} 个节`)
  }

  /* ---- 8. 描述里的每一项声称，正文里都要有落点 ---- */
  // 判据出自知识库的「教训九」：把描述里每一句"我能处理 X"抽出来，逐个去正文找对应的节；
  // 找不到的就是**过度声明** —— 会让 skill 在它答不上来的任务上被加载，那比不触发更糟。
  //
  // ⚠️ 这里用手写的映射表，而不是通用做法。通用做法是"正文里只出现在描述中的词"，
  //    实测跑出 **42 个命中，只有 1 个是真的**（`sparklines`）：因为这个 skill 的
  //    description 是英文而正文是中文，`alignment` / `density` / `headers` 在正文里
  //    全都以中文形式存在。**41:1 的噪声等于没有这个检查。**
  //    所以映射表是手工维护的：**改了 description 就要改它**，否则这项检查会安静地失效。
  const CLAIMS = [
    ['列宽 column widths', /列宽|table-layout/i],
    ['对齐 alignment', /对齐/],
    ['行密度 row density', /行高/],
    ['粘性表头 sticky headers', /sticky|粘性/i],
    ['hover / selection / focus', /hover|选中|:focus/i],
    ['虚拟滚动 virtual scrolling', /虚拟滚动/],
    ['主题 token', /token/i],
    ['折线 / 柱状 / 面积', /折线|柱状|面积/],
    ['轴范围与基线', /基线|从 0/],
    ['图表尺寸 chart sizing', /容器高度|高度/],
    ['DPR / canvas', /devicePixelRatio|DPR/],
    ['页面级四状态', /还没查|未查询/],
    ['栅格被撑破', /min-width: 0/],
    ['抖动 / 列漂移 / 滚动跳回', /跳回|抖动|列宽随滚动/],
    ['加载后布局位移', /预留|高度/],
    ['高分屏模糊', /模糊/],
    ['误导性坐标轴', /误导/],
    ['迷你图 sparkline', /sparkline|迷你图/i],
  ]
  const descLine = (skill.match(/^description:.*$/m) || [''])[0]
  const bodyText = skill.replace(/^description:.*$/m, '')
  const uncovered = CLAIMS
    .filter(([, re]) => re.test(descLine) && !re.test(bodyText))
    .map(([name]) => name)
  if (uncovered.length) fail(`描述声称覆盖、正文却没有落点: ${uncovered.join(', ')}`)
  else ok(`描述的 ${CLAIMS.length} 项声称都有正文落点`)

  /* ---- 9. 参考实现的字号必须落在 §11 的阶梯上 ---- */
  // 为什么值得机检：阶梯是 2026-09-14 才立的，立之前五个参考页面里散着
  // 11.5 / 12.5 / 16 / 17 / 18 / 20 —— **同一件事（正文字号）在三个文件里有三个值**。
  // 这种漂移人眼盯不住，所以把六档写进检查器。
  //
  // ⚠️ 例外是**刻意的**，正文里写明了理由：`.glyph` 的 16px 是**图标尺寸**，不是文字；
  //    按钮的 12.5px 属于**控件外观**，而那个维度本 skill 还没覆盖。
  //    **阶梯管的是内容层级，不是所有 `font-size`** —— 所以用白名单，而不是把值删干净。
  const RUNGS = [19, 15, 14, 13, 12, 11]
  const SCALE_EXCEPTIONS = [
    ['query-console.html', 16],                 // .glyph —— 图标，不是文字
    ['stacked-bars-average-line.html', 12.5],   // .tools button —— 控件外观（未覆盖的维度）
  ]
  const offScale = []
  const usedExceptions = new Set()
  for (const f of present.filter(x => /\.(css|html|ts)$/.test(x))) {
    const t = readFileSync(join(refDir, f), 'utf8')
    for (const m of t.matchAll(/font-size:\s*([\d.]+)px/g)) {
      const v = Number(m[1])
      if (RUNGS.includes(v)) continue
      const ex = SCALE_EXCEPTIONS.find(([ef, ev]) => ef === f && ev === v)
      if (ex) { usedExceptions.add(`${ex[0]} ${ex[1]}px`); continue }
      offScale.push(`${f} ${v}px`)
    }
  }
  if (offScale.length) {
    fail(`字号不在 §11 的阶梯上（只有 ${RUNGS.join(' / ')}）: ${[...new Set(offScale)].join(', ')}`)
  } else {
    // 例外数量按**本 skill 实际用到的**报，否则没有 references 的 skill 也会说"另有 2 处"
    const note = usedExceptions.size ? `（另有 ${usedExceptions.size} 处已声明的例外: ${[...usedExceptions].join(', ')}）` : ''
    ok(`参考实现的字号都落在 §11 的阶梯上${note}`)
  }
}

/* ---- 10. README 点名的路径与技能名，都得真实存在 ---- */
// 为什么：README 是仓库的**前门**，而此前**没有任何检查器看过它**。
// 2026-09-14 实测过它过时到什么程度：它列了 12 个参考文件而实际有 22 个（漏 10 个）——
// 那和 SKILL.md 里"存在却没被索引"是同一类缺陷，只不过长在文档里，没人扫。
// （那份清单已经删掉，改成指向 skill 自己的索引；所以这里查的是它**仍然点名的**路径与技能名。）
const readmePath = join(ROOT, 'README.md')
if (existsSync(readmePath)) {
  console.log('\n=== README ===')
  const readme = readFileSync(readmePath, 'utf8')

  // 全仓库文件索引：README 里会写裸文件名（`bar.js`）和命令（`node --test`），
  // 死拼路径会满屏误报。所以判定是"这个 token 能不能在仓库里找到"。
  const allFiles = walk(ROOT).map(p => relative(ROOT, p).split(/[\\/]/).join('/'))
  const allDirs = new Set()
  for (const p of allFiles) {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) allDirs.add(parts.slice(0, i).join('/') + '/')
  }
  const resolves = (t) => {
    const clean = t.replace(/\/$/, '')
    // 裸名字（`bar.js` / `references/`）也算数 —— README 里就是这么写的。
    // 第一版只比精确路径，于是 `references/` 被判成"不存在"（它只作为
    // `frontend-tables-and-charts/references/` 存在）。**检查器误报第 6 次。**
    const dirs = [...allDirs]
    return allFiles.includes(clean) ||
      allFiles.some(f => f.endsWith('/' + clean)) ||
      dirs.some(d => d === clean + '/' || d.endsWith('/' + clean + '/'))
  }

  const FILEISH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*\.(mjs|js|ts|tsx|css|html|md|json|yml|yaml)$/
  const DIRISH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*\/$/
  const candidates = []
  const seen = new Set()
  for (const m of readme.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1].trim()
    if (seen.has(t)) continue
    seen.add(t)
    if (/[*<>{}|]/.test(t) || /\s/.test(t)) continue          // 通配符 / 占位符 / 命令 → 跳过
    if (!FILEISH.test(t) && !DIRISH.test(t)) continue
    candidates.push(t)
  }
  const missing = candidates.filter(t => !resolves(t))
  if (missing.length) fail(`README 点名了仓库里不存在的路径: ${missing.join(', ')}`)
  else ok(`README 点名的 ${candidates.length} 个路径都能在仓库里找到`)

  // 技能名（`### \`xxx\`` 这种标题）必须是有 SKILL.md 的目录
  const badSkills = []
  for (const m of readme.matchAll(/^###\s+`([^`]+)`/gm)) {
    const n = m[1].trim()
    if (!/^[a-z][a-z0-9-]{3,}$/.test(n)) continue
    if (!skills.includes(n)) badSkills.push(n)
  }
  if (badSkills.length) fail(`README 列了不存在的技能: ${badSkills.join(', ')}`)
  else ok('README 列出的技能名与目录一致')
}

console.log(`\n${fails ? fails + ' 项失败' : '全部通过'}`)
process.exit(fails ? 1 : 0)
