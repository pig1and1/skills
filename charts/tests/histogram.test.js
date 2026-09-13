/**
 * Histogram renderer tests.
 *
 * The rest of the suite tests pure computation, because that is where the bugs
 * live. A renderer is different: its failures are geometric and structural --
 * unequal bar widths, gaps between bins, a count axis that does not start at
 * zero, labels pushed into the stretched SVG -- and every one of those can be
 * asserted against the markup it produces. So this file drives the real
 * `histogramChart` through a small DOM stub rather than testing a
 * reimplementation of it.
 *
 * `src/histogram.js` stays importable without a DOM: it only reaches for
 * `document` / `requestAnimationFrame` / `ResizeObserver` inside
 * `histogramChart()`, and the stub is installed before that call, so the code
 * under test is the code a browser runs. The stub supplies only what node
 * lacks: layout, frames, resize notifications.
 *
 * Two things about the stub are easy to get wrong, and the first version of
 * this file got both:
 *   - `document` must be created ONCE, at module load. Replacing it per test
 *     leaves the chart holding a different document than `document.createElement`
 *     returns, so the overlay a test inspects is not the one the chart wrote to,
 *     and its style reads back as undefined.
 *   - `getBoundingClientRect` must report a width, or every client-x -> bin
 *     mapping returns null and hover silently does nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { histogramChart, binCount, binEdges, formatRange } from '../src/histogram.js'
import { histogram } from '../src/core.js'

const SRC = readFileSync(fileURLToPath(new URL('../src/histogram.js', import.meta.url)), 'utf8')

// ─────────────────────────────────────────────── minimal DOM stub

const BOX = { left: 0, top: 0, width: 600, height: 280 }

function stubElement(tag) {
  const self = {
    tagName: tag,
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    children: [],
    attrs: {},
    dataset: {},
    listeners: {},
    clientWidth: 0,
    clientHeight: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    _capture: null,
  }
  const styles = {}
  // `cssText = '...'` is used for the inline blocks; keep it as a property
  // rather than trying to expand it into individual rules.
  self.style = new Proxy(styles, { set: (t, k, v) => { t[k] = v; return true } })
  self.classList = {
    add: (c) => { self.className = `${self.className} ${c}`.trim() },
    remove: () => {},
  }
  self.setAttribute = (k, v) => { self.attrs[k] = String(v) }
  self.getAttribute = (k) => (k in self.attrs ? self.attrs[k] : null)
  self.addEventListener = (type, fn) => { (self.listeners[type] ||= []).push(fn) }
  self.removeEventListener = (type, fn) => {
    self.listeners[type] = (self.listeners[type] || []).filter((f) => f !== fn)
  }
  self.append = (...kids) => {
    for (const k of kids) { self.children.push(k); if (self._capture) self._capture.push(k) }
  }
  self.getBoundingClientRect = () => BOX
  /** Test-only: dispatch a synthetic event to the handlers the chart registered. */
  self._fire = (type, event) => {
    for (const fn of self.listeners[type] || []) fn(event)
  }
  return self
}

let created = []
const rafs = []

// Installed once, before any chart is constructed.
globalThis.document = {
  createElement: (tag) => {
    const el = stubElement(tag)
    // The host's clientWidth drives the plot; the SVG's box drives the
    // client-x -> view-x mapping. Both are needed for hover to resolve.
    el.clientWidth = BOX.width
    el.clientHeight = BOX.height
    el._capture = created
    created.push(el)
    return el
  },
  createElementNS: (_ns, tag) => globalThis.document.createElement(tag),
}
globalThis.requestAnimationFrame = (fn) => { rafs.push(fn); return rafs.length }
globalThis.cancelAnimationFrame = () => {}
globalThis.ResizeObserver = class { observe() {} disconnect() {} }

/** Drop the previous chart's DOM so each test starts from a known state. */
function resetDom() {
  created = []
  rafs.length = 0
}

/** Run every queued frame. Bounded, so a redraw loop fails instead of hanging. */
function flush() {
  for (let guard = 0; guard < 20 && rafs.length; guard++) rafs.shift()(16)
}

/** Boot a chart at a fixed size and return everything worth checking. */
function mount(values, options = {}) {
  resetDom()
  const host = document.createElement('div')
  const chart = histogramChart(host, { values, ...options })
  flush()
  const withClass = (cls) => created.find((e) => e.className === cls)
  return {
    host,
    chart,
    svg: created.find((e) => e.tagName === 'svg'),
    tip: withClass('chart-tip'),
    ylab: withClass('chart-ylab'),
    xlab: withClass('chart-xlab'),
    note: withClass('chart-note'),
    legend: withClass('chart-legend-row'),
    ytitle: withClass('chart-ylab-title'),
    elementCount: () => created.length,
    /** Hover/click handlers are registered on the host. */
    event: (type, clientX) => host._fire(type, { clientX }),
    flush,
  }
}

/** The attributes of every `<rect data-...="k">` in a markup string. */
function rects(markup, key) {
  const re = new RegExp(`<rect[^>]*data-${key}="\\d+"[^>]*>`, 'g')
  return (markup.match(re) || []).map((tag) => {
    const at = (name) => Number((tag.match(new RegExp(`${name}="(-?[\\d.]+)"`)) || [])[1])
    return { tag, x: at('x'), y: at('y'), width: at('width'), height: at('height') }
  })
}

/** The plot geometry at the default size and padding. */
const PAD = { top: 26, right: 24, bottom: 30, left: 56 }
const PLOT_W = BOX.width - PAD.left - PAD.right
const PLOT_BOTTOM = BOX.height - PAD.bottom

/**
 * Class-level `display` rules from theme.css. Only the ones the component's
 * elements actually carry matter, and the tooltip is the one that matters:
 * `.chart-tip { display: none }` is a real rule, so clearing the inline value
 * falls back to `none` and the tooltip never appears. (line.js and bar.js both
 * have this bug, which is invisible in any static screenshot.)
 */
const STYLE_RULE_DISPLAY = { 'chart-tip': 'none' }

/**
 * The computed `display` the way a browser would resolve it: an inline value
 * wins, otherwise the stylesheet rule applies. The class `.chart-tip` is NOT
 * an ancestor of the tooltip -- it is the tooltip itself.
 */
function effectiveDisplay(el) {
  const inline = el.style.display
  if (inline) return inline
  for (const cls of String(el.className).split(/\s+/)) {
    if (STYLE_RULE_DISPLAY[cls]) return STYLE_RULE_DISPLAY[cls]
    if (cls === 'chart') return 'block'    // theme.css: .chart has no display rule
  }
  return 'block'
}

/** Is the tooltip on screen? The hover reading only counts if it is. */
const isVisible = (el) => effectiveDisplay(el) !== 'none'
/** Client x at the centre of bin `i` of `n` bins -- how hover/click are driven. */
const clientXOfBin = (i, n) => PAD.left + ((i + 0.5) / n) * PLOT_W

/** A uniform sample: the values 0..99. Freedman-Diaconis gives 5 bins. */
const uniform100 = Array.from({ length: 100 }, (_, i) => i)

/** A deterministic bell-ish sample, for tests that need a realistic spread. */
function gaussian(n, seed = 42) {
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
  return Array.from({ length: n }, () => {
    const a = rnd() || 1e-9
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * rnd())
  })
}

// ─────────────────────────────────────────────── binCount: the adaptive rule

test('binCount answers from the data spread, not from a fixed 10', () => {
  // The same n, two shapes: a bell needs more bins than a uniform sample,
  // because its IQR covers a smaller share of its range. That is the whole
  // reason Freedman-Diaconis is preferred to Sturges -- the answer follows the
  // data's shape, not only the row count.
  const uniform = Array.from({ length: 2000 }, (_, i) => i / 2000)
  const bell = gaussian(2000)
  assert.ok(binCount(bell) > binCount(uniform),
    `a bell must earn more bins than a uniform sample: ${binCount(bell)} vs ${binCount(uniform)}`)

  // The specific number, so a change in the rule is visible. Five uniform values
  // per bin is what FD asks for here; a fixed 10 is exactly the value this
  // sample must NOT produce.
  assert.equal(binCount(uniform100), 5, 'FD answer for 100 uniform values')
  assert.notEqual(binCount(uniform100), 10, 'a hard-coded 10 would be a coincidence, not a rule')

  // And it is not simply returning the clamp floor for everything.
  assert.ok(binCount(bell) > 4, `the bell must clear the floor, got ${binCount(bell)}`)
})

test('binCount grows with n for the same spread', () => {
  const small = Array.from({ length: 100 }, (_, i) => i)
  const large = Array.from({ length: 10000 }, (_, i) => i)
  // Both clamp upward to minBins, so comparing only against the floor would
  // pass for any implementation that always returns minBins. Assert real growth.
  assert.equal(binCount(small), 5)
  assert.ok(binCount(large) > binCount(small),
    `more data must earn more bins: ${binCount(large)} vs ${binCount(small)}`)
  assert.ok(binCount(large) > 10, 'a 10k sample must not be flattened into 10 columns')
})

test('binCount falls back to Sturges when the IQR is unusable', () => {
  // More than half the sample on one value: the IQR is 0 and FD would divide by
  // it. Sturges answers from n alone, which is the right move there.
  const zeroInflated = [...new Array(50).fill(0), 1, 2, 3, 4, 5]
  const expected = Math.ceil(Math.log2(55)) + 1
  assert.equal(binCount(zeroInflated), expected, 'the IQR-0 branch must use Sturges')

  // Under four samples there are no usable quartiles either, so that branch is
  // reachable without an IQR at all -- and it must still be deterministic.
  assert.ok(binCount([1, 2, 3]) >= 1)
  assert.equal(binCount([1, 2, 3]), binCount([1, 2, 3]))
})

test('binCount clamps into [minBins, maxBins]', () => {
  const bell = gaussian(50000)
  const unbounded = binCount(bell, { maxBins: 100000 })
  assert.ok(unbounded > 60, `FD really does want more than the default cap here, got ${unbounded}`)
  assert.equal(binCount(bell, { maxBins: 40 }), 40, 'the ceiling must hold')
  assert.equal(binCount([1, 2], { minBins: 9 }), 9, 'a degenerate sample is raised to the floor')

  // An inverted range must not silently discard the minimum.
  assert.equal(binCount(bell, { minBins: 20, maxBins: 5 }), 20, 'maxBins below minBins is lifted, not obeyed')
  // A caller can move either end.
  assert.ok(binCount(uniform100, { minBins: 20, maxBins: 60 }) >= 20)
})

test('binCount survives every degenerate input without throwing', () => {
  assert.equal(binCount([]), 10, 'no data: an honest placeholder, not a crash')
  assert.equal(binCount(null), 10)
  assert.equal(binCount('nonsense'), 10)
  assert.equal(binCount([NaN, Infinity, -Infinity, null, undefined, '5']), 10,
    'nothing finite is the same as nothing')
  assert.equal(binCount(new Array(500).fill(7)), 4, 'constant data has no spread to bin')
  assert.equal(binCount([42]), 4)
})

// ─────────────────────────────────────────────── edges and ranges

test('binEdges are evenly spaced and cover the extent exactly', () => {
  const e = binEdges(0, 100, 8)
  assert.equal(e.length, 9, 'n bins means n+1 edges')
  assert.equal(e[0], 0)
  assert.equal(e[8], 100)
  const w = e[1] - e[0]
  for (let i = 1; i < e.length; i++) {
    assert.ok(Math.abs((e[i] - e[i - 1]) - w) < 1e-9, `edge ${i} breaks equal width`)
  }
  for (const v of binEdges(5, 5, 4)) assert.ok(Number.isFinite(v), 'a degenerate extent must not give NaN edges')
  for (const v of binEdges(NaN, NaN, 4)) assert.ok(Number.isFinite(v))
})

test('formatRange states the interval on both sides', () => {
  assert.equal(formatRange(0, 10, (v) => String(v)), '0 – 10')
  assert.ok(formatRange(-Infinity, 5, (v) => String(v)).startsWith('<'))
  assert.ok(formatRange(5, Infinity, (v) => String(v)).startsWith('>='))
})

test('the renderer reuses core.histogram for the binning itself', () => {
  // The renderer must not re-derive binning: core owns it, and the two must not
  // be able to drift apart.
  const values = [1, 2, 2, 3, 3, 3, 9, 10, 11]
  const core = histogram(values, { bins: binCount(values) })
  const mine = mount(values).chart.data()
  assert.deepEqual(mine.bins.map((b) => b.count), core.bins.map((b) => b.count))
  assert.equal(mine.total, core.total)
  assert.equal(mine.width, core.width)
})

// ─────────────────────────────────────────────── lifecycle

test('histogramChart is isomorphic to lineChart and barChart', () => {
  const m = mount(uniform100)
  assert.equal(typeof m.chart.update, 'function')
  assert.equal(typeof m.chart.select, 'function')
  assert.equal(typeof m.chart.destroy, 'function')
  assert.equal(typeof m.chart.data, 'function', 'data() lets a table reuse the same numbers')
  assert.throws(() => histogramChart(null), /host element is required/)
})

// ─────────────────────────────────────────────── geometry that must not lie

test('bars are equal width, share edges, and leave no gap', () => {
  const m = mount(gaussian(2000))
  const bars = rects(m.svg.innerHTML, 'bin')
  const n = Number(m.host.dataset.bins)
  assert.ok(n > 5, `only ${n} bins: too few to say anything about tiling`)
  const meta = m.chart.data()
  // The tiling assertions below compare consecutive DRAWN bars, so the sample
  // needs enough non-empty bins for that to mean anything.
  const nonEmpty = meta.bins.filter((b) => b.count > 0).length
  assert.equal(bars.length, nonEmpty, 'one rect per non-empty bin')
  assert.ok(nonEmpty > 5, `only ${nonEmpty} non-empty bins`)

  // Equal width. Bars of differing width misstate the density of every bin but
  // one, so this is a correctness check, not a styling preference.
  const w = bars[0].width
  for (const b of bars) assert.ok(Math.abs(b.width - w) <= 0.02, `bin width ${b.width} != ${w}`)

  // The run spans the whole plot. A gap cannot happen at the edges either.
  assert.ok(Math.abs(bars[0].x - PAD.left) < 0.02, `bars must start at the plot edge, got ${bars[0].x}`)
  const last = bars[bars.length - 1]
  assert.ok(Math.abs(last.x + last.width - (PAD.left + PLOT_W)) < 0.02,
    'bars must reach the right plot edge')

  // Every drawn bar spans its own bin exactly, and two adjacent bins that both
  // hold values must share an edge -- that is what "no gap" means for a
  // histogram. An EMPTY bin between them is not a gap: it is a real bin of the
  // distribution, drawn as nothing because its count is zero.
  const at = (i) => bars.find((b) => b.tag.includes(`data-bin="${i}"`))
  let adjacentPairs = 0
  for (let i = 1; i < meta.bins.length; i++) {
    const left = at(i - 1)
    const right = at(i)
    if (!left || !right) continue
    adjacentPairs += 1
    const rightEdge = left.x + left.width
    assert.ok(Math.abs(rightEdge - right.x) <= 0.02,
      `bins ${i - 1} and ${i} do not share an edge: ${rightEdge} vs ${right.x}`)
  }
  assert.ok(adjacentPairs >= 1, 'the fixture must contain at least one adjacent pair to check')
})

test('the hit targets tile the plot with no dead strip between bins', () => {
  const m = mount(uniform100)
  const hits = rects(m.svg.innerHTML, 'hit')
  const bars = rects(m.svg.innerHTML, 'bin')
  assert.equal(hits.length, bars.length, 'one hit target per bin, including the empty ones')
  for (let i = 1; i < hits.length; i++) {
    assert.ok(Math.abs((hits[i - 1].x + hits[i - 1].width) - hits[i].x) < 1e-6,
      `dead strip before hit target ${i}`)
  }
  for (const hit of hits) {
    assert.ok(hit.height > 200, `hit target only ${hit.height}px tall; short bars would be unclickable`)
  }
})

test('the count axis starts at zero, whatever the data looks like', () => {
  for (const values of [[1, 1, 1, 2, 2, 3], uniform100, [100, 200], [5]]) {
    checkZeroBased(values)
  }

  function checkZeroBased(values) {
    const m = mount(values)
    const label = JSON.stringify(values).slice(0, 40)
    const baseline = m.svg.innerHTML.match(/<line[^>]*stroke="var\(--chart-axis\)"[^>]*>/g) || []
    assert.equal(baseline.length, 1, `${label}: expected exactly one zero baseline`)
    const y = Number((baseline[0].match(/y1="([\d.]+)"/) || [])[1])
    assert.ok(Math.abs(y - PLOT_BOTTOM) < 0.02, `${label}: the zero baseline must sit on the plot floor, got ${y}`)
    // Every bar is measured from that floor, so bar height IS the count.
    // Measuring from anywhere else is how a count axis silently gets truncated.
    for (const bar of rects(m.svg.innerHTML, 'bin')) {
      assert.ok(Math.abs((bar.y + bar.height) - y) < 0.02, `${label}: a bar is not sitting on the zero baseline`)
    }
    const labels = (m.ylab.innerHTML.match(/>([^<]*)</g) || []).map((s) => s.slice(1, -1))
    assert.ok(labels.includes('0'), `${label}: the y axis must be labelled 0, got ${JSON.stringify(labels)}`)
    assert.ok(m.chart.data().bins.every((b) => b.count >= 0))
  }
})

test('no option can truncate the count axis', () => {
  // The guarantee is the absence of the switch. If someone later adds
  // `yFromZero` and lets it default to false on a histogram, this must fail.
  const m = mount(uniform100, { yFromZero: false, zeroBased: false, robust: true })
  const baseline = m.svg.innerHTML.match(/<line[^>]*stroke="var\(--chart-axis\)"[^>]*>/g) || []
  assert.equal(baseline.length, 1, 'a count axis must still be anchored at zero')
  const labels = (m.ylab.innerHTML.match(/>([^<]*)</g) || []).map((s) => s.slice(1, -1))
  assert.ok(labels.includes('0'), `y labels ${JSON.stringify(labels)} must include 0`)
})

test('a zero-count bin is still a bin: a hole in the sample shows as a hole', () => {
  // The one thing a histogram must NOT do is drop empty bins -- the hole is
  // part of the distribution. Two clusters far apart must show an empty middle.
  const values = [
    ...Array.from({ length: 20 }, (_, i) => i),
    ...Array.from({ length: 20 }, (_, i) => 1000 + i),
  ]
  const m = mount(values, { bins: 20 })
  const meta = m.chart.data()
  const zeros = meta.bins.filter((b) => b.count === 0).length
  assert.ok(zeros > 0, 'the sample really does have an empty middle')
  assert.equal(rects(m.svg.innerHTML, 'bin').length, meta.bins.length - zeros,
    'zero-height bins draw no rect')
  assert.equal(rects(m.svg.innerHTML, 'hit').length, meta.bins.length,
    'but every bin stays hoverable')
  assert.equal(Number(m.host.dataset.bins), 20)
})

// ─────────────────────────────────────────────── honesty about the data

test('the extent comes from the data and is never silently trimmed', () => {
  // A histogram containing a far outlier must still bin it. A "robust" fitted
  // extent would drop real observations, which is the one thing this chart
  // exists to show -- so unlike lineChart, there is no trimmed band here.
  const m = mount([...uniform100, 100000])
  const prep = m.chart.data()
  assert.equal(prep.domain[1], 100000, 'the extent must reach the outlier')
  assert.equal(prep.ignored, 0, 'nothing may be binned away when no domain was pinned')
  assert.equal(prep.total, 101, 'every finite value must land in a bin')
  assert.equal(prep.bins.reduce((s, b) => s + b.count, 0), 101)
})

test('a pinned domain reports what it excluded instead of hiding it', () => {
  const m = mount([1, 2, 3, 4, 5, 50, 60], { domain: [0, 10] })
  const prep = m.chart.data()
  assert.equal(prep.ignored, 2, '50 and 60 are outside the pinned extent')
  assert.equal(prep.total, 5)
  assert.equal(m.note.style.display, '', 'ignored values must be said out loud, not logged')
  assert.ok(m.note.textContent.includes('2'), `the note must state the count, got "${m.note.textContent}"`)
  // Shares are of what was binned, so they still sum to one.
  const sum = prep.bins.reduce((s, b) => s + b.share, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `shares must sum to 1, got ${sum}`)
})

test('non-finite input is counted and surfaced, not silently dropped', () => {
  const m = mount([1, 2, 3, NaN, null, 'x', 4], { label: 'errors' })
  const prep = m.chart.data()
  assert.equal(prep.rejected, 3, 'three unusable entries')
  assert.equal(prep.total, 4)
  assert.equal(m.note.style.display, '', 'the on-chart note must appear')
  assert.ok(m.note.textContent.includes('3'), `the note must state the count, got "${m.note.textContent}"`)
  assert.ok(m.svg.getAttribute('aria-label').includes('errors'))
  // A clean sample says nothing, because there is nothing to say.
  assert.equal(mount(uniform100).note.style.display, 'none')
})

test('the fixture the interaction tests rely on really has the counts they claim', () => {
  // Guards the tests themselves: if FD's answer for this sample changes, the
  // hover/click assertions would silently start checking a different bin.
  const bins = mount(uniform100).chart.data().bins
  assert.equal(bins.length, 5)
  assert.equal(bins[3].count, 20, 'five bins of 20 uniform values each')
  assert.equal(bins.reduce((s, b) => s + b.count, 0), 100)
})

test('every kind of dirty input degrades instead of throwing', () => {
  const cases = {
    empty: [],
    nothingFinite: [NaN, Infinity, -Infinity, null, undefined, '5', ''],
    oneFinite: [3],
    allEqual: new Array(500).fill(7),
    numericStrings: ['1', '2', '3'],
    mixed: [1, 'x', null, 2, {}, [], NaN, 3],
    negatives: [-5, -1, -3, -2, -4],
    hugeSpread: [1e-9, 1, 1e9],
    twoValues: [0, 1],
    nested: [{ value: 1 }, { value: 2 }, { value: 3 }, { nope: 4 }],
  }
  for (const [name, values] of Object.entries(cases)) {
    const m = mount(values)
    const prep = m.chart.data()
    assert.ok(Array.isArray(prep.bins) && prep.bins.length >= 1, `${name}: bins`)
    assert.ok(prep.bins.every((b) => Number.isInteger(b.count) && b.count >= 0), `${name}: counts`)
    assert.ok(prep.bins.every((b) => Number.isFinite(b.from) && Number.isFinite(b.to)), `${name}: edges`)
    assert.ok(Number.isFinite(prep.width) && prep.width > 0, `${name}: width ${prep.width}`)
    assert.ok(prep.domain.every(Number.isFinite), `${name}: domain`)
    assert.ok(prep.domain[1] >= prep.domain[0], `${name}: domain order`)
    // Whatever came out, the markup must be drawable: a NaN coordinate is the
    // classic way a whole chart disappears.
    assert.doesNotMatch(m.svg.innerHTML, /NaN/, `${name}: NaN leaked into the SVG`)
    assert.doesNotMatch(m.ylab.innerHTML, /NaN/, `${name}: NaN in the y labels`)
    assert.doesNotMatch(m.xlab.innerHTML, /NaN/, `${name}: NaN in the x labels`)
    assert.ok(m.svg.getAttribute('aria-label'), `${name}: an aria-label must exist`)
  }

  // Only genuinely empty input is empty; one value is still a distribution.
  assert.equal(mount([]).chart.data().empty, true)
  assert.equal(mount([NaN, null]).chart.data().empty, true)
  assert.equal(mount([3]).chart.data().empty, false, 'a single observation is still a distribution')
})

test('the empty state explains itself and clears anything stale', () => {
  const m = mount(uniform100)
  m.chart.update({ values: [] })
  flush()
  assert.equal(m.svg.innerHTML, '')
  assert.equal(m.ylab.innerHTML, '')
  assert.equal(m.xlab.innerHTML, '')
  assert.equal(m.tip.style.display, 'none')
  assert.match(m.svg.getAttribute('aria-label'), /no usable values/i)
  // "Empty because every field was null" and "empty because of a filter" are
  // different states, and the label has to say which one this is.
  assert.match(mount([NaN, null, 'x']).svg.getAttribute('aria-label'), /3 ignored/)
})

// ─────────────────────────────────────────────── text never enters the SVG

test('labels live in HTML overlays, never inside the SVG', () => {
  const m = mount(uniform100)
  assert.doesNotMatch(m.svg.innerHTML, /<text|<tspan/,
    'text inside the SVG would be stretched by preserveAspectRatio="none"')
  assert.equal(m.svg.getAttribute('preserveAspectRatio'), 'none')
  assert.ok(m.ylab.innerHTML.includes('<span'), 'the y labels are HTML')
  assert.ok(m.xlab.innerHTML.includes('<span'), 'the x labels are HTML')
  // X labels sit at their value's own position, not evenly spread across a flex
  // row -- the flex `.chart-xlab` rule in theme.css is deliberately overridden.
  assert.ok(/left:\s*(0|0\.000)%/.test(m.xlab.innerHTML),
    `the first x label must anchor to the left edge: ${m.xlab.innerHTML.slice(0, 160)}`)
  assert.ok(m.xlab.innerHTML.includes('translateX(-100%)'),
    'the last x label hangs left so it cannot overflow the plot')
})

test('every colour is a var(--chart-*) token, never a literal', () => {
  const m = mount(uniform100)
  m.event('mousemove', clientXOfBin(3, 5))
  m.chart.select(3)
  flush()
  const markup = m.svg.innerHTML + m.ylab.innerHTML + m.xlab.innerHTML + m.tip.innerHTML
  const colors = markup.match(/(?:fill|stroke|background)\s*[:=]\s*"?[^";>\s]+/g) || []
  assert.ok(colors.length > 0, 'the markup must actually contain colours to check')
  for (const c of colors) {
    // `transparent` / `none` are the absence of a colour rather than a colour
    // choice: they are how a hit target and a swatch spacer are declared.
    if (/^(?:fill|stroke|background)\s*[:=]\s*"?(?:transparent|none)"?$/.test(c)) continue
    assert.match(c, /var\(--chart-[a-z0-9-]+\)/, `literal colour in the rendering: ${c}`)
  }
  // And the source itself: no hex, no functional notation, no named palette.
  assert.doesNotMatch(SRC, /#[0-9a-fA-F]{3,8}\b/, 'hex colour literal in src/histogram.js')
  assert.doesNotMatch(SRC, /\b(?:rgb|rgba|hsl|hsla)\s*\(/, 'functional colour literal in src/histogram.js')
})

test('every token referenced actually exists in theme.css', () => {
  // A `var(--chart-...)` whose name is not declared resolves to nothing, so the
  // property is invalid and the element paints with its inherited/initial value.
  // That is invisible in a diff and can be invisible on screen too (a fill that
  // silently becomes black). The token set is theme.css's to define, and this
  // file must not invent names -- so it is checked rather than assumed.
  const css = readFileSync(fileURLToPath(new URL('../src/theme.css', import.meta.url)), 'utf8')
  const declared = new Set(css.match(/--chart-[a-z0-9-]+(?=\s*:)/g) || [])
  assert.ok(declared.size > 20, `theme.css should declare the palette, found ${declared.size}`)

  const used = new Set(SRC.match(/--chart-[a-z0-9-]+/g) || [])
  assert.ok(used.size >= 3, `the renderer should reference tokens, found ${used.size}`)
  for (const token of used) {
    assert.ok(declared.has(token),
      `${token} is referenced by src/histogram.js but never declared in theme.css`)
  }
})

test('labels that come from data are escaped', () => {
  const evil = '<img src=x onerror=alert(1)>'
  const m = mount([1, 2, 3, 4, 5, 6, 7, 8], { formatX: (v) => `${evil}${v}` })
  assert.ok(m.xlab.innerHTML.includes('&lt;img'), 'an HTML overlay label must be escaped')
  assert.doesNotMatch(m.xlab.innerHTML, /<img/)

  // The tooltip is built with innerHTML, so it is the most exposed surface.
  const t = mount(uniform100, { formatX: (v) => `<b>${v}` })
  t.event('mousemove', clientXOfBin(3, 5))
  assert.ok(isVisible(t.tip), 'the tooltip must be showing for this to prove anything')
  assert.ok(t.tip.innerHTML.includes('&lt;b&gt;'), 'the tooltip must escape its title')
  // The component emits exactly three of its own <b> value cells. An unescaped
  // `<b>` from the formatter would add a fourth -- and an unmatched one, which
  // is silently swallowed by the browser the moment it is assigned.
  assert.equal((t.tip.innerHTML.match(/<\/b>/g) || []).length, 3,
    'only the component\'s own value cells may contain markup')

  // A rich row accessor is data too, and an exception inside it must not escape.
  const bad = mount([{ value: 1 }, { value: 2 }], { value: () => { throw new Error('boom') } })
  assert.equal(bad.chart.data().rejected, 2, 'a throwing accessor counts as unusable, it does not throw')
})

// ─────────────────────────────────────────────── hover reads, click pins

test('hovering a bin gives the interval, the count and the share', () => {
  const m = mount(uniform100)
  const bins = m.chart.data().bins
  const target = 3

  m.event('mousemove', clientXOfBin(target, bins.length))
  assert.equal(m.tip.style.display, 'block', 'the tooltip must show')
  // The assertion that catches the `.chart-tip { display: none }` fallback: an
  // empty inline display computes to `none`, so the reading is never on screen.
  // Asserting `=== 'block'` above would only be a literal echo of the fix; this
  // one states the behaviour that actually matters.
  assert.ok(isVisible(m.tip), 'the tooltip must be on screen, not merely populated')
  assert.ok(m.tip.innerHTML.includes(bins[target].label), 'the interval must be in the reading')
  assert.ok(m.tip.innerHTML.includes('count'), 'the count must be in the reading')
  assert.ok(m.tip.innerHTML.includes('share'), 'the share must be there too, not only the count')
  assert.ok(m.tip.innerHTML.includes('%'), 'the share must read as a percentage')
  assert.ok(m.tip.innerHTML.includes(String(bins[target].count)), 'the count value itself')

  // Outside the plot there is nothing to read, so nothing is shown. An empty
  // tooltip is what makes the dead zone honest rather than stale.
  m.event('mousemove', 5)
  assert.equal(m.tip.style.display, 'none')
  m.event('mousemove', 700)
  assert.equal(m.tip.style.display, 'none')
})

test('the hover reading is complete: no click required', () => {
  // The skill's judgement: with nothing clicked, can a reader get every field of
  // the bin? If the full reading only appeared on click, looking at the data
  // would cost a click.
  const m = mount(uniform100)
  const bin = m.chart.data().bins[3]
  m.event('mousemove', clientXOfBin(3, 5))
  for (const field of [bin.label, String(bin.count), (bin.share * 100).toFixed(1)]) {
    assert.ok(m.tip.innerHTML.includes(field), `"${field}" is missing from the hover reading`)
  }
})

test('the hover callback receives a plain reading object, not live state', () => {
  const seen = []
  const m = mount(uniform100, { onHover: (bin, i) => seen.push([bin, i]) })
  const bins = m.chart.data().bins
  m.event('mousemove', clientXOfBin(3, bins.length))

  const [bin, i] = seen[seen.length - 1]
  assert.equal(i, 3)
  assert.deepEqual(Object.keys(bin).sort(),
    ['count', 'from', 'index', 'label', 'share', 'to', 'width'])
  assert.equal(bin.count, bins[3].count)
  assert.ok(Math.abs(bin.share - bins[3].count / 100) < 1e-9, 'share is the fraction of binned values')
  assert.equal(bin.label, bins[3].label)
  assert.ok(bin.width > 0)
  // It is a copy: a callback mutating it must not be able to move the chart.
  bin.count = 9999
  assert.equal(m.chart.data().bins[3].count, bins[3].count)

  m.event('mouseleave')
  assert.deepEqual(seen[seen.length - 1], [null, null], 'leaving must clear the reading')
})

test('clicking pins a reading, and the pin survives the pointer leaving', () => {
  const selections = []
  const m = mount(uniform100, { onSelect: (bin, i) => selections.push([bin, i]) })
  const n = m.chart.data().bins.length
  const x = clientXOfBin(3, n)

  m.event('click', x)
  assert.equal(selections[selections.length - 1][1], 3, 'the pin must name the bin that was clicked')
  assert.equal(selections[selections.length - 1][0].count, m.chart.data().bins[3].count)
  flush()
  assert.ok(m.svg.innerHTML.includes('var(--chart-selected)'), 'a pinned bin must be visibly marked')

  // Move away and then leave entirely: persisting is the whole point of a pin.
  m.event('mousemove', clientXOfBin(1, n))
  m.event('mouseleave')
  flush()
  assert.ok(m.svg.innerHTML.includes('var(--chart-selected)'),
    'the pin must survive the pointer leaving, or it is not a pin')

  // Clicking the same bin again releases it; clicking the void releases it too.
  m.event('click', x)
  flush()
  assert.equal(selections[selections.length - 1][1], null)
  assert.equal(m.svg.innerHTML.includes('var(--chart-selected)'), false)
  m.event('click', x)
  flush()
  m.event('click', 2)
  assert.equal(selections[selections.length - 1][1], null, 'clicking outside clears the pin')
})

test('pinned and hovered are two different appearances', () => {
  const m = mount(uniform100)
  const binAttr = (markup, i) => (markup.match(new RegExp(`<rect data-bin="${i}"[^>]*>`)) || [])[0] || ''

  m.event('mousemove', clientXOfBin(3, 5))
  flush()
  const hovered = m.svg.innerHTML
  assert.ok(binAttr(hovered, 3).includes('opacity="0.82"'), 'hover must bring its own bar forward')
  assert.equal(hovered.includes('var(--chart-selected)'), false, 'hover alone must not look pinned')
  assert.equal(hovered.includes('stroke="var(--chart-ink)"'), false, 'hover must not draw the pin outline')

  m.event('click', clientXOfBin(3, 5))
  m.event('mousemove', clientXOfBin(1, 5))
  flush()
  const pinned = m.svg.innerHTML
  assert.ok(pinned.includes('var(--chart-selected)'), 'a pin gets a band that hover does not')
  assert.ok(pinned.includes('stroke="var(--chart-ink)"'), 'and an outline, not just a different fill')
  assert.ok(binAttr(pinned, 3).includes('opacity="1"'), 'the pinned bar is the full-strength one')
  assert.ok(binAttr(pinned, 1).includes('opacity="0.82"'), 'the hovered bar is the brightened one')
  // Hover moved to bin 1, so bin 3's faint guide must be gone from the bars.
  const bars = pinned.match(/<rect data-bin="\d+"[^>]*>/g) || []
  assert.equal(bars.filter((b) => b.includes('opacity="1"')).length, 1, 'one bar at full strength')
  assert.equal(bars.filter((b) => b.includes('opacity="0.82"')).length, 1, 'one bar brightened by hover')
})

test('select() pins programmatically, the way a table row would', () => {
  const m = mount(uniform100)
  m.chart.select(3)
  flush()
  assert.ok(m.svg.innerHTML.includes('var(--chart-selected)'))
  assert.equal((m.svg.innerHTML.match(/stroke="var\(--chart-ink\)"/g) || []).length, 1,
    'exactly one bar is outlined')
  m.chart.select(null)
  flush()
  assert.equal(m.svg.innerHTML.includes('var(--chart-selected)'), false)
})

test('hovering an empty bin is allowed and reads as zero', () => {
  const values = [
    ...Array.from({ length: 20 }, (_, i) => i),
    ...Array.from({ length: 20 }, (_, i) => 1000 + i),
  ]
  const m = mount(values, { bins: 20 })
  const meta = m.chart.data()
  const empty = meta.bins.findIndex((b) => b.count === 0)
  assert.ok(empty > 0, 'the fixture must contain an empty bin')
  m.event('mousemove', clientXOfBin(empty, 20))
  assert.ok(isVisible(m.tip), 'an empty bin must still be pointable')
  assert.ok(m.tip.innerHTML.includes('0'), 'and must read as a count of zero, not as missing')
  assert.ok(m.tip.innerHTML.includes(meta.bins[empty].label))
})

// ─────────────────────────────────────────────── frames, updates, teardown

test('update() replaces the data and is idempotent for the same numbers', () => {
  const m = mount(uniform100)
  const first = m.svg.innerHTML
  const bins = Number(m.host.dataset.bins)
  m.chart.update({ values: uniform100 })
  flush()
  assert.equal(m.svg.innerHTML, first, 'the same input must render byte-identically')

  m.chart.update({ values: [1, 1, 1, 1, 2, 2] })
  flush()
  assert.equal(m.host.dataset.bins, '4', 'a tiny sample clamps to the bin floor')
  assert.notEqual(m.svg.innerHTML, first, 'new data must redraw')
  assert.ok(bins > 4)
})

test('one redraw per frame, however many updates arrive inside it', () => {
  const m = mount(uniform100)
  const drawn = m.host.dataset.bins
  const before = m.elementCount()

  // A burst of notifications inside a single frame must coalesce into one draw.
  m.chart.update({ values: uniform100 })
  m.chart.update({ values: uniform100 })
  m.chart.update({ values: [...uniform100, 500] })
  assert.equal(m.elementCount(), before, 'nothing may be rebuilt before the frame runs')
  flush()
  // The last update wins, and it produces a different bin count than the first.
  assert.notEqual(m.host.dataset.bins, drawn)
  assert.equal(Number(m.host.dataset.bins), binCount([...uniform100, 500]))
})

test('destroy() leaves the chart inert', () => {
  let renders = 0
  const m = mount(uniform100, { onRender: () => { renders += 1 } })
  assert.equal(renders, 1, 'a normal draw reports once')
  m.chart.destroy()
  assert.equal(m.host.innerHTML, '')
  const after = m.svg.innerHTML
  m.chart.update({ values: [1, 2, 3] })
  flush()
  assert.equal(m.svg.innerHTML, after, 'a destroyed chart must not redraw')
  assert.equal(renders, 1, 'and must not report again')
})

test('the render summary carries the binning and both rejection counts', () => {
  const seen = []
  mount([...uniform100, NaN, NaN], { onRender: (s) => seen.push(s), label: 'latency' })
  const s = seen[seen.length - 1]
  assert.equal(s.empty, false)
  assert.equal(s.bins.length, Number(mount(uniform100).host.dataset.bins))
  assert.equal(s.rejected, 2)
  assert.equal(s.ignored, 0)
  assert.equal(s.total, 100)
  assert.ok(s.width > 0)
  assert.equal(s.peak.count, Math.max(...s.bins.map((b) => b.count)))
  assert.equal(s.bins.reduce((acc, b) => acc + b.count, 0), s.total)
})
