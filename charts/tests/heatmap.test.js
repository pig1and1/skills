/**
 * Heatmap tests.
 *
 * Two halves, because the renderer has two kinds of logic:
 *
 *   1. The pure helpers (grid assembly, tooltip markup, keyboard movement, the
 *      ramp mapping) are exported from heatmap.js and tested directly. They hold
 *      the parts that are actually easy to get wrong: duplicate cells, missing
 *      values, label escaping, axis order.
 *   2. The renderer lifecycle runs against a MINIMAL DOM STUB. That stub is not a
 *      browser -- it cannot tell us whether the chart looks right -- but it does
 *      prove the contract and the crash-resistance: the returned API, that every
 *      cell is painted exactly once, that no literal colour reaches the markup,
 *      that arcs of stale state do not throw after a data swap, that one frame
 *      produces one redraw, and that destroy() really lets go.
 *
 * Run: node --test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  heatmapChart, prepareHeatmap, coerceCellValue, normalizeLabel,
  fillForStep, rampIndexFor, heatTipHtml, moveCell, resolveCell,
  HEAT_RAMP, MISSING_FILL, BLANK_LABEL,
} from '../src/heatmap.js'

// ─────────────────────────────────────────────── the ramp

test('every ramp token is a theme token, and the ladder is ordered', () => {
  // The hard constraint: no literal colour may appear in the code. If someone
  // later pastes a hex value in to "fix" the ramp, this fails.
  for (const token of HEAT_RAMP) {
    assert.match(token, /^var\(--chart-[a-z0-9-]+\)$/, `not a theme token: ${token}`)
  }
  assert.equal(new Set(HEAT_RAMP).size, HEAT_RAMP.length, 'no token may repeat: a repeated step makes two bins identical')
  assert.ok(HEAT_RAMP.length >= 3, 'a ramp needs enough steps to be a ramp')
  assert.match(MISSING_FILL, /^var\(--chart-[a-z0-9-]+\)$/)
})

test('fillForStep never returns a ramp step for missing data', () => {
  // The safety property that makes stepScale's null meaningful.
  assert.equal(fillForStep(null), MISSING_FILL)
  assert.equal(fillForStep(undefined), MISSING_FILL)
  assert.equal(fillForStep(NaN), MISSING_FILL)
  for (let i = 0; i < HEAT_RAMP.length; i++) {
    assert.notEqual(fillForStep(i), MISSING_FILL, `bin ${i} must not look like missing data`)
    assert.ok(HEAT_RAMP.includes(fillForStep(i)))
  }
  // Out-of-range indices clamp rather than returning nothing.
  assert.equal(fillForStep(-5), HEAT_RAMP[0])
  assert.equal(fillForStep(999), HEAT_RAMP[HEAT_RAMP.length - 1])
})

test('rampIndexFor spreads the chosen bin count across the whole ladder', () => {
  const n = HEAT_RAMP.length
  // Full resolution is the identity.
  assert.deepEqual(
    Array.from({ length: n }, (_, i) => rampIndexFor(i, n)),
    Array.from({ length: n }, (_, i) => i),
  )
  // Fewer bins than tokens must still span palest to strongest, not just the
  // first few steps -- otherwise a 3-class map would never reach its top colour.
  const three = [0, 1, 2].map((i) => rampIndexFor(i, 3))
  assert.equal(three[0], 0)
  assert.equal(three[2], n - 1)
  assert.ok(three[1] > three[0] && three[1] < three[2])
  // One class is the middle of the ladder: it claims nothing.
  const one = rampIndexFor(0, 1)
  assert.ok(one > 0 && one < n - 1)
})

test('the source itself names tokens, never colours', () => {
  // The rule is about the code, not only about what it happens to emit today: a
  // literal introduced now can reach the DOM tomorrow.
  const renderer = readFileSync(new URL('../src/heatmap.js', import.meta.url), 'utf8')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(renderer), 'heatmap.js contains a literal hex colour')
  assert.ok(!/\brgba?\(/.test(renderer), 'heatmap.js contains a literal rgb()/rgba() colour')
  assert.ok(!/\bhsla?\(/.test(renderer), 'heatmap.js contains a literal hsl() colour')

  // core.js was append-only for this task, so the added colour scale is checked
  // as a block rather than by re-reading the whole file.
  const core = readFileSync(new URL('../src/core.js', import.meta.url), 'utf8')
  const at = core.indexOf('sequential colour scale')
  assert.ok(at > 0, 'the colour-scale block is missing from core.js')
  const block = core.slice(at)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), 'the colour-scale block contains a literal hex colour')
  assert.ok(!/\brgba?\(/.test(block), 'the colour-scale block contains a literal rgb() colour')
})

// ─────────────────────────────────────────────── value coercion

test('coerceCellValue accepts numeric strings and refuses formatted ones', () => {
  assert.equal(coerceCellValue(5), 5)
  assert.equal(coerceCellValue(-0.5), -0.5)
  assert.equal(coerceCellValue(0), 0)
  // A JSON API sending "142" is ordinary dirty data with no ambiguity.
  assert.equal(coerceCellValue('142'), 142)
  assert.equal(coerceCellValue(' 3.5 '), 3.5)
  assert.equal(coerceCellValue('1e3'), 1000)
  // A thousands separator means upstream display formatting: refusing it is the
  // point, because tolerating it invites worse input.
  assert.equal(coerceCellValue('18,540'), null)
  assert.equal(coerceCellValue('1.2k'), null)
  assert.equal(coerceCellValue('3%'), null)
  for (const absent of ['', '   ', 'N/A', 'null', null, undefined, NaN, Infinity, true, {}, []]) {
    assert.equal(coerceCellValue(absent), null, `${String(absent)} is an absence, not a zero`)
  }
})

test('normalizeLabel names a blank label instead of dropping the axis slot', () => {
  assert.equal(normalizeLabel('USB-3'), 'USB-3')
  assert.equal(normalizeLabel(2026), '2026')
  assert.equal(normalizeLabel(false), 'false')
  assert.equal(normalizeLabel(''), BLANK_LABEL)
  assert.equal(normalizeLabel('   '), BLANK_LABEL)
  assert.equal(normalizeLabel(null), BLANK_LABEL)
  assert.equal(normalizeLabel(NaN), BLANK_LABEL)
})

// ─────────────────────────────────────────────── grid assembly

test('prepareHeatmap builds a rectangular grid in first-appearance order', () => {
  const grid = prepareHeatmap({
    rows: [
      { r: 'B', c: 'y', v: 2 },
      { r: 'A', c: 'x', v: 1 },
      { r: 'B', c: 'x', v: 3 },
    ],
    row: (d) => d.r,
    col: (d) => d.c,
    value: (d) => d.v,
  })
  assert.deepEqual(grid.rowLabels, ['B', 'A'])
  assert.deepEqual(grid.colLabels, ['y', 'x'])
  assert.equal(grid.rowCount, 2)
  assert.equal(grid.colCount, 2)
  assert.equal(grid.cells[0][1].value, 3)
  assert.equal(grid.cells[1][0].value, null, 'a hole stays a hole')
  assert.equal(grid.cells[1][0].reason, 'no-record')
  assert.equal(grid.missing, 1)
  assert.equal(grid.filled, 3)
  assert.deepEqual(grid.values, [2, 3, 1])
})

test('prepareHeatmap averages duplicate cells and counts the merge', () => {
  const grid = prepareHeatmap({
    rows: [
      { r: 'R', c: 'C1', v: 10 },
      { r: 'R', c: 'C1', v: 20 },
      { r: 'R', c: 'C2', v: 5 },
    ],
    row: (d) => d.r, col: (d) => d.c, value: (d) => d.v,
  })
  // Two records in one cell: an average is defensible, a silent overwrite is not.
  assert.equal(grid.cells[0][0].value, 15)
  assert.equal(grid.cells[0][0].n, 2)
  assert.equal(grid.duplicates, 1)
  assert.equal(grid.values.length, 2, 'the merged cell contributes one value, not two')
})

test('prepareHeatmap separates a hole from an unusable value', () => {
  const grid = prepareHeatmap({
    rows: [
      { r: 'R1', c: 'C1', v: 'nonsense' },
      { r: 'R1', c: 'C2', v: 4 },
      { r: 'R2', c: 'C1', v: NaN },
    ],
    row: (d) => d.r,
    col: (d) => d.c,
    value: (d) => d.v,
  })
  // R1C1 had a record whose value was unusable; R2C2 had no record at all. The
  // reader is entitled to know which happened.
  assert.equal(grid.cells[0][0].reason, 'unusable-value')
  assert.equal(grid.cells[1][1].reason, 'no-record')
  assert.equal(grid.cells[1][0].reason, 'unusable-value')
  assert.equal(grid.rejected, 2)
  assert.equal(grid.missing, 3)
  assert.equal(grid.allMissing, false)
  assert.equal(grid.cells[0][1].value, 4)
})

test('prepareHeatmap counts string values it converted and labels it had to name', () => {
  const grid = prepareHeatmap({
    rows: [
      { r: 'R', c: '', v: '142' },
      { r: 'R', c: 'C2', v: 1 },
    ],
    row: (d) => d.r,
    col: (d) => d.c,
    value: (d) => d.v,
  })
  assert.equal(grid.coerced, 1, 'the conversion is reported, not silent')
  assert.equal(grid.cells[0][0].value, 142)
  assert.equal(grid.blankLabels, 1)
  assert.deepEqual(grid.colLabels, [BLANK_LABEL, 'C2'])
})

test('prepareHeatmap keeps every value out of a hole it did not invent', () => {
  const grid = prepareHeatmap({ rows: [{ r: 'R', c: 'C', v: 1 }] })
  assert.equal(grid.cells.length * grid.cells[0].length, 1)
  const wide = prepareHeatmap({
    rows: [{ r: 'A', c: 'x', v: 1 }],
    row: (d) => d.r, col: (d) => d.c, value: (d) => d.v,
    colOrder: ['x', 'y', 'z'],
  })
  // An explicitly ordered axis is honoured even for labels the data never
  // mentions: "this column reported nothing" is worth a blank cell.
  assert.deepEqual(wide.colLabels, ['x', 'y', 'z'])
  assert.equal(wide.colCount, 3)
  assert.equal(wide.missing, 2)
  assert.equal(wide.extraCols, 2)
})

test('prepareHeatmap appends labels missing from an explicit order instead of dropping them', () => {
  const grid = prepareHeatmap({
    rows: [
      { r: 'A', c: 'x', v: 1 },
      { r: 'Z', c: 'y', v: 2 },
    ],
    row: (d) => d.r, col: (d) => d.c, value: (d) => d.v,
    rowOrder: ['A'],
  })
  assert.deepEqual(grid.rowLabels, ['A', 'Z'])
  assert.equal(grid.unlistedRows, 1)
  assert.equal(grid.cells[1][1].value, 2, 'the unlisted row keeps its data')
})

test('prepareHeatmap detects a numeric axis whose spacing is not even', () => {
  // 2020, 2021, 2022, 2030 drawn as four equal bands is a distortion. It is
  // allowed -- both axes are categorical -- but it must not be silent.
  const uneven = prepareHeatmap({
    rows: [2020, 2021, 2022, 2030].map((y) => ({ y, c: 'x', v: y })),
    row: (d) => d.y, col: (d) => d.c, value: (d) => d.v,
  })
  assert.equal(uneven.rowSpacingUneven, true)

  const even = prepareHeatmap({
    rows: [2020, 2021, 2022, 2023].map((y) => ({ y, c: 'x', v: y })),
    row: (d) => d.y, col: (d) => d.c, value: (d) => d.v,
  })
  assert.equal(even.rowSpacingUneven, false)

  const named = prepareHeatmap({
    rows: ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => ({ q, c: 'x', v: 1 })),
    row: (d) => d.q, col: (d) => d.c, value: (d) => d.v,
  })
  assert.equal(named.rowSpacingUneven, false, 'text labels have no spacing to be uneven about')
})

test('prepareHeatmap survives empty, null and hostile input', () => {
  for (const input of [undefined, null, [], 'nonsense', 42, [null, undefined, 7]]) {
    const grid = prepareHeatmap({ rows: input })
    assert.ok(Array.isArray(grid.cells))
    assert.equal(typeof grid.empty, 'boolean')
    assert.equal(grid.rowCount, grid.cells.length)
    assert.ok(Number.isFinite(grid.missing))
  }
  assert.equal(prepareHeatmap({ rows: [] }).empty, true)
  // An accessor that throws must not take the chart down with it.
  const throwing = prepareHeatmap({
    rows: [{}, {}],
    row: () => { throw new Error('boom') },
  })
  assert.equal(throwing.rejected, 2)
  assert.equal(throwing.empty, true)
})

// ─────────────────────────────────────────────── tooltip markup

test('heatTipHtml gives the full reading: both labels, value, class and record count', () => {
  const html = heatTipHtml(
    { row: 'USB-3', col: '2026-08-01', value: 42.5, n: 3, step: 2 },
    { edges: [0, 10, 20, 30, 40, 50], bins: 5, ramp: HEAT_RAMP },
  )
  assert.ok(html.includes('2026-08-01'), 'the column label is the title')
  assert.ok(html.includes('USB-3'), 'the row label is present')
  assert.ok(html.includes('42.5'), 'the value is present')
  assert.ok(html.includes('20') && html.includes('30'), 'the class range is present')
  assert.ok(html.includes('>3<') || html.includes('3</b>'), 'the record count is present')
})

test('heatTipHtml says why a cell is blank, and which reason', () => {
  const hole = heatTipHtml({ row: 'R', col: 'C', value: null, n: 0, reason: 'no-record' })
  assert.ok(hole.includes('无数据'))
  assert.ok(hole.includes('该格没有记录'))
  const bad = heatTipHtml({ row: 'R', col: 'C', value: null, n: 0, reason: 'unusable-value' })
  assert.ok(bad.includes('数值不可用'))
  assert.equal(heatTipHtml(null), '')
})

test('heatTipHtml escapes every label it prints', () => {
  // Labels come from data. This is the whole reason the markup lives in a pure
  // function: escaping that can only be checked by looking at a browser is
  // escaping that is never checked.
  const html = heatTipHtml({
    row: '<img src=x onerror=alert(1)>',
    col: '" onmouseover="alert(2)',
    value: 1,
    n: 1,
    step: 0,
  }, { edges: [0, 1], bins: 1 })
  assert.ok(!html.includes('<img'), 'a label must never become an element')
  assert.ok(!html.includes('onerror=alert(1)>'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(!/onmouseover="alert/.test(html), 'a quote in a label must not break out of an attribute')
})

// ─────────────────────────────────────────────── keyboard

test('moveCell clamps at the edges and ignores non-navigation keys', () => {
  const dims = { rows: 3, cols: 4 }
  assert.deepEqual(moveCell({ r: 0, c: 0 }, 'ArrowRight', dims), { r: 0, c: 1 })
  assert.deepEqual(moveCell({ r: 0, c: 0 }, 'ArrowLeft', dims), { r: 0, c: 0 }, 'the left edge holds')
  assert.deepEqual(moveCell({ r: 2, c: 3 }, 'ArrowDown', dims), { r: 2, c: 3 })
  assert.deepEqual(moveCell({ r: 0, c: 3 }, 'End', dims), { r: 0, c: 3 })
  assert.deepEqual(moveCell({ r: 2, c: 3 }, 'Home', dims), { r: 2, c: 0 })
  assert.deepEqual(moveCell(null, 'ArrowDown', dims), { r: 1, c: 0 }, 'no cursor starts at the origin')
  assert.deepEqual(moveCell({ r: 1, c: 1 }, 'PageDown', dims), { r: 2, c: 1 })
  assert.equal(moveCell({ r: 0, c: 0 }, 'Enter', dims), null, 'activation is not movement')
  assert.equal(moveCell({ r: 0, c: 0 }, 'ArrowRight', { rows: 0, cols: 0 }), null)
})

test('resolveCell accepts an index, a label pair or an index pair', () => {
  const axes = { rowLabels: ['A', 'B'], colLabels: ['x', 'y', 'z'] }
  assert.deepEqual(resolveCell(0, axes), { r: 0, c: 0 })
  assert.deepEqual(resolveCell(4, axes), { r: 1, c: 1 })
  assert.deepEqual(resolveCell({ row: 'B', col: 'z' }, axes), { r: 1, c: 2 })
  assert.deepEqual(resolveCell({ row: 1, col: 0 }, axes), { r: 1, c: 0 })
  assert.equal(resolveCell(6, axes), null, 'an out-of-range index clears rather than wraps')
  assert.equal(resolveCell(-1, axes), null)
  assert.equal(resolveCell({ row: 'nope', col: 'x' }, axes), null)
  assert.equal(resolveCell(null, axes), null)
  assert.equal(resolveCell('A', axes), null)
})

// ─────────────────────────────────────────────── minimal DOM stub
//
// NOT a browser. It cannot answer "does this look right". It answers "does this
// run, does it paint every cell once, does it keep its contract, and does it let
// go on destroy" -- which is more than a renderer with no tests at all can say.

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    style: {},
    attrs: {},
    children: [],
    textContent: '',
    clientWidth: 0,
    offsetWidth: 140,
    offsetHeight: 64,
    listeners: new Map(),
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute(k, v) {
      this.attrs[k] = String(v)
      if (k === 'width') this._w = Number(v)
      if (k === 'height') this._h = Number(v)
    },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k] },
    append(...kids) { for (const k of kids) this.children.push(k) },
    appendChild(k) { this.children.push(k); return k },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, [])
      this.listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = this.listeners.get(type)
      if (!list) return
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    getBoundingClientRect() {
      const w = this._w || this.clientWidth || 600
      const h = this._h || 320
      return { left: 0, top: 0, right: w, bottom: h, width: w, height: h }
    },
    fire(type, event) {
      for (const fn of (this.listeners.get(type) || []).slice()) fn(event)
    },
  }
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html },
    set(v) {
      this._html = String(v)
      if (this._html === '') this.children.length = 0
    },
  })
  el._html = ''
  return el
}

const W = 600
const H = 320
const PAD = { top: 58, right: 14, bottom: 34, left: 78 }

/** Centre of a cell, derived independently of the renderer's own arithmetic. */
function centreOf(r, c, rows, cols) {
  const bw = (W - PAD.left - PAD.right) / cols
  const bh = (H - PAD.top - PAD.bottom) / rows
  return { clientX: PAD.left + bw * c + bw / 2, clientY: PAD.top + bh * r + bh / 2 }
}

function installDom() {
  const g = globalThis
  const previous = {
    document: g.document,
    ResizeObserver: g.ResizeObserver,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
  }
  const frames = new Map()
  const observers = []
  let nextId = 1
  g.document = { createElementNS: (ns, tag) => makeEl(tag), createElement: (tag) => makeEl(tag) }
  g.ResizeObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this) }
    observe() {}
    unobserve() {}
    disconnect() { this.disconnected = true }
  }
  // Queued, not immediate: exactly like a real frame, so the tests can prove
  // that several events produce one redraw.
  g.requestAnimationFrame = (cb) => { const id = nextId++; frames.set(id, cb); return id }
  g.cancelAnimationFrame = (id) => { frames.delete(id) }
  const host = makeEl('div')
  host.clientWidth = W
  return {
    host,
    observers,
    flush() {
      const pending = Array.from(frames.values())
      frames.clear()
      for (const cb of pending) cb()
    },
    pending: () => frames.size,
    restore() {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete g[k]
        else g[k] = v
      }
    },
  }
}

const svgOf = (host) => host.children.find((c) => c.tagName === 'SVG')
const byClass = (host, cls) => host.children.find((c) => c.className === cls)
const pathsOf = (markup) => Array.from(markup.matchAll(/<path d="([^"]*)" fill="([^"]*)"\/>/g))
  .map((m) => ({ d: m[1], fill: m[2] }))
const mCount = (d) => (d.match(/M/g) || []).length

/** A 2x3 grid with one deliberate hole. */
function gridFixture() {
  const rows = []
  for (const r of ['r0', 'r1']) {
    for (const c of ['c0', 'c1', 'c2']) {
      if (r === 'r1' && c === 'c1') continue
      rows.push({ r, c, v: 10 + rows.length })
    }
  }
  return { rows, row: (d) => d.r, col: (d) => d.c, value: (d) => d.v }
}

test('heatmapChart throws without a host, like its siblings', () => {
  assert.throws(() => heatmapChart(null), /host element is required/)
})

test('heatmapChart returns the same API shape as line and bar', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, gridFixture())
    for (const key of ['update', 'select', 'data', 'destroy']) {
      assert.equal(typeof chart[key], 'function', `missing ${key}()`)
    }
    assert.equal(typeof chart.data().rowCount, 'number')
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('one frame redraws once, however many events arrived', () => {
  const dom = installDom()
  try {
    let renders = 0
    const chart = heatmapChart(dom.host, { ...gridFixture(), onRender: () => { renders += 1 } })
    assert.equal(dom.pending(), 1, 'the first draw is queued, not immediate')
    assert.equal(renders, 0)
    dom.flush()
    assert.equal(renders, 1)

    for (const cell of [centreOf(0, 0, 2, 3), centreOf(0, 1, 2, 3), centreOf(0, 2, 2, 3)]) {
      dom.host.fire('mousemove', cell)
    }
    assert.equal(dom.pending(), 1, 'three hovers must not queue three redraws')
    dom.flush()
    assert.equal(renders, 2, 'and they must not all be lost either')
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('every cell is painted exactly once, and a hole is hatched rather than shaded', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, gridFixture())
    dom.flush()
    const markup = svgOf(dom.host).innerHTML
    const paths = pathsOf(markup)

    const total = paths.reduce((sum, p) => sum + mCount(p.d), 0)
    assert.equal(total, 6, 'six cells, six rectangles, no overlap and none forgotten')

    const holes = paths.filter((p) => p.fill.includes('url(#heatmiss-'))
    assert.equal(holes.length, 1, 'the hole needs its own path')
    assert.equal(mCount(holes[0].d), 1)
    assert.ok(markup.includes('<pattern id="heatmiss-'), 'the hatch pattern is defined')

    // The hole must not be painted with any ramp step -- that is the whole point.
    const rampFills = new Set(paths.filter((p) => p.fill.startsWith('var(')).map((p) => p.fill))
    for (const fill of rampFills) assert.notEqual(fill, MISSING_FILL)
    assert.ok(rampFills.size >= 1)
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('no literal colour ever reaches the markup', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, gridFixture())
    dom.flush()
    const markup = svgOf(dom.host).innerHTML + byClass(dom.host, 'chart-heat-legend').innerHTML
    // The package's rule: components name tokens, never colours.
    assert.ok(!/#[0-9a-fA-F]{3}/.test(markup), `a hex colour appeared: ${markup.match(/#[0-9a-fA-F]{3,8}/)}`)
    assert.ok(!/rgba?\(|hsla?\(/.test(markup), 'a raw colour function appeared')
    for (const fill of Array.from(markup.matchAll(/fill="([^"]*)"/g)).map((m) => m[1])) {
      assert.ok(
        /^var\(--chart-[a-z0-9-]+\)$/.test(fill) || /^url\(#heatmiss-\d+\)$/.test(fill) || fill === 'none',
        `unexpected fill: ${fill}`,
      )
    }
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('data labels are escaped in the overlay and never enter the SVG', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, {
      rows: [{ r: '<img src=x onerror=alert(1)>', c: 'C', v: 1 }],
      row: (d) => d.r, col: (d) => d.c, value: (d) => d.v,
    })
    dom.flush()
    const svg = svgOf(dom.host)
    assert.ok(!svg.innerHTML.includes('<img'), 'nothing from the data may become markup in the SVG')
    assert.ok(!svg.innerHTML.includes('onerror'), 'and nothing from the data enters the SVG at all')
    const labels = byClass(dom.host, 'chart-ylab')
    assert.ok(labels.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped in the HTML overlay')
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('the legend states what colour means what number, and names the missing tile', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, gridFixture())
    dom.flush()
    const legend = byClass(dom.host, 'chart-heat-legend')
    const swatches = Array.from(legend.innerHTML.matchAll(/background:(var\(--chart-[a-z0-9-]+\))/g)).map((m) => m[1])
    assert.ok(swatches.length >= 2, 'at least two classes for this fixture')
    // Every swatch is a ramp token, except the single missing-data tile, which is
    // deliberately NOT on the ramp.
    const rampSwatches = swatches.filter((t) => t !== MISSING_FILL)
    assert.equal(swatches.length - rampSwatches.length, 1, 'exactly one missing-data swatch')
    for (const token of rampSwatches) assert.ok(HEAT_RAMP.includes(token), `legend used a non-ramp token: ${token}`)
    assert.ok(legend.innerHTML.includes('无数据'), 'the missing tile is explained, not left to guesswork')
    assert.ok(/按(分位数|等距)分 \d+ 档/.test(legend.innerHTML), 'the binning method is stated on the chart')
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('hover shows a full reading in the tooltip, and the tooltip is actually visible', () => {
  const dom = installDom()
  try {
    const seen = []
    const chart = heatmapChart(dom.host, { ...gridFixture(), onHover: (cell, i) => seen.push([cell, i]) })
    dom.flush()
    const tip = byClass(dom.host, 'chart-tip')
    assert.equal(tip.style.display, 'none')

    dom.host.fire('mousemove', centreOf(0, 2, 2, 3))
    const cell = seen[seen.length - 1][0]
    assert.equal(cell.row, 'r0')
    assert.equal(cell.col, 'c2', 'the hit test must land on the cell under the pointer')
    assert.equal(seen[seen.length - 1][1], 2, 'row-major index for a 2x3 grid')
    assert.ok(tip.innerHTML.includes('r0') && tip.innerHTML.includes('c2'))
    assert.ok(tip.innerHTML.includes(String(cell.value)))

    // `.chart-tip` is `display: none` in theme.css. Clearing the inline value
    // would leave it on the CSS default and the reading would never appear --
    // a failure no screenshot of the chart would ever show. It must be 'block'.
    assert.equal(tip.style.display, 'block',
      'a hover reading must set display to a visible value, not clear it back to the CSS default')

    dom.host.fire('mouseleave', {})
    assert.equal(tip.style.display, 'none', 'and it must be hidden again when the pointer leaves')
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('clicking pins the reading, and the pin survives the pointer leaving', () => {
  const dom = installDom()
  try {
    const picks = []
    const chart = heatmapChart(dom.host, { ...gridFixture(), onSelect: (cell, i) => picks.push([cell, i]) })
    dom.flush()
    const tip = byClass(dom.host, 'chart-tip')

    const at = centreOf(1, 0, 2, 3)
    dom.host.fire('mousemove', at)
    dom.host.fire('click', at)
    assert.equal(picks.length, 1)
    assert.equal(picks[0][0].col, 'c0')
    assert.equal(picks[0][1], 3, 'row 1, column 0 of a 2x3 grid')

    dom.host.fire('mouseleave', {})
    assert.equal(tip.style.display, 'block', 'a pinned cell keeps its reading on screen')
    assert.ok(tip.innerHTML.includes('r1'))

    // Clicking the same cell again releases it.
    dom.host.fire('click', at)
    assert.equal(picks[1][0], null)
    assert.equal(tip.style.display, 'none')
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('a pinned cell is drawn differently from a hovered one', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, gridFixture())
    dom.flush()
    const at = centreOf(0, 0, 2, 3)
    dom.host.fire('mousemove', at)
    dom.flush()
    const hoverMarkup = svgOf(dom.host).innerHTML
    assert.ok(hoverMarkup.includes('stroke-dasharray="4 3"'), 'hover is a thin dashed outline')

    dom.host.fire('click', at)
    dom.flush()
    const pinned = svgOf(dom.host).innerHTML
    assert.ok(pinned.includes('var(--chart-accent)'), 'the pin carries the accent, so it reads as chosen')
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('the tooltip flips to the other side near the right edge', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, gridFixture())
    dom.flush()
    const tip = byClass(dom.host, 'chart-tip')
    const left = centreOf(0, 0, 2, 3)
    dom.host.fire('mousemove', left)
    const leftSide = Number.parseFloat(tip.style.left)
    assert.ok(leftSide > left.clientX, 'a cell on the left keeps the panel to its right')

    const right = centreOf(0, 2, 2, 3)
    dom.host.fire('mousemove', right)
    const rightSide = Number.parseFloat(tip.style.left)
    assert.ok(rightSide + tip.offsetWidth <= right.clientX,
      'a cell near the right edge must flip, or the panel hangs off the plot')
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('the keyboard reaches every cell, pins one, and always has a way out', () => {
  const dom = installDom()
  try {
    const picks = []
    const chart = heatmapChart(dom.host, { ...gridFixture(), onSelect: (cell) => picks.push(cell) })
    dom.flush()
    const tip = byClass(dom.host, 'chart-tip')

    dom.host.fire('focus', {})
    assert.equal(tip.style.display, 'block', 'focusing the chart gives a reading without a mouse')
    const first = dom.host.fire
    assert.ok(tip.innerHTML.includes('r0'))

    dom.host.fire('keydown', { key: 'ArrowDown', preventDefault() {} })
    dom.host.fire('keydown', { key: 'ArrowRight', preventDefault() {} })
    assert.ok(tip.innerHTML.includes('r1') && tip.innerHTML.includes('c1'), 'arrow keys move the reading')

    dom.host.fire('keydown', { key: 'Enter', preventDefault() {} })
    assert.equal(picks.length, 1)
    assert.equal(picks[0].row, 'r1')

    dom.host.fire('keydown', { key: 'Escape', preventDefault() {} })
    assert.equal(picks[1], null, 'Escape must clear the pin, or the panel looks stuck')
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('select() pins by index and by label, and clears on null', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, gridFixture())
    dom.flush()
    const tip = byClass(dom.host, 'chart-tip')

    chart.select(5)
    dom.flush()
    assert.equal(tip.style.display, 'block')
    assert.ok(tip.innerHTML.includes('c2') && tip.innerHTML.includes('r1'), 'index 5 is the last cell')

    chart.select({ row: 'r0', col: 'c1' })
    dom.flush()
    assert.ok(tip.innerHTML.includes('r0'))

    chart.select(null)
    dom.flush()
    assert.equal(tip.style.display, 'none')
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('the chart reserves its height before data arrives', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, { rows: [] })
    dom.flush()
    // Empty is not "no height": a chart that grows when data lands pushes the
    // page around, which is the one layout failure the skill calls measurable.
    assert.equal(dom.host.style.height, `${H}px`)
    assert.equal(svgOf(dom.host).getAttribute('aria-label'), 'No data')
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('an all-missing grid still draws its lattice, hatched and explained', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, {
      rows: [{ r: 'A', c: 'x', v: NaN }, { r: 'B', c: 'x', v: null }],
      row: (d) => d.r, col: (d) => d.c, value: (d) => d.v,
    })
    dom.flush()
    const paths = pathsOf(svgOf(dom.host).innerHTML)
    assert.equal(paths.length, 1, 'with no usable value there is exactly one, hatched, path')
    assert.ok(paths[0].fill.includes('url(#heatmiss-'))
    assert.equal(mCount(paths[0].d), 2)
    // Dropping two of two records silently would be worse than failing.
    const note = byClass(dom.host, 'chart-heat-note')
    assert.ok(note.textContent.includes('已忽略 2 条'), `note was: ${note.textContent}`)
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('ignored records, merges and uneven numeric axes are all surfaced on the chart', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, {
      rows: [
        { r: '2020', c: 'x', v: 1 },
        { r: '2020', c: 'x', v: 3 },
        { r: '2021', c: 'x', v: 2 },
        { r: '2025', c: 'x', v: 'oops' },
        { r: '2030', c: 'x', v: 4 },
      ],
      row: (d) => d.r, col: (d) => d.c, value: (d) => d.v,
    })
    dom.flush()
    const note = byClass(dom.host, 'chart-heat-note').textContent
    assert.ok(note.includes('已忽略 1 条'), note)
    assert.ok(note.includes('1 条重复记录按格取平均'), note)
    assert.ok(note.includes('间距不等'), note)
    const info = chart.data()
    assert.equal(info.rowSpacingUneven, true)
    assert.equal(info.duplicates, 1)

    // And the arithmetic the chart will actually use is the binning from core.
    assert.ok(info.colorScale.edges.length >= 2)
    assert.equal(info.bins, info.colorScale.bins)
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('a data swap that shrinks the grid does not leave a dangling pin or crash', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, gridFixture())
    dom.flush()
    const at = centreOf(1, 2, 2, 3)
    dom.host.fire('click', at)
    dom.flush()
    assert.equal(byClass(dom.host, 'chart-tip').style.display, 'block')

    chart.update({ rows: [{ r: 'only', c: 'one', v: 1 }], row: (d) => d.r, col: (d) => d.c, value: (d) => d.v })
    dom.flush()
    // The old pin pointed at a cell that no longer exists: it must be dropped,
    // not indexed into.
    const tip = byClass(dom.host, 'chart-tip')
    assert.equal(tip.style.display, 'none')
    assert.equal(chart.data().rowCount, 1)
    // A resize after the swap must also survive.
    dom.observers[0].cb()
    dom.flush()
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('destroy() lets go of the listeners, the frame and the DOM', () => {
  const dom = installDom()
  try {
    const seen = []
    const chart = heatmapChart(dom.host, { ...gridFixture(), onHover: (cell) => seen.push(cell) })
    dom.flush()
    dom.host.fire('mousemove', centreOf(0, 0, 2, 3))
    assert.equal(seen.length, 1)

    chart.destroy()
    assert.equal(dom.observers[0].disconnected, true, 'the observer must be disconnected')
    assert.equal(dom.pending(), 0, 'a queued frame must be cancelled, not left to fire')
    assert.equal(dom.host.children.length, 0, 'and the overlay must be gone')
    dom.flush()
    assert.equal(seen.length, 1, 'events after destroy must not reach the callbacks')
    dom.host.fire('click', centreOf(0, 0, 2, 3))
    assert.ok(true, 'a click after destroy must not throw')
  } finally {
    dom.restore()
  }
})
