/**
 * Round 5: the scatter renderer, and the two things a scatter must not get
 * wrong -- an axis that lies about position, and a cloud of coincident points
 * that lies about how much data there is.
 *
 * Rounds 1-4 tested core.js only, because a renderer with no DOM test is a
 * renderer whose numbers are only ever eyeballed. Node has no DOM, so this file
 * carries a small hand-written one (below): createElement/createElementNS,
 * classList, style, dataset, listeners and their dispatch, innerHTML capture,
 * ResizeObserver, requestAnimationFrame. It is a stub, not a browser -- it
 * cannot catch a CSS cascade mistake (the tooltip's `display` is set by the
 * react-on-style, not by the cascade) and it does not lay anything out. What it
 * CAN catch is exactly what the pure tests cannot: which marks get drawn, what
 * the tooltip says, whether labels were escaped, whether a resize redraws once
 * per frame, and whether the returned lifecycle works.
 *
 * Every assertion here was checked against a deliberately broken build first
 * (see the report): an assertion that cannot fail is worth less than none.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  scatterChart, prepareScatter, binOverplot, markRadius, markOpacity,
} from '../src/scatter.js'

// ─────────────────────────────────────────── a very small DOM

const observers = []
const frames = new Map()
let frameSeq = 0

function makeEl(tag, opts = {}) {
  const node = {
    tagName: String(tag).toUpperCase(),
    namespaceURI: opts.ns || null,
    className: '',
    children: [],
    attrs: new Map(),
    style: {},
    dataset: {},
    listeners: {},
    textContent: '',
    clientWidth: opts.clientWidth || 0,
    clientHeight: opts.clientHeight || 0,
    offsetWidth: 0,
    offsetHeight: 0,
    tabIndex: 0,
    _html: '',
    classList: {
      add(c) { node.className = (node.className ? node.className + ' ' : '') + c },
      remove(c) { node.className = node.className.split(/\s+/).filter((x) => x && x !== c).join(' ') },
      contains(c) { return node.className.split(/\s+/).includes(c) },
    },
    append(...nodes) {
      for (const n of nodes) {
        if (!n) continue
        // A child of a sized box is as big as the box, like a width:100% SVG.
        if (!n.clientWidth) n.clientWidth = node.clientWidth
        if (!n.clientHeight) n.clientHeight = node.clientHeight
        node.children.push(n)
      }
    },
    appendChild(n) { node.append(n); return n },
    setAttribute(k, v) { node.attrs.set(String(k), String(v)) },
    getAttribute(k) { return node.attrs.has(String(k)) ? node.attrs.get(String(k)) : null },
    hasAttribute(k) { return node.attrs.has(String(k)) },
    removeAttribute(k) { node.attrs.delete(String(k)) },
    addEventListener(t, fn) { (node.listeners[t] = node.listeners[t] || []).push(fn) },
    removeEventListener(t, fn) {
      const list = node.listeners[t]
      if (list) node.listeners[t] = list.filter((f) => f !== fn)
    },
    dispatch(t, ev = {}) {
      for (const fn of (node.listeners[t] || []).slice()) fn({ type: t, ...ev })
    },
    getBoundingClientRect() {
      return {
        left: 0, top: 0, width: node.clientWidth, height: node.clientHeight,
        right: node.clientWidth, bottom: node.clientHeight,
      }
    },
  }
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._html },
    set(v) { node._html = String(v); node.children.length = 0 },
  })
  return node
}

globalThis.document = {
  createElement: (t) => makeEl(t),
  createElementNS: (ns, t) => makeEl(t, { ns }),
}
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; this.disconnected = false; observers.push(this) }
  observe(target) { this.target = target }
  disconnect() { this.disconnected = true }
}
globalThis.requestAnimationFrame = (fn) => {
  const id = ++frameSeq
  frames.set(id, fn)
  return id
}
globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }

/** Run everything queued for this frame. */
function flush() {
  const jobs = [...frames.values()]
  frames.clear()
  for (const fn of jobs) fn()
}

/** Resize every live observer. */
function resizeAll() {
  for (const o of observers) if (!o.disconnected) o.cb([], o)
}

test.beforeEach(() => {
  observers.length = 0
  frames.clear()
})

// ─────────────────────────────────────────── helpers

function makeHost(w = 640, h = 300) {
  return makeEl('div', { clientWidth: w, clientHeight: h })
}

function mount(options, w = 640, h = 300) {
  const host = makeHost(w, h)
  const chart = scatterChart(host, options)
  flush()
  const at = (cls) => host.children.find((c) => (c.className || '').split(/\s+/).includes(cls))
  return {
    host, chart, at,
    svg: host.children[0],
    tip: at('chart-tip'),
    xlab: at('chart-xlab'),
    yTitle: at('chart-axistitle-y'),
    xTitle: at('chart-axistitle-x'),
    empty: at('chart-empty'),
  }
}

/** Attribute maps for every <circle> in an SVG string, in document order. */
function circles(html) {
  const out = []
  for (const m of html.matchAll(/<circle\b([^>]*?)\/?>/g)) {
    const attrs = {}
    for (const kv of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[kv[1]] = kv[2]
    out.push(attrs)
  }
  return out
}

/** Points far enough apart that none of them share a grid cell. */
function spread(n = 8) {
  const tags = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
  return Array.from({ length: n }, (_, i) => ({
    x: 12 + i * 9,
    y: 34 + i * 7,
    tag: tags[i % tags.length],
    weight: 7 + i * 6,
  }))
}

/** A deterministic pseudo-random cloud (a fixed seed, so failures reproduce). */
function cloud(n) {
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  return Array.from({ length: n }, () => ({ x: rnd() * 100, y: rnd() * 100 }))
}

// ─────────────────────────────────────────── pure: prepareScatter

test('S1: prepareScatter keeps only rows with both coordinates and counts the rest', () => {
  const out = prepareScatter([
    { x: 1, y: 2 },
    { x: NaN, y: 3 },
    { x: '4', y: 5 },
    { x: 6, y: null },
    { x: 7, y: Infinity },
    null,
    undefined,
  ])
  assert.equal(out.points.length, 1)
  assert.equal(out.points[0].x, 1)
  assert.equal(out.rejected, 6, 'every unusable row must be reported, not swallowed')
  assert.equal(out.reasons.x, 4)
  assert.equal(out.reasons.y, 2)
  assert.equal(out.empty, false)
})

test('S1: numeric strings are rejected, not coerced (they mean formatted upstream data)', () => {
  // The skill is explicit here: "142" may be accepted by other layers, but a
  // scatter must not silently guess at the numeric meaning of a string.
  const out = prepareScatter([{ x: '142', y: 5 }])
  assert.equal(out.points.length, 0)
  assert.equal(out.reasons.x, 1)
})

test('S1: a scatter axis does NOT start at zero by default', () => {
  const pts = Array.from({ length: 20 }, (_, i) => ({ x: 1000 + i, y: 900 + i * 2 }))
  const out = prepareScatter(pts)
  assert.ok(out.domain.x[0] > 900, `x must follow the data, got ${out.domain.x}`)
  assert.ok(out.domain.y[0] > 800, `y must follow the data, got ${out.domain.y}`)
  assert.equal(out.fromZero.x, false)
})

test('S1: xFromZero / yFromZero pin the axis to zero when the caller asks', () => {
  const pts = Array.from({ length: 20 }, (_, i) => ({ x: 1000 + i, y: 900 + i * 2 }))
  const yz = prepareScatter(pts, { yFromZero: true })
  assert.equal(yz.domain.y[0], 0)
  assert.ok(yz.domain.y[1] > 900, 'and still covers the data')
  assert.ok(yz.domain.x[0] > 900, 'the other axis is untouched')

  const xz = prepareScatter(pts, { xFromZero: true })
  assert.equal(xz.domain.x[0], 0)
})

test('S1: a zero-based axis still shows negative values instead of hiding them', () => {
  // zeroBasedDomain() assumes a non-negative measure (right for bars, whose
  // area encodes magnitude). A scatter axis can be signed, and clamping the
  // domain to [0, max] would push real points off the plot.
  const pts = [{ x: 0, y: -40 }, { x: 1, y: 30 }]
  const zero = prepareScatter(pts, { yFromZero: true })
  assert.equal(zero.fromZero.y, true)
  assert.ok(zero.domain.y[0] <= -40, `negative points must stay on the plot, got ${zero.domain.y}`)
  assert.ok(zero.domain.y[1] >= 30)

  const allNegative = prepareScatter([{ x: 0, y: -40 }, { x: 1, y: -10 }], { yFromZero: true })
  assert.ok(allNegative.domain.y[0] <= -40)
  assert.ok(allNegative.domain.y[1] > allNegative.domain.y[0], 'and the axis keeps a width')

  const fitted = prepareScatter(pts)
  assert.ok(fitted.domain.y[0] < -40)
})

test('S1: robust trims outliers and says how many', () => {
  const pts = Array.from({ length: 100 }, (_, i) => ({ x: i, y: i + 1 }))
  pts.push({ x: 500, y: 9999 })
  const fitted = prepareScatter(pts)
  const robust = prepareScatter(pts, { robust: true })
  assert.equal(fitted.trimmed.y, 0, 'the default keeps every point on the axis')
  assert.ok(fitted.domain.y[1] > 9000)
  assert.ok(robust.trimmed.y >= 1, 'the outlier must be counted as excluded')
  assert.ok(robust.domain.y[1] < 200, `robust band must reject the spike, got ${robust.domain.y}`)
})

test('S1: degenerate and empty inputs stay finite', () => {
  const same = Array.from({ length: 40 }, () => ({ x: 5, y: 7 }))
  const one = prepareScatter(same)
  assert.ok(one.domain.x[1] > one.domain.x[0], 'an all-equal axis must still have width')
  assert.ok(one.domain.y[1] > one.domain.y[0])

  const empty = prepareScatter([])
  assert.equal(empty.empty, true)
  assert.ok(empty.domain.x.every(Number.isFinite))
  assert.ok(empty.domain.y[1] > empty.domain.y[0])

  const allBad = prepareScatter([{ x: NaN, y: NaN }, { x: null, y: 1 }])
  assert.equal(allBad.empty, true)
  assert.equal(allBad.rejected, 2)
})

test('S1: custom accessors are used, and a throwing accessor is a rejected row', () => {
  const rows = [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 'x', b: 6 }]
  const out = prepareScatter(rows, { x: (r) => r.a, y: (r) => r.b })
  assert.equal(out.points.length, 2)
  assert.equal(out.points[1].x, 3)
  const boom = { get a() { throw new Error('nope') }, b: 1 }
  assert.doesNotThrow(() => prepareScatter([boom], { x: (r) => r.a, y: (r) => r.b }))
  assert.equal(prepareScatter([boom], { x: (r) => r.a, y: (r) => r.b }).rejected, 1)
})

// ─────────────────────────────────────────── pure: overplot binning

test('S2: a cell with one point keeps that point EXACTLY where it is', () => {
  const out = binOverplot([
    { x: 10.5, y: 20.5, dx: 1, dy: 2 },
    { x: 300.5, y: 200.5, dx: 9, dy: 9 },
  ], { cell: 14 })
  assert.equal(out.marks.length, 2)
  const xs = out.marks.map((m) => m.x).sort((a, b) => a - b)
  assert.deepEqual(xs, [10.5, 300.5], 'a lone point must not be snapped to a cell centre')
})

test('S2: coincident points collapse into one mark that carries their count', () => {
  const same = Array.from({ length: 40 }, (_, i) => ({ x: 100 + i * 1e-9, y: 50, dx: i, dy: i }))
  const out = binOverplot(same, { cell: 14 })
  assert.equal(out.marks.length, 1)
  assert.equal(out.marks[0].count, 40)
  assert.equal(out.marks[0].span.x[0], 0)
  assert.equal(out.marks[0].span.x[1], 39)

  // The mark sits at the centroid of what it stands for, not at an arbitrary
  // cell corner that may hold no point at all.
  const two = binOverplot([
    { x: 10, y: 10, dx: 0, dy: 0 },
    { x: 20, y: 30, dx: 1, dy: 1 },
  ], { cell: 40 })
  assert.equal(two.marks.length, 1)
  assert.equal(two.marks[0].x, 15)
  assert.equal(two.marks[0].y, 20)
})

test('S2: binning never loses a point', () => {
  const pts = cloud(5000).map((p) => ({ x: p.x * 5, y: p.y * 2.4, dx: p.x, dy: p.y }))
  const out = binOverplot(pts, { cell: 14 })
  const total = out.marks.reduce((n, m) => n + m.count, 0)
  assert.equal(total, pts.length)
  assert.ok(out.marks.length <= pts.length)
})

test('S2: the grid coarsens until it fits maxMarks, rather than dropping marks', () => {
  const pts = cloud(20000).map((p) => ({ x: p.x * 5.54, y: p.y * 2.4, dx: p.x, dy: p.y }))
  const tight = binOverplot(pts, { cell: 8, maxMarks: 40 })
  assert.equal(tight.grown, true, 'the cell size must have grown')
  assert.ok(tight.marks.length <= 40, `marks ${tight.marks.length} exceed maxMarks`)
  assert.ok(tight.cell > 8)
  assert.equal(tight.marks.reduce((n, m) => n + m.count, 0), pts.length, 'still lossless')
  assert.equal(tight.over, false)

  // And it reports when even the largest allowed cell cannot fit the budget.
  const impossible = binOverplot(pts, { cell: 2, maxMarks: 2 })
  assert.equal(impossible.over, true)
  assert.equal(impossible.marks.reduce((n, m) => n + m.count, 0), pts.length)
})

test('S2: nothing in the binning throws on an empty or hostile input', () => {
  for (const input of [[], null, undefined, [{ x: NaN, y: 0, dx: 0, dy: 0 }]]) {
    const out = binOverplot(input, { cell: 14 })
    assert.ok(Array.isArray(out.marks))
    assert.ok(Number.isFinite(out.cell))
  }
  assert.deepEqual(binOverplot([], {}).marks, [])
})

test('S2: radius encodes area and opacity saturates', () => {
  assert.ok(markRadius(1) < markRadius(4))
  assert.ok(markRadius(4) < markRadius(16))
  assert.equal(markRadius(100000), 8, 'capped')
  // Area proportional to count means radius proportional to sqrt(count).
  assert.ok(Math.abs(markRadius(4) / markRadius(1) - 2) < 1e-9)
  assert.ok(markOpacity(1) < markOpacity(4))
  assert.ok(markOpacity(4) < markOpacity(10000))
  assert.ok(markOpacity(1e9) <= 0.95, 'opacity must not exceed the cap')
})

// ─────────────────────────────────────────── the renderer

test('S3: the chart returns the same lifecycle shape as line and bar', () => {
  const { chart } = mount({ points: spread(4) })
  assert.equal(typeof chart.update, 'function')
  assert.equal(typeof chart.select, 'function')
  assert.equal(typeof chart.destroy, 'function')
  assert.equal(typeof chart.data, 'function')
  assert.equal(typeof chart.data().points.length, 'number')
})

test('S3: separated points render one mark each, with no literal colour anywhere', () => {
  const { svg } = mount({ points: spread(8) })
  const html = svg.innerHTML
  assert.equal(circles(html).length, 8)

  assert.ok(!/<text[\s>]/.test(html), 'text must never be drawn into the SVG')
  assert.ok(!/<image|<foreignObject/i.test(html))

  const colours = [...html.matchAll(/(?:fill|stroke|background)="([^"]*)"/g)].map((m) => m[1])
  assert.ok(colours.length > 8)
  for (const c of colours) {
    assert.ok(
      c === 'none' || c === 'transparent' || c.startsWith('var(--chart-'),
      `literal colour in the SVG: ${c}`,
    )
  }
})

test('S3: the source file itself carries no literal colour', () => {
  const raw = readFileSync(new URL('../src/scatter.js', import.meta.url), 'utf8')
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src), 'hex colour in scatter.js')
  assert.ok(!/\brgba?\(/.test(src), 'rgb()/rgba() in scatter.js')
  assert.ok(!/\bhsla?\(/.test(src), 'hsl() in scatter.js')
})

test('S3: a 20k-point cloud is drawn as bounded marks and reports what it collapsed', () => {
  const pts = cloud(20000)
  const renders = []
  const { svg } = mount({ points: pts, onRender: (s) => renders.push(s) })
  const last = renders.at(-1)
  assert.equal(last.empty, false)
  assert.ok(last.marks.length <= 2000, `marks ${last.marks.length} over the SVG budget`)
  assert.equal(last.collapsed, pts.length - last.marks.length)
  assert.ok(last.collapsed > 1000, 'this fixture must actually overplot')
  assert.equal(last.marks.reduce((n, m) => n + m.count, 0), pts.length, 'no point lost')
  assert.equal(circles(svg.innerHTML).length, last.marks.length)
  assert.equal(Number(svg.getAttribute('width')) > 0, true)
})

test('S3: hovering gives the FULL reading, without a click', () => {
  const pts = spread(8)
  const seen = []
  const { host, svg, tip } = mount({
    points: pts,
    xLabel: 'CPU',
    yLabel: '延迟',
    xUnit: '%',
    yUnit: 'ms',
    labelOf: (r) => r.tag,
    onHover: (p, i) => seen.push([p, i]),
  })

  const target = circles(svg.innerHTML)[0]
  host.dispatch('mousemove', { clientX: Number(target.cx), clientY: Number(target.cy) })

  const [p, i] = seen.at(-1)
  assert.equal(typeof i, 'number')
  const src = pts.find((r) => r.tag === p.tag)
  assert.ok(src, `hover reported a point that is not in the data: ${JSON.stringify(p)}`)
  assert.equal(p.x, src.x)
  assert.equal(p.y, src.y)

  // Identity, both coordinates, both units, and every field of the record.
  assert.match(tip.innerHTML, new RegExp(src.tag))
  assert.match(tip.innerHTML, /CPU/)
  assert.match(tip.innerHTML, /延迟/)
  assert.match(tip.innerHTML, /%/)
  assert.match(tip.innerHTML, /ms/)
  assert.match(tip.innerHTML, new RegExp(String(src.weight)))
  assert.match(tip.innerHTML, /weight/)
  assert.equal(tip.style.display, 'block', 'the panel must actually become visible')
})

test('S3: a cluster reports its exact count and the span it covers', () => {
  const pts = [...Array.from({ length: 25 }, () => ({ x: 50, y: 50 })), { x: 100, y: 100 }]
  const { host, svg, tip } = mount({ points: pts, xLabel: 'L', yLabel: 'W' })
  const drawn = circles(svg.innerHTML)
  assert.equal(drawn.length, 2, '25 coincident points must not be 25 circles')

  const cluster = drawn.reduce((a, b) => (Number(a.r) > Number(b.r) ? a : b))
  host.dispatch('mousemove', { clientX: Number(cluster.cx), clientY: Number(cluster.cy) })
  assert.match(tip.innerHTML, /25 个点重合/)
  assert.match(tip.innerHTML, /范围/)
})

test('S3: data labels reach the tooltip escaped, never as markup', () => {
  const evil = '<img src=x onerror="alert(1)">'
  const { host, svg, tip } = mount({
    points: [{ x: 1, y: 2, note: '<script>alert(1)</script>' }],
    labelOf: () => evil,
  })
  const c = circles(svg.innerHTML)[0]
  host.dispatch('mousemove', { clientX: Number(c.cx), clientY: Number(c.cy) })
  assert.ok(!tip.innerHTML.includes('<img'), 'labelOf output must be escaped')
  assert.ok(!tip.innerHTML.includes('<script'), 'field values must be escaped')
  assert.match(tip.innerHTML, /&lt;img/)
  assert.match(tip.innerHTML, /&lt;script&gt;/)
})

test('S3: hover only, then click to PIN -- and three ways out of pinning', () => {
  const sel = []
  const { host, svg } = mount({ points: spread(8), onSelect: (p, i) => sel.push([p, i]) })
  const target = circles(svg.innerHTML)[0]
  const at = { clientX: Number(target.cx), clientY: Number(target.cy) }

  host.dispatch('click', at)
  flush()
  assert.ok(sel.at(-1)[0], 'click must hand back the reading it pinned')
  assert.match(svg.innerHTML, /var\(--chart-selected\)/, 'pinned marks get the fill token')

  // Moving away clears the hover but NOT the pin.
  host.dispatch('mousemove', { clientX: 3, clientY: 3 })
  flush()
  assert.match(svg.innerHTML, /var\(--chart-selected\)/)
  assert.equal(sel.length, 1, 'a hover must not fire onSelect')

  // Clicking the same mark again unpins.
  host.dispatch('click', at)
  flush()
  assert.equal(sel.at(-1)[0], null)
  assert.ok(!/var\(--chart-selected\)/.test(svg.innerHTML))

  // Clicking empty space clears.
  host.dispatch('click', at)
  flush()
  assert.match(svg.innerHTML, /var\(--chart-selected\)/)
  host.dispatch('click', { clientX: 3, clientY: 3 })
  flush()
  assert.equal(sel.at(-1)[0], null)

  // Escape clears, so the keyboard can undo what the mouse did.
  host.dispatch('click', at)
  flush()
  assert.match(svg.innerHTML, /var\(--chart-selected\)/)
  host.dispatch('keydown', { key: 'Escape' })
  flush()
  assert.equal(sel.at(-1)[0], null)
  assert.ok(!/var\(--chart-selected\)/.test(svg.innerHTML))
})

test('S3: empty and all-dirty inputs render an explained empty state', () => {
  const a = mount({ points: [], height: 240 })
  assert.equal(a.empty.style.display, 'flex')
  assert.match(a.empty.textContent, /没有数据点/)
  assert.equal(a.svg.getAttribute('aria-label'), 'No data')
  assert.equal(a.host.dataset.empty, '1')
  // The scaffold is still usable afterwards.
  a.chart.update({ points: spread(3) })
  flush()
  assert.equal(a.empty.style.display, 'none')
  assert.equal(circles(a.svg.innerHTML).length, 3)

  const b = mount({ points: [{ x: NaN, y: 1 }, { x: 'a', y: 2 }, { x: 3, y: 4 }] })
  assert.equal(b.empty.style.display, 'none')
  assert.match(b.host.dataset.points, /^1$/)
  assert.equal(circles(b.svg.innerHTML).length, 1)

  const c = mount({ points: [{ x: NaN, y: 1 }, { x: 'a', y: 2 }] })
  assert.equal(c.empty.style.display, 'flex')
  assert.match(c.empty.textContent, /2/)
  assert.match(c.svg.getAttribute('aria-label'), /2 rows/)
})

test('S3: a full rejection is not mistaken for "no data was given"', () => {
  const { empty, svg } = mount({ points: [{ x: 1, y: NaN }, { x: NaN, y: 2 }] })
  assert.match(empty.textContent, /2 条记录/)
  assert.notEqual(svg.getAttribute('aria-label'), 'No data')
})

test('S3: the axes are named, with units, in HTML', () => {
  const m = mount({
    points: spread(4), xLabel: 'CPU', yLabel: '延迟', xUnit: '%', yUnit: 'ms',
  })
  assert.equal(m.yTitle.textContent, '延迟 (ms)')
  assert.equal(m.xTitle.textContent, 'CPU (%)')
  assert.ok(!/<text[\s>]/.test(m.svg.innerHTML), 'axis titles are not SVG text')
  const spans = [...m.xlab.innerHTML.matchAll(/<span style="([^"]*)"/g)].map((mm) => mm[1])
  assert.ok(spans.length >= 2, `expected x tick labels, got ${spans.length}`)
  for (const style of spans) assert.match(style, /left:/)
  assert.match(m.xlab.style.cssText, /position:absolute/)
  // No label at all still renders.
  const bare = mount({ points: spread(3) })
  assert.equal(bare.xTitle.textContent, '')
  assert.equal(bare.yTitle.textContent, '')
})

test('S3: resize redraws at most once per frame', () => {
  const { svg } = mount({ points: spread(5) })
  const before = svg.innerHTML
  frames.clear()
  resizeAll()
  resizeAll()
  resizeAll()
  assert.equal(frames.size, 1, 'three resizes in one frame must queue ONE redraw')
  flush()
  assert.equal(frames.size, 0)
  assert.equal(typeof svg.innerHTML, 'string')
  assert.equal(circles(svg.innerHTML).length, circles(before).length, 'same data, same marks')
})

test('S3: update replaces the data and drops a pinned reading', () => {
  const { chart, svg } = mount({ points: spread(6) })
  chart.select(0)
  flush()
  assert.match(svg.innerHTML, /var\(--chart-selected\)/)

  chart.update({ points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] })
  assert.equal(frames.size, 1)
  flush()
  assert.equal(circles(svg.innerHTML).length, 3)
  assert.ok(!/var\(--chart-selected\)/.test(svg.innerHTML), 'stale pin must not survive new data')
})

test('S3: destroy unbinds everything and the chart goes quiet', () => {
  const { host, chart, svg } = mount({ points: spread(4) })
  chart.destroy()
  assert.equal(host.innerHTML, '')
  assert.ok(observers.every((o) => o.disconnected))

  frames.clear()
  chart.update({ points: spread(9) })
  resizeAll()
  host.dispatch('mousemove', { clientX: 10, clientY: 10 })
  host.dispatch('click', { clientX: 10, clientY: 10 })
  assert.equal(frames.size, 0, 'a destroyed chart must schedule nothing')
  assert.equal(circles(svg.innerHTML).length, 4, 'and must not touch the DOM again')
})

test('S3: a host is required, and a tiny host does not blow up', () => {
  assert.throws(() => scatterChart(null), /host element is required/)
  const tiny = mount({ points: spread(6) }, 40, 30)
  assert.ok(circles(tiny.svg.innerHTML).length >= 1)
  const flat = mount({ points: spread(6) }, 640, 8)
  assert.ok(Array.isArray(circles(flat.svg.innerHTML)))
})
