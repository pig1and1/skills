/**
 * Scatter chart: two numeric axes, one mark per record (or per cluster).
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE
 *
 * 1. A SCATTER ENCODES POSITION, NOT AREA, so its axes do not have to start at
 *    zero. Pinning y=0 onto a cloud that lives between 900 and 1100 squashes
 *    the whole structure into a flat line and hides the very correlation the
 *    chart was drawn to show. Zero is opt-in PER AXIS (`xFromZero` /
 *    `yFromZero`) for the cases where the baseline is the message -- counts,
 *    error rates. The judgement applied here is the skill's: shape encodes
 *    quantity -> start at zero; shape only encodes position -> do not.
 *
 * 2. OVERPLOTTING MAKES A SCATTER LIE. A thousand records on one spot draw a
 *    thousand identical dots and that still reads as ONE dot: the picture says
 *    "one record here" when the truth is "a thousand". So coincident points are
 *    collapsed in SCREEN space (`binOverplot`): each cell of `cell` px becomes a
 *    single mark whose AREA and opacity grow with the number of points it
 *    stands for, and whose tooltip states the exact count and the x/y span it
 *    covers. A cell holding one point keeps that point's exact position, so an
 *    uncluttered scatter remains a plain, honest scatter.
 *
 * Division of labour, as in line.js / bar.js: all arithmetic lives in core.js
 * (unit-tested, no DOM), this file only places numbers into SVG. Every label
 * lives in HTML, never in the SVG, because the plot fills its box with
 * preserveAspectRatio="none" and text inside it would be stretched.
 *
 * Two pure helpers are exported alongside the chart (`prepareScatter`,
 * `binOverplot`, plus the two radius/opacity maps) because core.js is frozen:
 * they are the parts most likely to be wrong and they must be reachable from a
 * test without a DOM. That is the same reason core.js exists at all.
 */
import {
  isNum, num, linearScale, niceTicks, plotArea, sanitize,
  robustDomain, zeroBasedDomain, formatTick, formatNumber, esc, px,
} from './core.js'

const NS = 'http://www.w3.org/2000/svg'

// ────────────────────────────────────────────────────────────── pure helpers

/**
 * A domain for one axis.
 *
 * Three policies, and only one of them is the default:
 *   fitted (default) -- the data's own range plus padding. A scatter shows
 *                       position, so its axes follow the data.
 *   robust           -- the 1%-99% quantile band, for data whose extremes are
 *                       noise. Points outside are still drawn (clipped by the
 *                       SVG box) and `trimmed` reports how many were excluded,
 *                       because a silently dropped point is a lie.
 *   fromZero         -- the baseline is the message (counts, rates).
 *
 * The fitted case is expressed through `robustDomain(values, {low:0, high:1})`,
 * which is exactly "min/max plus padding, degenerate domains widened". Writing
 * a second min/max routine here would be a copy of a tested one.
 *
 * @returns {{domain:[number,number], trimmed:number, fromZero:boolean}}
 */
function axisDomain(values, options, axis) {
  const clean = (Array.isArray(values) ? values : []).filter(isNum)
  const fromZero = options[axis + 'FromZero'] === true
  if (!clean.length) return { domain: [0, 1], trimmed: 0, fromZero }

  if (fromZero) {
    // zeroBasedDomain() assumes a non-negative measure, which is right for bars
    // (area) and wrong for a scatter axis that can carry negatives -- it would
    // push real points off the plot. Widen the zero-based result to include
    // whatever the data actually spans.
    let lo = Infinity
    let hi = -Infinity
    for (const v of clean) { if (v < lo) lo = v; if (v > hi) hi = v }
    const [zlo, zhi] = zeroBasedDomain(clean, 1.08)
    const a = Math.min(zlo, lo)
    const b = Math.max(zhi, hi)
    return { domain: b - a > 1e-12 ? [a, b] : [a - 1, b + 1], trimmed: 0, fromZero: true }
  }

  const r = robustDomain(clean, options.robust === true
    ? { low: num(options.trimLow, 0.01), high: num(options.trimHigh, 0.99) }
    : { low: 0, high: 1 })
  return { domain: r.domain, trimmed: r.trimmed, fromZero: false }
}

/**
 * Pure: records -> plot-ready points, hygiene included.
 *
 * @param {Array<object>} input
 * @param {object} [options]
 * @param {(row:object)=>unknown} [options.x] x accessor (default `row.x`)
 * @param {(row:object)=>unknown} [options.y] y accessor (default `row.y`)
 * @param {boolean} [options.xFromZero] / [options.yFromZero]
 * @param {boolean} [options.robust] 1%-99% quantile band instead of min/max
 * @param {number}  [options.trimLow=0.01] / [options.trimHigh=0.99]
 * @returns {{points:Array, domain:{x:number[],y:number[]}, trimmed:{x:number,y:number}, fromZero:{x:boolean,y:boolean}, rejected:number, reasons:object, empty:boolean}}
 */
export function prepareScatter(input, options = {}) {
  const readX = typeof options.x === 'function' ? options.x : (p) => (p ? p.x : undefined)
  const readY = typeof options.y === 'function' ? options.y : (p) => (p ? p.y : undefined)

  // A point needs BOTH coordinates to sit anywhere. Dropping half a point is
  // not an option, so a row with one bad axis is one rejected row -- and the
  // count is reported (`rejected`, `reasons`) rather than swallowed.
  const clean = sanitize(input, { x: readX, y: readY })
  const points = clean.rows.map((row, index) => ({ x: readX(row), y: readY(row), row, index }))

  const x = axisDomain(points.map((p) => p.x), options, 'x')
  const y = axisDomain(points.map((p) => p.y), options, 'y')

  return {
    points,
    domain: { x: x.domain, y: y.domain },
    trimmed: { x: x.trimmed, y: y.trimmed },
    fromZero: { x: x.fromZero, y: y.fromZero },
    rejected: clean.rejected,
    reasons: clean.reasons,
    empty: points.length === 0,
  }
}

/** One pass of screen-space binning. Not exported: `binOverplot` drives it. */
function binOnce(screen, cell) {
  const map = new Map()
  for (const s of screen) {
    const gx = Math.floor(s.x / cell)
    const gy = Math.floor(s.y / cell)
    const key = gx + ':' + gy
    let b = map.get(key)
    if (!b) {
      b = { key, count: 0, sx: 0, sy: 0, first: s, xLo: Infinity, xHi: -Infinity, yLo: Infinity, yHi: -Infinity }
      map.set(key, b)
    }
    b.count += 1
    b.sx += s.x
    b.sy += s.y
    // The DATA span the cell covers, kept for the tooltip: "these points are
    // somewhere in here" is the honest statement a binned mark can make.
    if (s.dx < b.xLo) b.xLo = s.dx
    if (s.dx > b.xHi) b.xHi = s.dx
    if (s.dy < b.yLo) b.yLo = s.dy
    if (s.dy > b.yHi) b.yHi = s.dy
  }

  const marks = []
  for (const b of map.values()) {
    const single = b.count === 1
    marks.push({
      key: b.key,
      count: b.count,
      // A lone point is placed exactly; a cluster is placed at its centroid.
      // The cell centre would sometimes land where no point is at all, and at
      // the plot edge it can even fall outside the box.
      x: single ? b.first.x : b.sx / b.count,
      y: single ? b.first.y : b.sy / b.count,
      // `src` points back at the record (the caller supplies it); without one
      // the pixel item itself is all there is to show.
      sample: b.first.src || b.first,
      span: { x: [b.xLo, b.xHi], y: [b.yLo, b.yHi] },
    })
  }
  // Densest first, so sparse exact points are never buried under a cluster.
  marks.sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : 1))
  return { marks, groups: map.size }
}

/**
 * Pure: pixel-space points -> clustered marks, with no point lost.
 *
 * `maxMarks` bounds the SVG node count (the skill's <= 1-2k inline-SVG budget).
 * When the cell size would blow that budget the grid is COARSENED until it
 * fits, rather than dropping marks: a coarser picture of every point beats a
 * sharp picture of some of them. `grown` and `over` report which happened.
 *
 * @param {Array<{x:number,y:number,dx:number,dy:number,src?:object}>} screen
 *        pixel position in x/y, data value in dx/dy, and optionally the source
 *        record in `src` (it is what the mark reports as its sample)
 * @param {{cell?:number, maxMarks?:number, maxCell?:number}} [options]
 * @returns {{marks:Array, cell:number, groups:number, grown:boolean, over:boolean}}
 */
export function binOverplot(screen, options = {}) {
  const list = Array.isArray(screen) ? screen : []
  const maxMarks = Math.max(1, Math.floor(num(options.maxMarks, 2000)))
  const maxCell = Math.max(2, num(options.maxCell, 96))
  let cell = Math.max(2, num(options.cell, 14))

  let out = binOnce(list, cell)
  let grown = false
  while (out.marks.length > maxMarks && cell < maxCell) {
    cell = Math.min(maxCell, cell * 1.5)
    out = binOnce(list, cell)
    grown = true
  }
  return { marks: out.marks, cell, groups: out.groups, grown, over: out.marks.length > maxMarks }
}

/**
 * Mark radius from the number of points it stands for.
 *
 * Area -- not radius -- is what a reader compares, so the radius grows with
 * sqrt(count): doubling the area is what "twice as many points" should look
 * like. Capped, or one dense cell would swallow the plot.
 */
export function markRadius(count, { r = 2.4, max = 8 } = {}) {
  return Math.min(max, r * Math.sqrt(Math.max(1, num(count, 1))))
}

/** Opacity from the point count: a lone point stays light, a cluster goes solid. */
export function markOpacity(count) {
  const c = Math.max(1, num(count, 1))
  return Math.min(0.95, 0.7 + 0.25 * (1 - 1 / Math.sqrt(c)))
}

// ────────────────────────────────────────────────────────────── the chart

/**
 * @param {HTMLElement} host
 * @param {object} options
 * @param {Array<object>} options.points              records with numeric x and y
 * @param {(row:object)=>unknown} [options.x]         x accessor (default `row.x`)
 * @param {(row:object)=>unknown} [options.y]         y accessor (default `row.y`)
 * @param {number} [options.height=300]
 * @param {string} [options.xLabel] / [options.yLabel]  axis names
 * @param {string} [options.xUnit] / [options.yUnit]    axis units; shown in the
 *        axis title as "(unit)" and appended to the readings in the tooltip
 * @param {boolean} [options.xFromZero=false] / [options.yFromZero=false]
 * @param {boolean} [options.robust=false]            trim to the 1%-99% band
 * @param {number}  [options.trimLow=0.01] / [options.trimHigh=0.99]
 * @param {number}  [options.cell=14]                 overplot grid, in px
 * @param {number}  [options.maxMarks=2000]           upper bound on SVG marks
 * @param {number}  [options.radius=2.4] / [options.maxRadius=8]
 * @param {(row:object)=>string} [options.labelOf]    name shown in the tooltip title
 * @param {Array<{key?:string,label?:string,read?:Function,format?:Function}>} [options.fields]
 *        extra readings for the tooltip; when absent, numeric fields of the
 *        record are listed automatically so hover shows every field unasked
 * @param {boolean} [options.includeFields=true]      set false to suppress that
 * @param {(v:number)=>string} [options.formatX] / [options.formatY]
 * @param {number} [options.padding]                  {top,right,bottom,left}
 * @param {string} [options.label]                    series name, for the a11y summary
 * @param {(point:object|null, index:number|null)=>void} [options.onHover]
 * @param {(point:object|null, index:number|null)=>void} [options.onSelect]
 * @param {(summary:object)=>void} [options.onRender]
 */
export function scatterChart(host, options = {}) {
  if (!host) throw new Error('scatterChart: host element is required')

  const state = { ...options, hover: null, selected: null, frame: 0, destroyed: false, geometry: null }
  // left/bottom are wider than the line chart's: a numeric x axis needs its own
  // row of tick labels plus a title, and the y labels can carry units.
  const pad = { top: 30, right: 24, bottom: 46, left: 62, ...(options.padding || {}) }

  // ---- static DOM scaffold: created once, never rebuilt -------------------
  host.classList.add('chart')
  host.style.position = 'relative'
  host.innerHTML = ''
  // Keyboard users need a way out of a pinned reading ("pinned" is a state the
  // mouse created, so the keyboard has to be able to end it).
  if (typeof host.hasAttribute !== 'function' || !host.hasAttribute('tabindex')) host.tabIndex = 0

  const el = (tag, cls) => {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    return node
  }

  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('preserveAspectRatio', 'none')
  const ylab = el('div', 'chart-ylab')          // y tick labels, HTML (theme.css)
  const xlab = el('div', 'chart-xlab')          // x tick labels, HTML (theme.css)
  const yTitle = el('div', 'chart-axistitle chart-axistitle-y')
  const xTitle = el('div', 'chart-axistitle chart-axistitle-x')
  const empty = el('div', 'chart-empty')
  const tip = el('div', 'chart-tip')
  host.append(svg, ylab, xlab, yTitle, xTitle, empty, tip)

  empty.style.cssText = 'position:absolute;left:0;right:0;top:0;bottom:0;display:none;' +
    'align-items:center;justify-content:center;text-align:center;padding:16px 28px;' +
    'font-size:12px;line-height:1.6;color:var(--chart-muted);pointer-events:none'
  // Axis titles are text, so they live in HTML. theme.css has no class for them
  // yet, so the styling is inline here (see the report): no new token is
  // introduced, only existing --chart-* tokens are referenced.
  yTitle.style.cssText = `position:absolute;left:0;top:2px;height:16px;line-height:16px;` +
    `max-width:${pad.left + 40}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
    `font-size:11px;color:var(--chart-faint);pointer-events:none`
  xTitle.style.cssText = 'position:absolute;right:0;bottom:0;height:16px;line-height:16px;' +
    'font-size:11px;color:var(--chart-faint);pointer-events:none;white-space:nowrap'

  const observer = new ResizeObserver(() => schedule())
  const height = () => num(state.height, 300)
  const fmtX = (v) => (state.formatX ? state.formatX(v) : formatTick(v, { compact: true }))
  const fmtY = (v) => (state.formatY ? state.formatY(v) : formatTick(v, { compact: true }))

  /** Pure: rows -> points + domains. Delegates to the tested helper. */
  function prepare() {
    return prepareScatter(state.points, state)
  }

  /** "Latency (ms)" -- the one place axis naming and units are assembled. */
  function axisTitle(name, unit) {
    const u = unit ? ` (${unit})` : ''
    if (name) return `${name}${u}`
    return unit || ''
  }

  /** A reading with its unit: no space, so "%" and "ms" both read correctly. */
  function reading(value, format, unit) {
    return esc(String(format(value))) + (unit ? esc(String(unit)) : '')
  }

  function tipRow(label, value, color) {
    return `<div class="chart-tip-row"><i style="background:${color}"></i>` +
      `${esc(String(label))}<b>${esc(String(value))}</b></div>`
  }

  /**
   * Extra readings for the tooltip. The skill's test is "can every field be
   * read without clicking", so when the caller declares nothing, the record's
   * own numeric (and short string) fields are listed instead of a bare x/y.
   */
  function extraReadings(mark) {
    const row = mark.sample.row
    if (Array.isArray(state.fields)) {
      return state.fields.map((spec) => {
        let v
        try {
          v = typeof spec.read === 'function' ? spec.read(row) : (row ? row[spec.key] : undefined)
        } catch { v = undefined }
        const text = typeof spec.format === 'function' ? spec.format(v) : (isNum(v) ? formatNumber(v) : v)
        return { label: spec.label ?? spec.key ?? '—', text }
      })
    }
    if (state.includeFields === false || !row || typeof row !== 'object') return []
    const skip = new Set([state.xKey || 'x', state.yKey || 'y'])
    const out = []
    for (const key of Object.keys(row)) {
      if (out.length >= 6) break
      if (skip.has(key) || key.startsWith('__')) continue
      const v = row[key]
      if (isNum(v)) out.push({ label: key, text: formatNumber(v) })
      else if (typeof v === 'string' && v.length <= 32) out.push({ label: key, text: v })
    }
    return out
  }

  /**
   * What a mark means, as a plain object with no live references to the chart.
   * Callers receive this from onHover/onSelect: the record's own fields plus
   * the x/y actually plotted, plus (for a cluster) how many points it stands
   * for and the data span it covers.
   */
  function displayFor(mark, markIndex) {
    const row = mark.sample.row
    const out = (row && typeof row === 'object') ? { ...row } : {}
    out.x = mark.sample.x
    out.y = mark.sample.y
    out.count = mark.count
    out.markIndex = markIndex
    if (mark.count > 1) {
      out.xRange = mark.span.x.slice()
      out.yRange = mark.span.y.slice()
    }
    return out
  }

  function emptyReason(prep) {
    if (prep.rejected > 0) {
      return `无可绘制的数据点：${formatNumber(prep.rejected)} 条记录的 x 或 y 不是有限数值，已全部忽略`
    }
    return '没有数据点'
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

    if (!prep.points.length) {
      svg.innerHTML = ''
      ylab.innerHTML = ''
      xlab.innerHTML = ''
      tip.style.display = 'none'
      state.geometry = null
      state.hover = null
      // Empty is a state, not a blank: say WHY it is empty.
      empty.style.display = 'flex'
      empty.textContent = emptyReason(prep)
      yTitle.textContent = axisTitle(state.yLabel, state.yUnit)
      xTitle.textContent = axisTitle(state.xLabel, state.xUnit)
      host.dataset.points = '0'
      host.dataset.marks = '0'
      host.dataset.empty = '1'
      svg.setAttribute('aria-label', prep.rejected
        ? `No data: all ${prep.rejected} rows had an unusable x or y`
        : 'No data')
      state.onRender && state.onRender({ ...prep, empty: true })
      return
    }
    empty.style.display = 'none'
    host.dataset.empty = '0'

    const area = plotArea(w, h, pad)
    const xs = linearScale(prep.domain.x, [area.x, area.x + area.width])
    const ys = linearScale(prep.domain.y, [area.y + area.height, area.y])
    const xTicks = niceTicks(prep.domain.x[0], prep.domain.x[1], 4)
    const yTicks = niceTicks(prep.domain.y[0], prep.domain.y[1], 4)

    const screen = prep.points.map((p) => ({
      x: xs.scale(p.x), y: ys.scale(p.y), dx: p.x, dy: p.y, src: p,
    }))
    const binned = binOverplot(screen, {
      cell: num(state.cell, 14),
      maxMarks: num(state.maxMarks, 2000),
    })
    const marks = binned.marks

    // Indices only mean anything against the marks they were taken from.
    if (state.hover !== null && !marks[state.hover]) state.hover = null
    if (state.selected !== null && !marks[state.selected]) state.selected = null
    state.geometry = { area, marks, cell: binned.cell, w, h }

    const yZero = prep.domain.y[0] < 0 && prep.domain.y[1] > 0
    const xZero = prep.domain.x[0] < 0 && prep.domain.x[1] > 0
    let out = ''

    // Grid: faintest tone; a zero line is the one grid line with meaning, so it
    // keeps the stronger axis tone.
    for (const t of yTicks) {
      const y = px(ys.scale(t))
      out += `<line x1="${area.x}" y1="${y}" x2="${px(area.x + area.width)}" y2="${y}" ` +
        `stroke="${t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}" stroke-width="1"/>`
    }
    for (const t of xTicks) {
      const x = px(xs.scale(t))
      out += `<line x1="${x}" y1="${area.y}" x2="${x}" y2="${px(area.y + area.height)}" ` +
        `stroke="${t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}" stroke-width="1"/>`
    }
    // A domain can straddle zero without a round tick landing on it; the reader
    // still needs to see where zero is.
    if (yZero && !yTicks.includes(0)) {
      const y = px(ys.scale(0))
      out += `<line x1="${area.x}" y1="${y}" x2="${px(area.x + area.width)}" y2="${y}" ` +
        `stroke="var(--chart-axis)" stroke-width="1"/>`
    }
    if (xZero && !xTicks.includes(0)) {
      const x = px(xs.scale(0))
      out += `<line x1="${x}" y1="${area.y}" x2="${x}" y2="${px(area.y + area.height)}" ` +
        `stroke="var(--chart-axis)" stroke-width="1"/>`
    }

    // Hover feedback: a thin crosshair plus an enlarged mark. Deliberately NOT
    // the bar chart's filled column -- that idiom says the slot is the unit of
    // data, and it would cover the cloud the reader came to look at. The fill
    // token (`--chart-selected`) is reserved for the pinned state, which is
    // meant to persist and to anchor the eye.
    const active = state.selected !== null ? state.selected : state.hover
    const activeMark = (active !== null && marks[active]) ? marks[active] : null
    if (activeMark) {
      if (state.selected !== null) {
        out += `<circle cx="${px(activeMark.x)}" cy="${px(activeMark.y)}" ` +
          `r="${px(markRadius(activeMark.count, { r: num(state.radius, 2.4), max: num(state.maxRadius, 8) }) + 7)}" ` +
          `fill="var(--chart-selected)"/>`
      }
      out += `<line x1="${px(activeMark.x)}" y1="${area.y}" x2="${px(activeMark.x)}" ` +
        `y2="${px(area.y + area.height)}" stroke="var(--chart-guide)" stroke-width="1" stroke-dasharray="3 3"/>`
      out += `<line x1="${area.x}" y1="${px(activeMark.y)}" x2="${px(area.x + area.width)}" ` +
        `y2="${px(activeMark.y)}" stroke="var(--chart-guide)" stroke-width="1" stroke-dasharray="3 3"/>`
    }

    const rBase = num(state.radius, 2.4)
    const rMax = num(state.maxRadius, 8)
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i]
      if (activeMark === m) continue        // drawn enlarged, on top
      const r = markRadius(m.count, { r: rBase, max: rMax })
      out += `<circle cx="${px(m.x)}" cy="${px(m.y)}" r="${px(r)}" fill="var(--chart-accent)" ` +
        `fill-opacity="${markOpacity(m.count).toFixed(3)}" stroke="var(--chart-surface)" stroke-width="1.1" ` +
        `vector-effect="non-scaling-stroke"/>`
    }
    if (activeMark) {
      const r = markRadius(activeMark.count, { r: rBase, max: rMax })
      out += `<circle cx="${px(activeMark.x)}" cy="${px(activeMark.y)}" r="${px(r * 1.4 + 1)}" ` +
        `fill="var(--chart-accent)" stroke="var(--chart-surface)" stroke-width="2.2" ` +
        `vector-effect="non-scaling-stroke"/>`
    }
    svg.innerHTML = out

    ylab.innerHTML = yTicks.map((t) => (
      `<span style="top:${((ys.scale(t) / h) * 100).toFixed(3)}%">${esc(fmtY(t))}</span>`
    )).join('')
    ylab.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${pad.left}px;pointer-events:none`
    xlab.innerHTML = xTicks.map((t) => {
      // Clamped, because a tick at the very edge of the domain would otherwise
      // push its label outside the box.
      const pct = Math.max(0.5, Math.min(99.5, (xs.scale(t) / w) * 100))
      return `<span style="position:absolute;left:${pct.toFixed(3)}%;transform:translateX(-50%);` +
        `white-space:nowrap">${esc(fmtX(t))}</span>`
    }).join('')
    xlab.style.cssText = 'position:absolute;left:0;right:0;bottom:20px;height:16px;display:block;' +
      'padding-left:0;margin-top:0;pointer-events:none'
    yTitle.textContent = axisTitle(state.yLabel, state.yUnit)
    xTitle.textContent = axisTitle(state.xLabel, state.xUnit)

    const collapsed = prep.points.length - marks.length
    host.dataset.points = String(prep.points.length)
    host.dataset.marks = String(marks.length)
    host.dataset.cell = String(binned.cell)
    svg.setAttribute('aria-label', ariaFor(prep, marks, collapsed))

    state.onRender && state.onRender({
      ...prep,
      marks,
      cell: binned.cell,
      groups: binned.groups,
      grown: binned.grown,
      over: binned.over,
      collapsed,
      empty: false,
    })
  }

  function ariaFor(prep, marks, collapsed) {
    let xLo = Infinity
    let xHi = -Infinity
    let yLo = Infinity
    let yHi = -Infinity
    for (const p of prep.points) {
      if (p.x < xLo) xLo = p.x
      if (p.x > xHi) xHi = p.x
      if (p.y < yLo) yLo = p.y
      if (p.y > yHi) yHi = p.y
    }
    const unit = (u) => (u ? ` ${u}` : '')
    const parts = [
      state.label ? `${state.label}: ` : '',
      `Scatter plot, ${prep.points.length} points`,
      `x ${formatNumber(xLo)} to ${formatNumber(xHi)}${unit(state.xUnit)}`,
      `y ${formatNumber(yLo)} to ${formatNumber(yHi)}${unit(state.yUnit)}`,
    ]
    if (prep.rejected) parts.push(`${prep.rejected} rows ignored (no usable x or y)`)
    if (collapsed > 0) parts.push(`${collapsed} points share a spot with another and are drawn as ${marks.length} marks`)
    return parts.join(', ')
  }

  function tipHtml(mark) {
    const title = mark.count > 1
      ? `${formatNumber(mark.count)} 个点重合`
      : (state.labelOf ? state.labelOf(mark.sample.row) : `点 #${mark.sample.index + 1}`)
    const rows = []
    rows.push(tipRow(state.xLabel || 'x', reading(mark.sample.x, fmtX, state.xUnit), 'var(--chart-accent)'))
    rows.push(tipRow(state.yLabel || 'y', reading(mark.sample.y, fmtY, state.yUnit), 'var(--chart-accent)'))
    if (mark.count > 1) {
      // What a cluster can honestly claim: a count and the span it covers.
      rows.push(tipRow(`${state.xLabel || 'x'} 范围`,
        `${fmtX(mark.span.x[0])} – ${fmtX(mark.span.x[1])}`, 'var(--chart-faint)'))
      rows.push(tipRow(`${state.yLabel || 'y'} 范围`,
        `${fmtY(mark.span.y[0])} – ${fmtY(mark.span.y[1])}`, 'var(--chart-faint)'))
    }
    for (const f of extraReadings(mark)) {
      rows.push(tipRow(f.label, f.text, 'var(--chart-faint)'))
    }
    return `<div class="chart-tip-title">${esc(String(title))}</div>${rows.join('')}`
  }

  function placeTip(mark) {
    const geo = state.geometry
    const box = svg.getBoundingClientRect()
    if (!geo || !box.width) return
    const sx = box.width / geo.w || 1
    const sy = (box.height || geo.h) / geo.h || 1
    const px0 = mark.x * sx
    const py0 = mark.y * sy
    const tw = tip.offsetWidth || 0
    const th = tip.offsetHeight || 0
    const maxLeft = Math.max(6, box.width - tw - 8)
    let left = px0 + 14
    // Near the right edge the panel flips to the other side instead of leaving
    // the box.
    if (left > maxLeft) left = px0 - tw - 14
    tip.style.left = `${Math.max(6, Math.min(maxLeft, left))}px`
    tip.style.top = `${Math.max(4, Math.min((box.height || geo.h) - th - 4, py0 - th / 2))}px`
  }

  /**
   * Nearest mark in SCREEN space, with slack.
   *
   * Screen space is the right space: the reader is pointing at a dot on a
   * screen, and the two axes are scaled independently, so "closest" has to mean
   * closest as drawn. The search is linear (a few hundred to 2k marks), which
   * is far cheaper than maintaining a spatial index for one pointer.
   */
  function markAt(clientX, clientY) {
    const geo = state.geometry
    if (!geo || !geo.marks.length) return null
    const box = svg.getBoundingClientRect()
    if (!box.width || !box.height) return null
    const vx = ((clientX - box.left) / box.width) * geo.w
    const vy = ((clientY - box.top) / box.height) * geo.h
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < geo.marks.length; i++) {
      const m = geo.marks[i]
      const dx = m.x - vx
      const dy = m.y - vy
      const d = dx * dx + dy * dy
      if (d < bestD) { bestD = d; best = i }
    }
    if (best < 0) return null
    const r = markRadius(geo.marks[best].count, { r: num(state.radius, 2.4), max: num(state.maxRadius, 8) })
    const limit = Math.max(14, r + 6)
    return bestD <= limit * limit ? best : null
  }

  function showTip(i) {
    const geo = state.geometry
    if (!geo || !geo.marks[i]) return
    tip.innerHTML = tipHtml(geo.marks[i])
    // NOT '' -- .chart-tip carries `display:none` in theme.css, so clearing the
    // inline value would leave the panel hidden (line.js/bar.js do exactly
    // that; see the report).
    tip.style.display = 'block'
    placeTip(geo.marks[i])
  }

  function onMove(e) {
    const i = markAt(e.clientX, e.clientY)
    if (i === state.hover) return
    state.hover = i
    if (i === null) {
      tip.style.display = 'none'
    } else {
      showTip(i)
    }
    const m = (i === null || !state.geometry) ? null : state.geometry.marks[i]
    state.onHover && state.onHover(m ? displayFor(m, i) : null, i)
    schedule()
  }

  function onLeave() {
    if (state.hover === null) return
    state.hover = null
    tip.style.display = 'none'
    state.onHover && state.onHover(null, null)
    schedule()
  }

  function onClick(e) {
    const i = markAt(e.clientX, e.clientY)
    // Click toggles a PIN on the current reading. Same mark again, empty space,
    // or Escape all clear it.
    state.selected = (i === null || state.selected === i) ? null : i
    const m = (state.selected === null || !state.geometry) ? null : state.geometry.marks[state.selected]
    state.onSelect && state.onSelect(m ? displayFor(m, state.selected) : null, state.selected)
    schedule()
  }

  function onKey(e) {
    if (e.key !== 'Escape' || state.selected === null) return
    state.selected = null
    state.onSelect && state.onSelect(null, null)
    schedule()
  }

  function schedule() {
    if (state.frame || state.destroyed) return
    state.frame = requestAnimationFrame(draw)
  }

  host.addEventListener('mousemove', onMove)
  host.addEventListener('mouseleave', onLeave)
  host.addEventListener('click', onClick)
  host.addEventListener('keydown', onKey)
  observer.observe(host)
  schedule()

  return {
    /** Replace the data and redraw. New data invalidates any pinned reading. */
    update(next = {}) {
      if ('points' in next) { state.selected = null; state.hover = null }
      Object.assign(state, next)
      schedule()
    },
    /** Programmatic selection (mirrors a click). Index is a mark index. */
    select(index) {
      state.selected = index
      schedule()
    },
    /** Current prepared data, for callers that need the same numbers. */
    data: prepare,
    destroy() {
      state.destroyed = true
      observer.disconnect()
      if (state.frame) cancelAnimationFrame(state.frame)
      host.removeEventListener('mousemove', onMove)
      host.removeEventListener('mouseleave', onLeave)
      host.removeEventListener('click', onClick)
      host.removeEventListener('keydown', onKey)
      host.innerHTML = ''
      state.geometry = null
    },
  }
}
