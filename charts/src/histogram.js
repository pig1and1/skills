/**
 * Histogram: the distribution of ONE numeric variable.
 *
 * Four decisions in this file are deliberate, and each one is a way a histogram
 * usually lies:
 *
 *  1. THE BIN COUNT IS COMPUTED, NOT FIXED. A hard-coded 10 bins is a silent
 *     lie at both ends of the size range: 20 samples get 2 values per bin and
 *     read as a smooth curve, 50k samples get a 10-bar barcode that hides every
 *     mode. The rule lives in `binCount()` below (Freedman-Diaconis first), and
 *     is exported so it can be tested without a DOM.
 *
 *  2. THE Y AXIS STARTS AT ZERO, ALWAYS. A bin's height is a COUNT, so it
 *     encodes magnitude with AREA, and a truncated count axis exaggerates small
 *     differences until noise looks like structure. There is deliberately no
 *     `yFromZero` option here: unlike a line chart, where a fitted axis is the
 *     honest choice, a histogram has no case for one -- which is why core's
 *     `zeroBasedDomain` is used unconditionally below.
 *
 *  3. BINS TOUCH. A histogram bins a CONTINUOUS variable, so its bars are
 *     adjacent intervals of one range. A gap between them says "these are
 *     separate categories", which is a bar chart's grammar and is simply false
 *     here. So there is no `bandScale`/padding step: every bar spans its own bin
 *     exactly, edge to edge, and all bars are the same width because they all
 *     come from one width.
 *
 *  4. NO TEXT INSIDE THE SVG. The SVG fills its box with
 *     preserveAspectRatio="none" so the plot can stretch, and anything drawn in
 *     there stretches with it. Tick labels are absolutely-positioned HTML in
 *     overlays, exactly as line.js and bar.js do it.
 *
 * Everything numeric comes from core.js, which is unit-tested. This file places
 * numbers into SVG and counts what it had to ignore.
 */
import {
  isNum, num, zeroBasedDomain, niceTicks, plotArea, histogram, formatNumber,
  esc, px,
} from './core.js'

const NS = 'http://www.w3.org/2000/svg'
const PCT = String.fromCharCode(37)     // '%', without baking a glyph into a format string

/** Bin-count policy defaults. See binCount() for why these numbers. */
export const BIN_DEFAULTS = { minBins: 4, maxBins: 60, fallbackBins: 10 }

/**
 * PURE. Choose how many bins to cut a sample into. Returns an integer.
 *
 * Rules, in priority order:
 *
 *  1. Freedman-Diaconis: width = 2 * IQR / cbrt(n), bins = ceil(range / width).
 *     Preferred over Sturges because it is driven by the sample's own spread
 *     rather than by n alone, so it adapts to both a tight and a smeared-out
 *     sample. It is also why the IQR is used instead of the standard deviation:
 *     one outlier must not move every bin boundary in the chart.
 *  2. Sturges: ceil(log2(n)) + 1. The fallback when FD cannot answer -- fewer
 *     than 4 samples (no usable quartiles), or an IQR of exactly 0 (more than
 *     half the sample sitting on one value, e.g. a metric that is mostly zero).
 *     FD divides by that IQR, so it must not be trusted there.
 *  3. `fallbackBins` when there is no data at all.
 *
 * The result is clamped into [minBins, maxBins]. The clamp is not cosmetic: FD
 * returns hundreds of bins for a large smooth sample, which is hundreds of DOM
 * nodes of visual noise, and returns 1 for a tiny one, which is not a
 * distribution at all.
 *
 * @param {number[]} values may contain anything; non-finite entries are ignored
 * @param {{minBins?:number, maxBins?:number, fallbackBins?:number}} [options]
 * @returns {number} integer bin count, always >= 1
 */
export function binCount(values, options = {}) {
  const minBins = Math.max(1, Math.floor(num(options.minBins, BIN_DEFAULTS.minBins)))
  const fallbackBins = Math.max(1, Math.floor(num(options.fallbackBins, BIN_DEFAULTS.fallbackBins)))
  // maxBins is lifted to minBins rather than trusted: an inverted range would
  // otherwise make the clamp below throw the minimum away.
  const maxBins = Math.max(minBins, Math.floor(num(options.maxBins, BIN_DEFAULTS.maxBins)))

  const clean = (Array.isArray(values) ? values : []).filter(isNum).slice().sort((a, b) => a - b)
  const n = clean.length
  if (!n) return Math.min(maxBins, Math.max(minBins, fallbackBins))

  const range = clean[n - 1] - clean[0]
  if (!(range > 0)) return minBins    // every value identical: one bin is the truth

  // Linear-interpolation quantile -- the same convention core.boxStats uses.
  const at = (q) => {
    const pos = (n - 1) * q
    const idx = Math.floor(pos)
    const next = clean[idx + 1]
    return next === undefined ? clean[idx] : clean[idx] + (pos - idx) * (next - clean[idx])
  }
  const iqr = n >= 4 ? at(0.75) - at(0.25) : 0

  let raw
  if (iqr > 0) {
    const fdWidth = (2 * iqr) / Math.cbrt(n)
    raw = Math.ceil(range / fdWidth)
  } else {
    raw = Math.ceil(Math.log2(n)) + 1
  }
  if (!isNum(raw) || raw < 1) raw = fallbackBins

  return Math.min(maxBins, Math.max(minBins, Math.floor(raw)))
}

/** PURE. The ascending bin edges (bins + 1 of them) for a given bin count. */
export function binEdges(lo, hi, bins) {
  const n = Math.max(1, Math.floor(num(bins, BIN_DEFAULTS.fallbackBins)))
  const a = num(lo, 0)
  const width = (num(hi, a + 1) - a) / n || 1
  return Array.from({ length: n + 1 }, (_, i) => a + i * width)
}

/**
 * PURE. One interval as a readable string: "10 – 20", or ">= 10" / "< 0" when a
 * caller-pinned domain leaves a bin covering an open side.
 */
export function formatRange(from, to, fmt = (v) => formatNumber(v)) {
  if (from === -Infinity) return `< ${fmt(to)}`
  if (to === Infinity) return `>= ${fmt(from)}`
  return `${fmt(from)} – ${fmt(to)}`
}

/**
 * Histogram chart.
 *
 * Same lifecycle and option shape as lineChart()/barChart(): returns
 * `{ update, select, data, destroy }` and accepts onHover / onSelect / onRender.
 *
 * @param {HTMLElement} host
 * @param {object} options
 * @param {Array<number|{value:number}>} options.values  the sample
 * @param {(row:any)=>number} [options.value]  pull a number out of a richer row
 * @param {number} [options.height=280]
 * @param {{top:number,right:number,bottom:number,left:number}} [options.padding]
 * @param {[number,number]|null} [options.domain]  pin the x extent, for views
 *        that must stay comparable; values outside it are counted as `ignored`
 * @param {number} [options.bins]  override the adaptive count (a policy choice,
 *        so it is allowed -- but it is not the default)
 * @param {number} [options.minBins=4]
 * @param {number} [options.maxBins=60]
 * @param {number} [options.xTicks=4]
 * @param {(v:number)=>string} [options.formatX]
 * @param {(v:number)=>string} [options.formatY]
 * @param {string} [options.label]  what the variable is, for the a11y summary
 * @param {(bin:object|null, index:number|null)=>void} [options.onHover]
 * @param {(bin:object|null, index:number|null)=>void} [options.onSelect]
 * @param {(summary:object)=>void} [options.onRender]
 */
export function histogramChart(host, options = {}) {
  if (!host) throw new Error('histogramChart: host element is required')

  const state = { ...options, hover: null, selected: null, frame: 0, destroyed: false }
  const pad = { top: 26, right: 24, bottom: 30, left: 56, ...(options.padding || {}) }

  // ---- static DOM scaffold: created once, never rebuilt -------------------
  host.classList.add('chart')
  host.style.position = 'relative'
  host.innerHTML = ''
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('preserveAspectRatio', 'none')
  const tip = document.createElement('div')
  tip.className = 'chart-tip'
  const ylab = document.createElement('div')
  ylab.className = 'chart-ylab'
  // The HTML text layer. `chart-xlab` exists in theme.css as a flex row, so the
  // inline positioning here deliberately overrides it: these labels have to sit
  // under the plot at the axis value's own x, not evenly spread.
  const xlab = document.createElement('div')
  xlab.className = 'chart-xlab'
  xlab.setAttribute('aria-hidden', 'true')
  xlab.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:18px;display:block;' +
    'margin:0;padding-left:0;pointer-events:none;white-space:nowrap'
  const ytitle = document.createElement('span')
  ytitle.className = 'chart-ylab-title'
  ytitle.style.cssText = 'position:absolute;left:0;top:0;width:13px;transform:translateY(-50%);' +
    'font-size:11px;color:var(--chart-faint);text-align:center'
  // Two separate honesty surfaces: `legend` states the binning, `note` states
  // what was thrown away. Neither is optional -- see the skill's dirty-data rule
  // that dropped data must be visible, not merely logged.
  const legend = document.createElement('div')
  legend.className = 'chart-legend-row'
  legend.style.cssText = 'position:absolute;left:56px;bottom:2px;font-size:11px;' +
    'color:var(--chart-faint);pointer-events:none;white-space:nowrap'
  const note = document.createElement('div')
  note.className = 'chart-note'
  note.style.cssText = 'position:absolute;right:0;top:4px;font-size:11px;' +
    'color:var(--chart-warn);pointer-events:none;white-space:nowrap'
  host.append(svg, ylab, xlab, ytitle, legend, note, tip)

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null
  const height = () => Math.max(120, num(state.height, 280))
  const fmtX = (v) => (typeof state.formatX === 'function' ? state.formatX(v) : formatNumber(v))
  const fmtY = (v) => (typeof state.formatY === 'function' ? state.formatY(v) : formatNumber(v))

  /**
   * PURE w.r.t. the DOM: options -> the binned sample. No nodes touched, so it
   * is callable from a test and from the tooltip without redrawing anything.
   */
  function prepare() {
    const raw = Array.isArray(state.values) ? state.values : []
    const read = typeof state.value === 'function'
      ? state.value
      : (row) => (row && typeof row === 'object' ? row.value : row)

    const clean = []
    let rejected = 0
    for (const row of raw) {
      let v
      try { v = read(row) } catch { v = undefined }
      if (isNum(v)) clean.push(v)
      else rejected += 1
    }

    // The extent is derived from ALL finite values -- never from a trimmed band
    // the way a line chart's fitted domain is. Trimming here would drop real
    // observations out of the distribution, which is the one thing a histogram
    // exists to show. A caller-pinned domain still wins, because comparing two
    // views on one axis is worth the exclusion -- but then the excluded values
    // are counted and printed rather than quietly binned away.
    let extent
    const d = state.domain
    if (Array.isArray(d) && d.length === 2 && isNum(d[0]) && isNum(d[1])) {
      extent = d[0] <= d[1] ? [d[0], d[1]] : [d[1], d[0]]
    } else if (clean.length) {
      let lo = clean[0]
      let hi = clean[0]
      for (const v of clean) { if (v < lo) lo = v; if (v > hi) hi = v }
      extent = [lo, hi]
    } else {
      extent = [0, 1]
    }

    const explicit = num(state.bins, 0)
    const count = explicit >= 1 ? Math.floor(explicit) : binCount(clean, state)
    const h = histogram(clean, { bins: count, domain: extent })

    const bins = h.bins.map((b, i) => ({
      index: i,
      from: b.from,
      to: b.to,
      count: b.count,
      // Share of what was actually binned. Out-of-domain values stay out of the
      // denominator; folding them in would make the shares fail to sum to
      // 100% with no way for a reader to notice.
      share: h.total > 0 ? b.count / h.total : 0,
      label: formatRange(b.from, b.to, (v) => fmtX(v)),
    }))

    return {
      bins,
      width: h.width,
      domain: h.domain,
      total: h.total,
      ignored: h.ignored,
      rejected,
      empty: h.total === 0,
    }
  }

  /** PURE. The screen-reader sentence. */
  function ariaFor(prep) {
    const dirty = prep.rejected || prep.ignored
    if (prep.empty) {
      return `Histogram, no usable values${dirty ? `, ${formatNumber(dirty)} ignored` : ''}`
    }
    const peak = prep.bins.reduce((a, b) => (b.count > a.count ? b : a), prep.bins[0])
    return `${state.label ? `${state.label}: ` : ''}histogram of ${formatNumber(prep.total)} values in ` +
      `${prep.bins.length} bins, from ${fmtX(prep.domain[0])} to ${fmtX(prep.domain[1])}, ` +
      `peak ${formatNumber(peak.count)} in ${peak.label}` +
      (prep.ignored ? `, ${formatNumber(prep.ignored)} values outside the pinned range` : '')
  }

  function draw() {
    state.frame = 0
    if (state.destroyed) return

    const prep = prepare()
    const w = Math.max(1, host.clientWidth)
    const h = height()
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
    host.style.height = `${h}px`
    ytitle.textContent = state.yLabel || 'count'

    const finish = (payload) => {
      svg.setAttribute('aria-label', ariaFor(prep))
      const dirty = prep.rejected + prep.ignored
      note.style.display = dirty ? '' : 'none'
      if (dirty) note.textContent = `ignored ${formatNumber(prep.rejected)} non-numeric, ${formatNumber(prep.ignored)} out of range`
      state.onRender && state.onRender(payload)
    }

    if (prep.empty) {
      svg.innerHTML = ''
      ylab.innerHTML = ''
      xlab.innerHTML = ''
      legend.textContent = ''
      tip.style.display = 'none'
      finish({ ...prep, empty: true })
      return
    }

    const area = plotArea(w, h, pad)
    const [x0, x1] = prep.domain
    const span = (x1 - x0) || 1
    const n = prep.bins.length
    // Pixel edges, built once: bin i spans [edges[i], edges[i + 1]]. Every bin
    // comes from the same width, so they are equal by construction -- and
    // adjacent bins SHARE an edge coordinate, which is exactly what "no gap"
    // means. `plotArea` reserves fixed padding, so labels changing width can
    // never move the plot.
    const edgeAt = (i) => area.x + (i / n) * area.width

    // Zero-based, unconditionally: a bar's height is a count, and a count axis
    // that starts above zero inflates every difference.
    const [yLo, yHi] = zeroBasedDomain(prep.bins.map((b) => b.count), 1.08)
    const ys = (v) => area.y + area.height - ((num(v, yLo) - yLo) / (yHi - yLo)) * area.height
    const base = ys(0)
    const ticks = niceTicks(yLo, yHi, 4)

    let out = ''
    let peak = { count: -1 }
    for (const t of ticks) {
      const y = px(ys(t))
      out += `<line x1="${area.x}" y1="${y}" x2="${px(area.x + area.width)}" y2="${y}" ` +
        `stroke="${t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}" stroke-width="1"/>`
    }

    // The bars. No rounded cap: a bar chart rounds each cap because each bar is
    // its own object, but a histogram's bars are one skyline and rounding every
    // top would notch it.
    prep.bins.forEach((bin, i) => {
      if (bin.count > peak.count) peak = bin
      if (bin.count <= 0) return
      const x = edgeAt(i)
      const bw = Math.max(0.5, edgeAt(i + 1) - x)
      const top = ys(bin.count)
      out += `<rect data-bin="${i}" x="${px(x)}" y="${px(top)}" width="${px(bw)}" ` +
        `height="${px(base - top)}" fill="var(--chart-accent)" opacity="${binOpacity(i)}"/>`
    })

    // Pinned is not the same state as hovered, so the two must not look alike.
    // Hover is transient and only brightens the bar it points at (see
    // binOpacity). A pin is meant to persist and anchor the eye, so it gets a
    // full-strength fill plus an outline that survives the pointer moving away.
    // One visual for both would leave the reader unable to tell "what I
    // selected" from "what I am pointing at".
    if (state.selected !== null && prep.bins[state.selected]) {
      const x = edgeAt(state.selected)
      const bw = Math.max(0.5, edgeAt(state.selected + 1) - x)
      out += `<rect x="${px(x)}" y="${px(area.y - 6)}" width="${px(bw)}" ` +
        `height="${px(area.height + 10)}" fill="var(--chart-selected)"/>`
      const sel = prep.bins[state.selected]
      if (sel.count > 0) {
        out += `<rect x="${px(x)}" y="${px(ys(sel.count))}" width="${px(bw)}" ` +
          `height="${px(base - ys(sel.count))}" fill="var(--chart-accent)" ` +
          `stroke="var(--chart-ink)" stroke-width="1.25"/>`
      }
    }

    // One hit target per bin across the full plot height, so a bin holding a
    // single value is as easy to point at as one holding four hundred. Because
    // the targets are edge-to-edge too, the whole plot is live -- there is no
    // dead strip between bins where the tooltip would blink out.
    prep.bins.forEach((bin, i) => {
      const x = edgeAt(i)
      out += `<rect data-hit="${i}" x="${px(x)}" y="${area.y}" ` +
        `width="${px(Math.max(0.5, edgeAt(i + 1) - x))}" height="${area.height}" fill="transparent"/>`
    })
    svg.innerHTML = out

    ylab.innerHTML = ticks.map((t) => (
      `<span style="top:${((ys(t) / h) * 100).toFixed(3)}%">${esc(fmtY(t))}</span>`
    )).join('')
    ylab.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${pad.left}px;pointer-events:none`

    // X labels are HTML, and `esc()` is not optional: these come from the data.
    const xTicks = niceTicks(x0, x1, Math.max(2, Math.floor(num(state.xTicks, 4))))
    xlab.innerHTML = xTicks.map((t, i) => {
      const at = (num(t, x0) - x0) / span
      // First label hangs right, last hangs left, so neither runs off the plot.
      const align = i === 0 ? 'translateX(0)' : (i === xTicks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)')
      return `<span style="position:absolute;left:${(at * 100).toFixed(3)}%;bottom:0;transform:${align};` +
        `font-variant-numeric:tabular-nums">${esc(fmtX(t))}</span>`
    }).join('')

    // The binning is a product decision, so it is stated on the chart rather
    // than left for the reader to guess from the bar width.
    legend.textContent = `${prep.bins.length} bins · width ${fmtX(prep.width)} · ` +
      `${fmtX(prep.domain[0])} to ${fmtX(prep.domain[1])}`
    host.dataset.bins = String(n)
    host.dataset.binWidth = String(prep.width)
    host.dataset.binCounts = prep.bins.map((b) => b.count).join(',')

    finish({ ...prep, empty: false, peak })
  }

  /**
   * Bar fill strength: three states, three opacities.
   *
   * Opacity rather than three fill tokens, because theme.css defines ONE accent
   * and no hover/muted variants of it -- and inventing token names here would
   * produce `var()` references that resolve to nothing, which is worse than
   * having no states at all. Context recedes, the pointed-at bin comes forward.
   */
  function binOpacity(i) {
    if (i === state.selected) return 1
    if (i === state.hover) return 0.82
    return 0.45
  }

  function schedule() {
    // At most one redraw per frame. A ResizeObserver fires many times inside a
    // single layout, and rebuilding the SVG per callback is what makes a chart
    // flicker while a window is dragged.
    if (state.frame || state.destroyed) return
    state.frame = requestAnimationFrame(draw)
  }

  /** Which bin sits under this client x? Null outside the plot. */
  function binAt(clientX) {
    const prep = prepare()
    if (prep.empty) return null
    const box = svg.getBoundingClientRect()
    if (!box.width) return null
    const area = plotArea(host.clientWidth, height(), pad)
    const vx = ((clientX - box.left) / box.width) * host.clientWidth
    const frac = (vx - area.x) / area.width
    if (frac < 0 || frac > 1) return null
    return Math.max(0, Math.min(prep.bins.length - 1, Math.floor(frac * prep.bins.length)))
  }

  /**
   * The hover reading: the bin's interval, its count, and its share. All three,
   * because the interval alone does not say how many, and the count alone does
   * not say how much of the sample that is.
   */
  function tipHtml(bin, width) {
    const row = (swatch, name, value) =>
      `<div class="chart-tip-row"><i style="background:${swatch}"></i>${name}<b>${esc(value)}</b></div>`
    return `<div class="chart-tip-title">${esc(bin.label)}</div>` +
      row('var(--chart-accent)', 'count', formatNumber(bin.count)) +
      row('transparent', 'share', (bin.share * 100).toFixed(1) + PCT) +
      row('transparent', 'bin width', fmtX(width))
  }

  /**
   * The object handed to onHover/onSelect. A plain copy of leaf fields -- never
   * the live internal state, which would let a caller mutate the chart.
   */
  function binPayload(bin, index, width) {
    if (!bin) return null
    return {
      index,
      from: bin.from,
      to: bin.to,
      label: bin.label,
      count: bin.count,
      share: bin.share,
      width,
    }
  }

  host.addEventListener('mousemove', (e) => {
    const i = binAt(e.clientX)
    if (i === state.hover) return
    state.hover = i
    const prep = prepare()
    if (i === null) {
      tip.style.display = 'none'
    } else {
      tip.innerHTML = tipHtml(prep.bins[i], prep.width)
      // 'block', NOT ''. theme.css gives `.chart-tip { display: none }`, so
      // clearing the inline value makes the element fall back to that rule and
      // the tooltip never appears at all. (line.js and bar.js both have this
      // bug; a hover reading that silently never shows is invisible in any
      // static screenshot.)
      tip.style.display = 'block'
      const area = plotArea(host.clientWidth, height(), pad)
      const box = svg.getBoundingClientRect()
      const mid = area.x + ((i + 0.5) / prep.bins.length) * area.width
      const at = (mid / host.clientWidth) * box.width
      // Flip near the right edge instead of letting the tooltip leave the box.
      const wide = tip.offsetWidth > 0 ? tip.offsetWidth : 150
      const left = (at + 14 + wide > box.width) ? at - 14 - wide : at + 14
      tip.style.left = `${Math.max(8, Math.min(left, Math.max(8, box.width - wide - 8)))}px`
      tip.style.top = '4px'
    }
    state.onHover && state.onHover(binPayload(i === null ? null : prep.bins[i], i, prep.width), i)
    schedule()
  })

  host.addEventListener('mouseleave', () => {
    if (state.hover === null) return
    state.hover = null
    tip.style.display = 'none'
    state.onHover && state.onHover(null, null)
    schedule()
  })

  host.addEventListener('click', (e) => {
    const i = binAt(e.clientX)
    // Clicking the pinned bin again, or clicking outside the plot, clears it.
    state.selected = (i === null || state.selected === i) ? null : i
    const prep = prepare()
    const bin = state.selected === null ? null : prep.bins[state.selected]
    state.onSelect && state.onSelect(binPayload(bin, state.selected, prep.width), state.selected)
    schedule()
  })

  if (observer) observer.observe(host)
  schedule()

  return {
    /** Replace data and/or options, then redraw. */
    update(next = {}) {
      Object.assign(state, next)
      schedule()
    },
    /** Programmatic selection (mirrors a click). Pass null to clear. */
    select(index) {
      state.selected = index
      schedule()
    },
    /** The prepared numbers, so a table beside the chart can reuse them. */
    data: prepare,
    destroy() {
      state.destroyed = true
      if (observer) observer.disconnect()
      if (state.frame) cancelAnimationFrame(state.frame)
      host.innerHTML = ''
    },
  }
}
