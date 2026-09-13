/**
 * Box plot renderer tests.
 *
 * The rest of the suite tests pure computation, because that is where most bugs
 * live. A renderer is different: its failures are structural and geometric --
 * text that ended up inside the stretched SVG, a literal colour that bypassed
 * the theme, a whisker that reached past the real data, an unescaped label --
 * and every one of those is visible in the markup it produces.
 *
 * So this file drives the real `boxplotChart` through a small DOM stub instead
 * of testing a reimplementation of it. The stub only fills the gap node has (no
 * layout engine, no frames); the component itself touches `document`,
 * `requestAnimationFrame` and `ResizeObserver` nowhere but inside the factory.
 *
 * The assertions are written to be falsifiable: each one names the specific
 * broken implementation it would catch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { boxplotChart, MIN_BOX_SIZE } from '../src/boxplot.js'
import { boxStats } from '../src/core.js'
import { hostileLabels } from './fixtures/complex-data.js'

const SRC = readFileSync(fileURLToPath(new URL('../src/boxplot.js', import.meta.url)), 'utf8')

/**
 * The inline value that actually makes the panel visible.
 *
 * theme.css sets `.chart-tip { display: none }`. Clearing the inline style
 * (`display = ''`) therefore falls back to `none` and the tooltip never
 * appears -- a failure no static screenshot can show. So "shown" is asserted as
 * the exact value `block`; asserting `!== 'none'` would pass on the broken
 * implementation and is exactly the kind of assertion that cannot fail.
 */
const SHOWN = 'block'

// ─────────────────────────────────────────────── minimal DOM stub

function stubElement(tag, box) {
  const listeners = {}
  const el = {
    tagName: tag,
    className: '',
    textContent: '',
    innerHTML: '',
    children: [],
    attrs: {},
    dataset: {},
    style: {},
    clientWidth: box.width,
    clientHeight: box.height,
    tabIndex: 0,
    offsetWidth: 120,
    _listeners: listeners,
    setAttribute(k, v) { el.attrs[k] = String(v) },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null },
    append(...kids) { for (const k of kids) el.children.push(k) },
    appendChild(k) { el.children.push(k) },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn) },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn)
    },
    getBoundingClientRect() { return box },
    /** Test-only: dispatch an event to the handlers the component registered. */
    fire(type, ev = {}) {
      for (const fn of [...(listeners[type] || [])]) fn(ev)
    },
  }
  el.classList = {
    add: (c) => { el.className = `${el.className} ${c}`.trim() },
    remove: () => {},
  }
  return el
}

/**
 * Install the globals the component needs and expose the pending frames.
 * `flush()` runs what a browser frame would run, so "one redraw per frame" is
 * something the tests can actually observe rather than assume.
 */
function installDom({ width = 600, height = 300 } = {}) {
  const box = { left: 0, top: 0, width, height }
  const created = []
  const rafs = new Map()
  const observers = []
  let seq = 0

  const make = (tag) => {
    const el = stubElement(tag, box)
    el.id = `n${seq++}`
    created.push(el)
    return el
  }

  globalThis.document = {
    createElement: make,
    createElementNS: (_ns, tag) => make(tag),
  }
  globalThis.requestAnimationFrame = (fn) => { rafs.set(++seq, fn); return seq }
  globalThis.cancelAnimationFrame = (id) => { rafs.delete(id) }
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this) }
    observe() {}
    disconnect() { this.cb = null }
  }

  return {
    created,
    observers,
    flush() {
      for (let guard = 0; guard < 20 && rafs.size; guard++) {
        const pending = [...rafs.entries()]
        rafs.clear()
        for (const [, fn] of pending) fn(16)
      }
    },
    pendingFrames: () => rafs.size,
    /** Pretend the container was resized. */
    resize() { for (const o of observers) if (o.cb) o.cb([]) },
  }
}

/** Boot a chart and return everything a test might want to look at. */
function mount(options = {}, domOptions = {}) {
  const dom = installDom(domOptions)
  const host = document.createElement('div')
  const renders = []
  const hovers = []
  const selects = []
  const chart = boxplotChart(host, {
    onRender: (s) => renders.push(s),
    onHover: (g, i) => hovers.push([g, i]),
    onSelect: (g, i) => selects.push([g, i]),
    ...options,
  })
  dom.flush()

  const byClass = (c) => dom.created.find((e) => e.className === c)
  const svg = dom.created.find((e) => e.tagName === 'svg')
  return {
    dom, host, chart, renders, hovers, selects, svg,
    tip: byClass('chart-tip'),
    xlab: byClass('chart-xlab'),
    note: byClass('chart-note'),
    get html() { return svg.innerHTML },
    hover: (clientX) => host.fire('mousemove', { clientX }),
    leave: () => host.fire('mouseleave', {}),
    click: (clientX) => host.fire('click', { clientX }),
    key: (k) => host.fire('keydown', { key: k, preventDefault() {} }),
  }
}

/** The whole `<g ...>…</g>` block a group rendered. */
function groupBlock(html, i) {
  const m = html.match(new RegExp(`<g data-group="${i}"[^>]*>[\\s\\S]*?</g>`))
  return m ? m[0] : null
}

/** One attribute of a group's opening tag, or null. */
function groupAttr(html, i, name) {
  const block = groupBlock(html, i)
  if (!block) return null
  const tag = block.slice(0, block.indexOf('>') + 1)
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  return m ? m[1] : null
}

/** A group of roughly-normal-looking numbers. Always >= MIN_BOX_SIZE. */
function series(from, to, step = 1) {
  const out = []
  for (let v = from; v <= to; v += step) out.push(v)
  return out
}

// ─────────────────────────────────────────────── the small-n judgement

test('a box is only drawn once a box means something', () => {
  // MIN_BOX_SIZE - 1 observations: quartiles would be interpolated between one
  // or two points, so the box would be noise drawn at a distribution's size.
  const small = mount({ groups: [{ key: 'a', label: 'a', values: series(1, MIN_BOX_SIZE - 1) }] })
  assert.equal(groupAttr(small.html, 0, 'data-mode'), 'points',
    'under the threshold the group must be drawn as points')
  assert.equal(groupAttr(small.html, 0, 'data-n'), String(MIN_BOX_SIZE - 1))
  assert.ok(!/<rect x=/.test(groupBlock(small.html, 0)), 'no box rect may be drawn for a small sample')
  assert.equal((groupBlock(small.html, 0).match(/<circle/g) || []).length, MIN_BOX_SIZE - 1,
    'every observation must be drawn')
  assert.match(small.note.textContent, /n </, 'the threshold must be stated on screen')

  const enough = mount({ groups: [{ key: 'a', label: 'a', values: series(1, MIN_BOX_SIZE) }] })
  assert.equal(groupAttr(enough.html, 0, 'data-mode'), 'box', 'at the threshold a box is drawn')
  assert.ok(/<rect x=/.test(groupBlock(enough.html, 0)), 'the box must be a real rect')
  assert.equal((groupBlock(enough.html, 0).match(/<circle/g) || []).length, 0,
    'a boxed group does not scatter its observations')

  // The threshold is a product decision, so a caller who knows better can move it.
  const custom = mount({
    minBoxSize: 3,
    groups: [{ key: 'a', label: 'a', values: [1, 2, 3, 4] }],
  })
  assert.equal(groupAttr(custom.html, 0, 'data-mode'), 'box', 'minBoxSize must be honoured')
})

test('the small-n rule is stated, not silent', () => {
  const m = mount({
    groups: [
      { key: 'few', label: 'few', values: [1, 2, 3] },
      { key: 'many', label: 'many', values: series(1, 20) },
    ],
  })
  assert.match(m.note.textContent, /n < 12/, 'the reader is told why one group looks different')
  assert.match(m.svg.getAttribute('aria-label'), /样本少于 12/)
  assert.equal(groupAttr(m.html, 1, 'data-mode'), 'box', 'the other group is unaffected')
  assert.equal(groupAttr(m.html, 0, 'data-n'), '3')
})

// ─────────────────────────────────────────────── Tukey

test('whiskers reach the furthest real point inside 1.5 x IQR, never an outlier', () => {
  const values = [...series(1, 13), 100]
  const m = mount({ groups: [{ key: 'a', label: 'a', values }] })
  const truth = boxStats(values, { iqrFactor: 1.5 })

  assert.equal(truth.outliers.length, 1, 'fixture sanity: one outlier is present')
  assert.equal(Number(groupAttr(m.html, 0, 'data-lo')), truth.min)
  assert.equal(Number(groupAttr(m.html, 0, 'data-hi')), truth.max)
  assert.equal(Number(groupAttr(m.html, 0, 'data-q1')), truth.q1)
  assert.equal(Number(groupAttr(m.html, 0, 'data-q3')), truth.q3)
  assert.equal(Number(groupAttr(m.html, 0, 'data-median')), truth.median)
  // The tempting wrong whisker is min/max; that would make the outlier vanish
  // into the whisker and hide the very thing a box plot exists to show.
  assert.notEqual(Number(groupAttr(m.html, 0, 'data-hi')), 100, 'the whisker must not reach the outlier')
  assert.equal(Number(groupAttr(m.html, 0, 'data-outliers')), 1)
  assert.equal((groupBlock(m.html, 0).match(/<circle/g) || []).length, 1,
    'the outlier is drawn on its own')
  // A lone outlier 100x from the body is the point of the chart, not a reason to
  // cap the axis: the box is still ~16px tall here, so nothing is dropped.
  assert.equal(m.renders[0].trimmed, 0, 'an ordinary outlier must not be trimmed away')
  assert.equal(m.note.textContent, '', 'and no truncation note is claimed')
})

test('the drawn geometry actually follows those statistics', () => {
  // The data-* attributes prove what was handed to the renderer; this proves the
  // renderer used it. An implementation that drew the whisker to the raw maximum
  // would still report Tukey numbers in its attributes.
  const m = mount({ groups: [{ key: 'a', label: 'a', values: [...series(1, 13), 100] }] })
  const block = groupBlock(m.html, 0)

  const box = block.match(/<rect x="([-\d.]+)" y="([-\d.]+)" width="[-\d.]+" height="([-\d.]+)"/)
  assert.ok(box, 'the box is drawn as a rect')
  const boxTop = Number(box[2])
  const boxBottom = boxTop + Number(box[3])

  const lines = [...block.matchAll(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g)]
    .map((x) => ({ x1: +x[1], y1: +x[2], x2: +x[3], y2: +x[4] }))
  const vertical = lines.filter((l) => l.x1 === l.x2)
  const horizontals = lines.filter((l) => l.y1 === l.y2)
    .map((l) => ({ y: l.y1, w: Math.abs(l.x2 - l.x1) }))
  const median = horizontals.reduce((a, b) => (b.w > a.w ? b : a))
  const caps = horizontals.filter((h) => h !== median).map((h) => h.y).sort((a, b) => a - b)

  assert.equal(vertical.length, 2, 'both whiskers are drawn')
  assert.equal(caps.length, 2, 'both whisker caps are drawn')
  assert.ok(caps[0] < boxTop, 'the upper cap sits above the box')
  assert.ok(caps[1] > boxBottom, 'the lower cap sits below the box')
  assert.ok(median.y > caps[0] && median.y < caps[1], 'the median line sits between the caps')
  assert.ok(median.y >= boxTop - 0.5 && median.y <= boxBottom + 0.5, 'and inside the box')

  // The whisker must stop short of the outlier, and the outlier is drawn beyond
  // it -- the whole point of separating the two.
  const outlierY = Math.min(...[...block.matchAll(/<circle[^>]*cy="([-\d.]+)"/g)].map((x) => +x[1]))
  assert.ok(outlierY < caps[0], `the outlier must be drawn beyond the whisker (${outlierY} vs ${caps[0]})`)
})

test('no outliers is reported as no outliers, not left blank', () => {
  const m = mount({ groups: [{ key: 'a', label: 'a', values: series(100, 112) }] })
  assert.equal(groupAttr(m.html, 0, 'data-outliers'), '0')
  m.hover(300)
  assert.match(m.tip.innerHTML, /离群点/, 'the tooltip must say there are none')
  assert.match(m.tip.innerHTML, /无/)
})

// ─────────────────────────────────────────────── the y axis

test('the y axis fits the data instead of starting at zero', () => {
  // Latency-like values: from zero, every box collapses onto one line and the
  // differences that are the whole point become invisible.
  const m = mount({ groups: [{ key: 'a', label: 'a', values: series(100, 112) }] })
  assert.ok(m.renders[0].domain[0] > 0, `domain must be fitted, got ${m.renders[0].domain}`)
  assert.ok(m.renders[0].domain[1] < 120)
  const ticks = m.dom.created.find((e) => e.className === 'chart-ylab').innerHTML
  assert.ok(!/>0</.test(ticks), 'a fitted axis should not invent a zero tick')
})

test('yFromZero forces the zero baseline when that is the message', () => {
  const m = mount({ yFromZero: true, groups: [{ key: 'a', label: 'a', values: series(100, 112) }] })
  assert.equal(m.renders[0].domain[0], 0)
  assert.ok(m.renders[0].domain[1] > 112, 'the top still covers the data')
  const ticks = m.dom.created.find((e) => e.className === 'chart-ylab').innerHTML
  assert.match(ticks, />0</, 'zero must be labelled when it is on the axis')
})

test('a single extreme outlier cannot flatten every box into a line', () => {
  const base = series(50, 62)
  const m = mount({
    groups: [
      { key: 'clean', label: 'clean', values: base },
      { key: 'spiked', label: 'spiked', values: [...base, 1e6] },
    ],
  })
  const out = m.renders[0]
  assert.equal(out.trimmed, 1, 'the point that cannot be shown must be counted')
  assert.ok(out.domain[1] < 100, `the axis must stay readable, got ${out.domain[1]}`)
  assert.match(m.note.textContent, /超出显示范围/, 'the truncation is stated, not silent')

  // Nothing may be drawn outside the plot area: an off-canvas mark is invisible
  // and therefore unexplained.
  const plotH = 300 - 22 - 34
  for (const cy of [...m.html.matchAll(/<circle[^>]*cy="([-\d.]+)"/g)].map((x) => Number(x[1]))) {
    assert.ok(cy >= 22 - 1 && cy <= 22 + plotH + 1, `a mark was drawn outside the plot: cy=${cy}`)
  }
})

// ─────────────────────────────────────────────── dirty data

test('constant data renders without inventing spread', () => {
  const m = mount({ groups: [{ key: 'flat', label: 'flat', values: new Array(40).fill(88) }] })
  const out = m.renders[0]
  assert.equal(out.empty, false, 'a constant series is data, not an empty chart')
  assert.ok(out.domain[1] > out.domain[0], 'a degenerate domain must be expanded, never divided by')
  assert.equal(groupAttr(m.html, 0, 'data-flat'), '1')
  assert.equal(groupAttr(m.html, 0, 'data-mode'), 'box')
  assert.ok(!/<rect x=/.test(groupBlock(m.html, 0)), 'zero spread means no box, not a 1px fake one')
  assert.match(groupBlock(m.html, 0), /<line/, 'the median is still shown')
  m.hover(300)
  assert.match(m.tip.innerHTML, /四分位距/)
})

test('every value identical and one lone value both survive', () => {
  const single = mount({ groups: [{ key: 'one', label: 'one', values: [7] }] })
  assert.equal(single.renders[0].empty, false)
  assert.equal(groupAttr(single.html, 0, 'data-mode'), 'points')
  assert.equal(groupAttr(single.html, 0, 'data-n'), '1')
  assert.ok(single.renders[0].domain[1] > single.renders[0].domain[0])

  const allEqual = mount({ groups: [{ key: 'e', label: 'e', values: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5] }] })
  assert.equal(allEqual.renders[0].empty, false)
  assert.equal(groupAttr(allEqual.html, 0, 'data-median'), '5')
})

test('non-finite values are dropped and counted, never rendered', () => {
  const m = mount({
    groups: [{
      key: 'dirty',
      label: 'dirty',
      values: [1, 2, NaN, null, '12', undefined, Infinity, -Infinity, ...series(1, 14)],
    }],
  })
  assert.equal(m.renders[0].rejected, 6, 'six unusable values (NaN, null, string, undefined, ±Infinity)')
  assert.equal(groupAttr(m.html, 0, 'data-n'), '16', 'the count is the usable count')
  assert.equal(m.renders[0].boxes[0].values.every(Number.isFinite), true)
  assert.match(m.note.textContent, /已忽略 6 个非数值/, 'discarded data must be visible')
})

test('a group with no usable value does not stop the others', () => {
  const m = mount({
    groups: [
      { key: 'empty', label: 'empty', values: [] },
      { key: 'junk', label: 'junk', values: [null, NaN, 'n/a'] },
      { key: 'good', label: 'good', values: series(1, 14) },
    ],
  })
  assert.equal(m.renders[0].empty, false, 'one usable group is enough to draw')
  assert.equal(m.renders[0].rejected, 3)
  assert.equal(groupAttr(m.html, 0, 'data-mode'), 'empty')
  assert.equal(groupAttr(m.html, 1, 'data-mode'), 'empty')
  assert.equal(groupAttr(m.html, 1, 'data-n'), '0')
  assert.equal(groupAttr(m.html, 2, 'data-mode'), 'box')
  assert.match(m.svg.getAttribute('aria-label'), /1 组有可用数值/)
})

test('a wholly empty chart says why it is empty', () => {
  const m = mount({ groups: [{ key: 'a', label: 'a', values: [] }] })
  assert.equal(m.renders[0].empty, true)
  assert.equal(m.svg.getAttribute('aria-label'), 'No data')
  assert.match(m.note.textContent, /没有可用的数值/)
  assert.equal(m.html, '')

  const nothing = mount({})
  assert.equal(nothing.renders[0].empty, true)
  assert.match(nothing.note.textContent, /没有数据/)
})

// ─────────────────────────────────────────────── input shapes

test('rows plus accessors produce the same boxes as pre-grouped values', () => {
  const rows = []
  for (let i = 0; i < 15; i++) rows.push({ site: 'A', ms: i + 1 })
  for (let i = 0; i < 15; i++) rows.push({ site: 'B', ms: i + 20 })
  const m = mount({ rows, group: (r) => r.site, value: (r) => r.ms })

  assert.equal(m.renders[0].boxes.length, 2)
  assert.equal(groupAttr(m.html, 0, 'data-key'), 'A')
  assert.equal(groupAttr(m.html, 1, 'data-key'), 'B')
  assert.equal(groupAttr(m.html, 0, 'data-n'), '15')

  // A row with no group cannot be placed anywhere, so the row goes; a row whose
  // group is known but whose value is missing keeps its group, because throwing
  // away the whole record would waste the field that is fine (the skill's
  // "prefer field-level dropping").
  const withOrphan = mount({
    rows: [...rows, { ms: 9 }, { site: 'C' }],
    group: (r) => r.site,
    value: (r) => r.ms,
  })
  assert.equal(withOrphan.renders[0].rejected, 2, 'one row with no group, one value that is not a number')
  assert.equal(withOrphan.renders[0].reasons.group, 1, 'and the two reasons are recorded separately')
  assert.equal(withOrphan.renders[0].reasons.value, 1)
  assert.equal(withOrphan.renders[0].boxes.length, 3, 'group C still exists')
  assert.equal(groupAttr(withOrphan.html, 2, 'data-mode'), 'empty', 'it just has no usable value')
})

test('several groups share one y axis', () => {
  const m = mount({
    groups: [
      { key: 'low', label: 'low', values: series(10, 22) },
      { key: 'high', label: 'high', values: series(200, 212) },
    ],
  })
  const [lo, hi] = m.renders[0].domain
  assert.ok(lo < 10, 'the axis must cover the lower group')
  assert.ok(hi > 212, 'the axis must cover the upper group')
  assert.equal(m.renders[0].boxes.length, 2)
})

// ─────────────────────────────────────────────── interaction

test('the tooltip is shown with a value that beats the theme rule', () => {
  // theme.css hides `.chart-tip` by default. An inline `display` of `''` only
  // clears the override, so the panel falls back to `none` and never appears;
  // `none` obviously hides it too. Only an explicit visible value works, which
  // is why this asserts the exact string rather than "not none".
  const m = mount({ groups: [{ key: 'a', label: 'A', values: series(1, 14) }] })
  m.hover(300)
  const shown = m.tip.style.display
  assert.notEqual(shown, '', 'an empty inline value falls back to the CSS rule')
  assert.notEqual(shown, 'none', 'and `none` would hide it')
  assert.equal(shown, SHOWN)

  m.leave()
  assert.equal(m.tip.style.display, 'none', 'hiding still uses `none`')
})

test('hover gives the whole reading without a click', () => {
  const values = [...series(1, 13), 100]
  const m = mount({ groups: [{ key: 'a', label: 'A 组', values }] })
  m.hover(300)

  assert.equal(m.tip.style.display, SHOWN, 'hovering must open the reading')
  const html = m.tip.innerHTML
  assert.match(html, /A 组/, 'the tooltip names the group')
  assert.match(html, /n<b>14<\/b>/, 'the sample size is part of the reading')
  assert.match(html, /Q1/, 'Q1')
  assert.match(html, /中位数/, 'the median')
  assert.match(html, /Q3/, 'Q3')
  assert.match(html, /上须/, 'the upper whisker end')
  assert.match(html, /下须/, 'the lower whisker end')
  assert.match(html, /离群点 1 个/, 'the outlier count and range')
  assert.match(html, /100/, 'the outlier value itself')
  assert.equal(m.hovers.length, 1)
  assert.equal(m.hovers[0][1], 0, 'the hover callback reports the group index')
  assert.equal(m.hovers[0][0].stats.count, 14)
})

test('the tooltip reads the group under the pointer, and stops at the edges', () => {
  const m = mount({
    groups: [
      { key: 'a', label: 'A', values: series(1, 14) },
      { key: 'b', label: 'B', values: series(50, 63) },
      { key: 'c', label: 'C', values: series(90, 103) },
    ],
  })
  m.hover(100)
  assert.match(m.tip.innerHTML, /A 组|>A</)
  m.hover(320)
  assert.match(m.tip.innerHTML, />B</)
  m.hover(20)
  assert.equal(m.tip.style.display, 'none', 'outside the plot there is no reading')
  assert.equal(m.hovers[m.hovers.length - 1][1], null)
})

test('clicking pins the reading; moving away no longer clears it', () => {
  const m = mount({
    groups: [
      { key: 'a', label: 'A', values: series(1, 14) },
      { key: 'b', label: 'B', values: series(50, 63) },
    ],
  })
  m.hover(100)
  const hovered = m.tip.innerHTML
  m.click(100)
  assert.equal(m.selects.length, 1)
  assert.equal(m.selects[0][1], 0)
  assert.equal(m.selects[0][0].key, 'a')

  m.leave()
  assert.equal(m.tip.style.display, SHOWN, 'a pinned reading stays after the pointer leaves')
  assert.equal(m.tip.innerHTML, hovered, 'and it is still the pinned reading')
  assert.equal(m.hovers[m.hovers.length - 1][1], null, 'hover state itself still clears')

  // Pinned reading wins over a later hover.
  m.hover(500)
  assert.equal(m.tip.innerHTML, hovered, 'the pin outranks the pointer')

  // Clicking again releases the pin. What the panel shows next is the hover
  // reading under the pointer, so the pointer has to leave for it to close --
  // that ordering is a decision, and this asserts it rather than leaving it to
  // chance.
  m.click(100)
  assert.equal(m.selects[1][1], null)
  assert.match(m.tip.innerHTML, />B</, 'unpinning falls back to what is under the pointer')
  m.leave()
  assert.equal(m.tip.style.display, 'none', 'with the pointer gone the panel closes')
})

test('clicking empty space clears the pin', () => {
  const m = mount({ groups: [{ key: 'a', label: 'A', values: series(1, 14) }] })
  m.click(300)
  assert.equal(m.selects[0][1], 0)
  m.click(4)
  assert.equal(m.selects[1][1], null, 'a click beside the boxes is a click on nothing')
  assert.equal(m.tip.style.display, 'none')
})

test('the keyboard can pin, walk and release', () => {
  const m = mount({
    groups: [
      { key: 'a', label: 'A', values: series(1, 14) },
      { key: 'b', label: 'B', values: series(50, 63) },
    ],
  })
  m.key('ArrowRight')
  assert.equal(m.selects[0][1], 0)
  m.key('ArrowRight')
  assert.equal(m.selects[1][1], 1)
  m.key('ArrowRight')
  assert.equal(m.selects[2][1], 1, 'the selection cannot walk past the last group')
  m.key('Home')
  assert.equal(m.selects[3][1], 0)
  m.key('End')
  assert.equal(m.selects[4][1], 1)
  assert.equal(m.tip.style.display, SHOWN, 'a keyboard selection is visible')

  // A pin with no keyboard release is a dead end.
  m.key('Escape')
  assert.equal(m.selects[5][1], null)
  assert.equal(m.tip.style.display, 'none')

  m.key('ArrowRight')
  m.key('Enter')
  assert.equal(m.selects[7][1], null, 'Enter toggles the same way a click does')
})

test('select() is the programmatic pin and stays in sync with the data', () => {
  const m = mount({
    groups: [
      { key: 'a', label: 'A', values: series(1, 14) },
      { key: 'b', label: 'B', values: series(50, 63) },
    ],
  })
  m.chart.select(1)
  m.dom.flush()
  assert.equal(m.tip.style.display, SHOWN)
  assert.match(m.tip.innerHTML, />B</)

  // Shrinking the data must not leave a pin pointing at a group that is gone.
  m.chart.update({ groups: [{ key: 'a', label: 'A', values: series(1, 14) }] })
  m.dom.flush()
  assert.equal(m.tip.style.display, 'none', 'a stranded pin is dropped')
})

test('data() reports the same numbers the chart drew', () => {
  const m = mount({ groups: [{ key: 'a', label: 'A', values: series(1, 13) }] })
  const prep = m.chart.data()
  assert.equal(prep.boxes.length, 1)
  assert.equal(prep.boxes[0].stats.q1, Number(groupAttr(m.html, 0, 'data-q1')))
  assert.equal(prep.boxes[0].stats.median, Number(groupAttr(m.html, 0, 'data-median')))
  assert.equal(prep.boxes[0].stats.count, Number(groupAttr(m.html, 0, 'data-n')))
})

// ─────────────────────────────────────────────── lifecycle

test('a redraw is scheduled per frame, not per call', () => {
  const m = mount({ groups: [{ key: 'a', label: 'A', values: series(1, 14) }] })
  assert.equal(m.renders.length, 1, 'the first frame draws once')

  m.chart.update({ height: 320 })
  m.chart.update({ height: 340 })
  m.chart.update({ height: 360 })
  assert.equal(m.renders.length, 1, 'three updates inside one frame must not redraw three times')
  assert.equal(m.dom.pendingFrames(), 1, 'and they queue exactly one frame')

  m.dom.flush()
  assert.equal(m.renders.length, 2, 'the frame then draws exactly once, with the newest options')
  assert.equal(m.host.style.height, '360px')

  m.dom.resize()
  m.dom.flush()
  assert.equal(m.renders.length, 3, 'a container resize schedules a redraw')
})

test('destroy() stops the chart touching anything afterwards', () => {
  const m = mount({ groups: [{ key: 'a', label: 'A', values: series(1, 14) }] })
  const before = m.renders.length
  m.chart.destroy()
  assert.equal(m.host.innerHTML, '')

  m.chart.update({ groups: [{ key: 'b', label: 'B', values: series(1, 30) }] })
  m.dom.resize()
  m.dom.flush()
  assert.equal(m.renders.length, before, 'no redraw after destroy')
})

test('rendering is deterministic', () => {
  const options = () => ({
    groups: [
      { key: 'a', label: 'A', values: [...series(1, 20), 400] },
      { key: 'b', label: 'B', values: series(5, 9) },
    ],
  })
  const first = mount(options())
  const second = mount(options())
  assert.equal(first.html, second.html, 'the same input must produce byte-identical markup')
})

// ─────────────────────────────────────────────── the hard constraints

test('no text is drawn inside the SVG', () => {
  const m = mount({
    groups: [
      { key: 'a', label: 'A 组', values: series(1, 14) },
      { key: 'b', label: 'B 组', values: series(50, 63) },
    ],
  })
  // The plot is stretched non-uniformly to fill a responsive box, so any
  // character in there would be distorted. Labels belong to HTML overlays.
  assert.ok(!/<text/.test(m.html), 'text inside the stretched SVG would be distorted')
  assert.ok(!/A 组/.test(m.html), 'no label text leaks into the SVG')
  assert.match(m.xlab.innerHTML, /A 组/, 'labels live in the HTML overlay')
  assert.equal((m.xlab.innerHTML.match(/data-x=/g) || []).length, 2)
})

test('colours come from tokens, never from literals', () => {
  const m = mount({
    groups: [
      { key: 'a', label: 'A', values: series(1, 14) },
      { key: 'b', label: 'B', values: series(50, 63) },
    ],
  })
  m.hover(100)
  const painted = [...`${m.html}${m.tip.innerHTML}${m.xlab.innerHTML}`.matchAll(
    /(?:fill|stroke|background)\s*[:=]\s*"?([^";]+)"?/g,
  )].map((x) => x[1].trim())
  assert.ok(painted.length > 5, 'the fixture must actually paint something')
  for (const v of painted) {
    assert.match(v, /^(var\(--chart-[a-z0-9-]+\)|none|transparent)$/,
      `literal colour or stray value found: ${v}`)
  }

  // The source must not contain a literal colour either -- a token that is
  // bypassed in one branch is exactly the bug a theme layer cannot fix later.
  assert.ok(!/#[0-9a-fA-F]{3}/.test(SRC), 'a literal hex colour reached the source')
  assert.ok(!/\brgba?\(/.test(SRC), 'a literal rgb() colour reached the source')
  assert.ok(!/\bhsla?\(/.test(SRC), 'a literal hsl() colour reached the source')
})

test('labels from the data are escaped', () => {
  const m = mount({
    groups: hostileLabels().slice(0, 6).map((h, i) => ({ key: h.key, label: h.label, values: series(1, 14 + i) })),
  })
  assert.ok(!/<img src=x/.test(m.xlab.innerHTML), 'markup in a label must be escaped')
  assert.match(m.xlab.innerHTML, /&lt;img src=x/)
  assert.match(m.xlab.innerHTML, /&#39;/, 'quotes must be escaped in attributes too')
  assert.match(m.xlab.innerHTML, /&amp;/, 'ampersands must be escaped')
  assert.ok(!/onerror="alert/.test(m.html + m.xlab.innerHTML), 'the handler must not survive unescaped')

  // A tooltip is the other place data-derived text reaches the DOM.
  m.hover(187)
  assert.equal(m.tip.style.display, SHOWN)
  assert.match(m.tip.innerHTML, /&lt;img src=x/)
  assert.ok(!/<img src=x/.test(m.tip.innerHTML))
})

test('the chart reserves its height before data arrives', () => {
  // Layout shift after a chart loads is the failure this guards: the host must
  // own its height, not be sized by whatever it ends up containing.
  const m = mount({ height: 280, groups: [{ key: 'a', label: 'A', values: series(1, 14) }] })
  assert.equal(m.host.style.height, '280px')
  assert.equal(m.svg.getAttribute('viewBox'), '0 0 600 280')

  const empty = mount({ height: 240 })
  assert.equal(empty.host.style.height, '240px', 'even the empty state holds its box')
})

test('no group count makes the layout collapse', () => {
  for (const n of [1, 2, 7, 30]) {
    const groups = Array.from({ length: n }, (_, i) => ({
      key: `g${i}`, label: `Group ${i}`, values: series(i, i + 15),
    }))
    const m = mount({ groups })
    assert.equal(m.renders[0].boxes.length, n)
    assert.equal((m.html.match(/<g /g) || []).length, n, `${n} groups must render ${n} groups`)
    for (const d of [...m.html.matchAll(/ d="| x="(-?[\d.]+)"/g)]) void d
    assert.ok(!/NaN/.test(m.html), `${n} groups produced NaN geometry`)
    assert.ok(!/undefined/.test(m.html), `${n} groups produced undefined geometry`)
  }
})

test('the chart rejects a missing host the way its siblings do', () => {
  assert.throws(() => boxplotChart(null, {}), /host element is required/)
})
