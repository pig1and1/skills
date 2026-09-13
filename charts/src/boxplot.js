/**
 * Box plot (Tukey), several groups compared side by side on one shared y axis.
 *
 * Everything numeric comes from core.js, which is unit-tested: quartiles and
 * the Tukey fences are `boxStats`, the axis is `linearScale` + `niceTicks`, the
 * slots are `bandScale`. This file only places those numbers into SVG, so it
 * stays thin enough to read in one pass.
 *
 * Behaviour that is deliberate rather than incidental:
 *
 *   - THE Y AXIS DOES NOT START AT ZERO BY DEFAULT. A box plot encodes position
 *     and spread, not magnitude: no element's area is proportional to a total,
 *     and every group is read against the same axis, so cutting the axis does
 *     not inflate the comparison the way a truncated bar chart does. Forcing
 *     zero onto latencies (200-900 ms) or scores (71-93) collapses every box
 *     into one flat line -- the argument the skill makes for line charts. Set
 *     `yFromZero: true` when the zero baseline is genuinely the message.
 *
 *   - A BOX BUILT FROM A HANDFUL OF POINTS IS A LIE. With 5 observations the
 *     quartiles are interpolated between one or two of them, so the box's width
 *     is sampling noise wearing the costume of a distribution -- and the 1.5 x
 *     IQR rule almost never fires that small, so the reader also concludes
 *     "no outliers". Below MIN_BOX_SIZE observations a group is drawn as its
 *     individual points instead, and the on-chart note says so.
 *
 *   - WHISKERS ARE TUKEY: the most extreme REAL data point inside 1.5 x IQR.
 *     Outliers are drawn separately, never folded into the whisker.
 *
 *   - NO TEXT INSIDE THE SVG. The plot fills its box with
 *     preserveAspectRatio="none"; any character drawn in there would be
 *     stretched non-uniformly. Group labels are an absolutely positioned HTML
 *     overlay instead.
 *
 *   - HOVER GIVES THE FULL READING (n, both whisker ends, Q1/median/Q3 and the
 *     outlier count with their range); CLICK ONLY PINS IT.
 */
import {
  isNum, num, linearScale, niceTicks, bandScale, plotArea,
  boxStats, formatNumber, esc, px,
} from './core.js'

const NS = 'http://www.w3.org/2000/svg'

/* Inline chrome, because the plot area itself is sized by the component. Text
   lives in these overlays and never in the SVG. Colours are tokens only. */
const XLAB_CSS = 'position:absolute;left:0;right:0;bottom:2px;height:20px;padding:0;margin:0;' +
  'display:block;pointer-events:none;font-size:11px;color:var(--chart-faint);text-align:center'
const NOTE_CSS = 'position:absolute;right:2px;top:0;max-width:100%;overflow:hidden;' +
  'text-overflow:ellipsis;white-space:nowrap;pointer-events:none;font-size:10.5px;color:var(--chart-faint)'

/**
 * Below this many usable observations, draw the points instead of a box.
 *
 * Twelve is where a sample starts to have roughly three observations per
 * quartile band, so Q1 and Q3 at least land between real, separated values
 * rather than on top of one another. It is a product decision, not a theorem:
 * the honest statement is "below this the box stops being a summary". Callers
 * who know their data can override it with `minBoxSize`.
 */
export const MIN_BOX_SIZE = 12

/** Six decimals: readable in an attribute, no floating point noise. */
function n6(v) {
  return Number(num(v, 0).toFixed(6))
}

/**
 * @param {HTMLElement} host
 * @param {object} options
 * @param {Array<{key?:any,label?:string,values:number[]}>} [options.groups]
 *        one entry per box, laid out side by side
 * @param {Array<Record<string, any>>} [options.rows]  alternative input shape
 * @param {(row:any)=>any} [options.group]  group key accessor, when using `rows`
 * @param {(row:any)=>number} [options.value] value accessor, when using `rows`
 * @param {number} [options.height=300]
 * @param {number} [options.minBoxSize=12]  below this, plot the points
 * @param {number} [options.iqrFactor=1.5]  Tukey fence multiplier
 * @param {boolean} [options.yFromZero=false]  true forces a zero baseline
 * @param {number} [options.minIqrPixels=10]
 *        if one extreme outlier would leave the interquartile range thinner
 *        than this, the axis is capped at the whiskers instead and the points
 *        left outside are counted and reported
 * @param {(v:number)=>string} [options.formatY]      axis ticks
 * @param {(v:number)=>string} [options.formatValue]  tooltip readings
 * @param {(group:object|null, index:number|null)=>void} [options.onHover]
 * @param {(group:object|null, index:number|null)=>void} [options.onSelect]
 * @param {(summary:object)=>void} [options.onRender]
 */
export function boxplotChart(host, options = {}) {
  if (!host) throw new Error('boxplotChart: host element is required')

  const state = { ...options, hover: null, selected: null, frame: 0, destroyed: false, geom: null }
  const pad = { top: 22, right: 20, bottom: 34, left: 56, ...(options.padding || {}) }
  const minBoxSize = Math.max(1, Math.floor(num(options.minBoxSize, MIN_BOX_SIZE)))

  // ---- static DOM scaffold: created once, never rebuilt -------------------
  host.classList.add('chart')
  host.style.position = 'relative'
  host.tabIndex = 0                       // so Escape / arrows can reach the chart
  host.innerHTML = ''
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('preserveAspectRatio', 'none')
  const tip = document.createElement('div')
  tip.className = 'chart-tip'
  const ylab = document.createElement('div')
  ylab.className = 'chart-ylab'
  const xlab = document.createElement('div')     // group names: HTML, not SVG
  xlab.className = 'chart-xlab'
  const note = document.createElement('div')     // thresholds, stated on screen
  note.className = 'chart-note'
  host.append(svg, ylab, xlab, note, tip)

  const observer = new ResizeObserver(() => schedule())
  const height = () => num(state.height, 300)

  const fmtY = (v) => (typeof state.formatY === 'function' ? state.formatY(v) : formatNumber(v, { compact: true }))
  // Tooltips carry the reading, so they must not be compacted: "1.2k" is not a
  // reading, it is a rounding.
  const fmtValue = (v) => (typeof state.formatValue === 'function' ? state.formatValue(v) : formatNumber(v))

  const catColor = (i) => `var(--chart-cat-${(i % 8) + 1})`

  /** Normalise the two accepted input shapes into `{ key, label, values }`. */
  function readGroups() {
    if (Array.isArray(state.groups)) {
      const groups = state.groups.map((g, i) => {
        if (Array.isArray(g)) return { key: i, label: String(i), values: g }
        const key = g && g.key !== undefined ? g.key : i
        const label = g && g.label !== undefined && g.label !== null ? g.label : key
        return { key, label: String(label), values: g ? g.values : [] }
      })
      return { groups, rejected: 0, reasons: {} }
    }

    const rows = Array.isArray(state.rows) ? state.rows : []
    const groupOf = typeof state.group === 'function' ? state.group : (r) => r && r.group
    const valueOf = typeof state.value === 'function' ? state.value : (r) => r && r.value
    const map = new Map()
    let rejected = 0
    const reasons = {}
    for (const row of rows) {
      let k
      try { k = groupOf(row) } catch { k = undefined }
      if (k === undefined || k === null) {
        // A row with no group cannot be placed anywhere. Dropping it silently
        // would make the chart look complete; it is counted instead.
        rejected += 1
        reasons.group = (reasons.group || 0) + 1
        continue
      }
      let v
      try { v = valueOf(row) } catch { v = undefined }
      const key = String(k)
      if (!map.has(key)) map.set(key, { key, label: key, values: [] })
      map.get(key).values.push(v)
    }
    return { groups: Array.from(map.values()), rejected, reasons }
  }

  /**
   * Pure: options -> per-group statistics. Quartiles, fences and outliers are
   * core's `boxStats`, so the numbers agree with every other consumer of core.
   */
  function prepare() {
    const read = readGroups()
    const all = []
    const reasons = { ...read.reasons }
    const boxes = read.groups.map((g, i) => {
      const raw = Array.isArray(g.values) ? g.values : []
      const values = raw.filter(isNum).slice().sort((a, b) => a - b)
      const dropped = raw.length - values.length
      if (dropped) reasons.value = (reasons.value || 0) + dropped
      for (const v of values) all.push(v)
      const stats = boxStats(values, { iqrFactor: num(state.iqrFactor, 1.5) })
      return {
        index: i,
        key: g.key,
        label: g.label,
        values,
        stats,
        rejected: dropped,
        mode: values.length === 0 ? 'empty' : (values.length < minBoxSize ? 'points' : 'box'),
      }
    })
    const rejected = read.rejected + boxes.reduce((s, b) => s + b.rejected, 0)
    return {
      boxes,
      values: all,
      rejected,
      reasons,
      minBoxSize,
      empty: all.length === 0,
    }
  }

  /**
   * The y domain. Three cases, and only the first is the common one:
   *   - normal: every group's whiskers and outliers fit, with a little air;
   *   - flat: every value identical, so the span is synthetic (never divide by 0);
   *   - strangled: one extreme outlier would leave the IQR a few pixels tall, so
   *     the axis is capped at the whiskers and the points left outside are
   *     counted and reported rather than silently drawn off-canvas.
   */
  function domainFor(boxes, all, plotH) {
    if (!all.length) return { domain: [0, 1], trimmed: 0, flat: false }

    let lo = all[0]
    let hi = all[0]
    for (const v of all) { if (v < lo) lo = v; if (v > hi) hi = v }

    if (state.yFromZero === true) {
      const top = hi > 0 ? hi * 1.06 : (hi < 0 ? 0 : 1)
      return { domain: [Math.min(0, lo), top], trimmed: 0, flat: false }
    }

    if (!(hi - lo > 1e-12)) {
      const span = Math.abs(lo) > 1e-9 ? Math.abs(lo) * 0.1 : 1
      return { domain: [lo - span, hi + span], trimmed: 0, flat: true }
    }

    const usable = boxes.filter((b) => !b.stats.empty)
    let wLo = usable[0].stats.min
    let wHi = usable[0].stats.max
    let q1 = usable[0].stats.q1
    let q3 = usable[0].stats.q3
    for (const b of usable) {
      if (b.stats.min < wLo) wLo = b.stats.min
      if (b.stats.max > wHi) wHi = b.stats.max
      if (b.stats.q1 < q1) q1 = b.stats.q1
      if (b.stats.q3 > q3) q3 = b.stats.q3
    }

    let dLo = lo
    let dHi = hi
    // Below roughly ten pixels the box has stopped being a box, so the axis is
    // capped at the whiskers instead. It is a pixel test rather than a ratio
    // test because a ratio does not say whether the box is readable on screen.
    const minIqrPx = num(state.minIqrPixels, 10)
    if (plotH > 0 && q3 - q1 > 1e-12 && ((q3 - q1) / (hi - lo)) * plotH < minIqrPx && wHi > wLo) {
      dLo = wLo
      dHi = wHi
    }
    const span = dHi - dLo
    const p = span * 0.08
    const domain = [dLo - p, dHi + p]
    const trimmed = all.filter((v) => v < domain[0] || v > domain[1]).length
    return { domain, trimmed, flat: false }
  }

  function draw() {
    state.frame = 0
    if (state.destroyed) return

    const prep = prepare()
    const boxes = prep.boxes
    const w = Math.max(1, host.clientWidth)
    const h = height()
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    host.style.height = `${h}px`

    if (prep.empty) {
      state.geom = null
      svg.innerHTML = ''
      ylab.innerHTML = ''
      xlab.innerHTML = ''
      tip.style.display = 'none'
      note.textContent = boxes.length ? '这些分组都没有可用的数值' : '没有数据'
      note.style.cssText = NOTE_CSS
      svg.setAttribute('aria-label', 'No data')
      state.onRender && state.onRender({ ...prep, domain: null, trimmed: 0, empty: true })
      return
    }

    const area = plotArea(w, h, pad)
    const dom = domainFor(boxes, prep.values, area.height)
    const [lo, hi] = dom.domain
    const ys = linearScale([lo, hi], [area.y + area.height, area.y])
    const bands = bandScale(boxes.length, [area.x, area.x + area.width], { padding: num(state.bandPadding, 0.45) })
    const boxW = Math.max(6, Math.min(bands.band * num(state.boxWidth, 0.62), num(state.maxBoxWidth, 72)))
    const ticks = niceTicks(lo, hi, 4)

    // Data changes can strand a selection or a hover past the new group list.
    if (state.selected !== null && state.selected >= boxes.length) state.selected = null
    if (state.hover !== null && state.hover >= boxes.length) state.hover = null

    state.geom = { boxes, bands, boxW, area, width: w, height: h, domain: [lo, hi] }

    let out = ''

    for (const t of ticks) {
      const y = px(ys.scale(t))
      out += `<line x1="${area.x}" y1="${y}" x2="${px(area.x + area.width)}" y2="${y}" ` +
        `stroke="${t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}" stroke-width="1"/>`
    }

    // Hover feedback is the band the group owns -- a box plot's unit of data is
    // the slot, so the column idiom is the right one here (a line chart would
    // need a thin guide instead). Selection keeps a warmer, persistent fill.
    const mark = state.selected !== null ? state.selected : state.hover
    if (mark !== null && boxes[mark]) {
      out += `<rect x="${px(bands.left(mark) - bands.width * 0.06)}" y="${area.y}" ` +
        `width="${px(bands.band + bands.width * 0.12)}" height="${px(area.height)}" rx="7" ` +
        `fill="${state.selected !== null ? 'var(--chart-selected)' : 'var(--chart-hover)'}"/>`
    }

    boxes.forEach((b, i) => {
      const s = b.stats
      const cx = bands.center(i)
      const x0 = cx - boxW / 2
      const color = catColor(i)
      let inner = ''

      if (!s.empty && b.mode === 'points') {
        // Too few observations for quartiles to mean anything: show every one
        // of them. They sit on one vertical line -- spreading them sideways
        // would invent a second dimension the data does not have.
        for (const v of b.values) {
          inner += `<circle cx="${px(cx)}" cy="${px(ys.scale(v))}" r="3" fill="${color}" ` +
            `stroke="var(--chart-surface)" stroke-width="1.2"/>`
        }
      } else if (!s.empty) {
        const yq1 = ys.scale(s.q1)
        const yq3 = ys.scale(s.q3)
        const ymed = ys.scale(s.median)
        const ylo = ys.scale(s.min)
        const yhi = ys.scale(s.max)
        const cap = boxW * 0.3

        if (yq3 - yhi > 0.5) {
          inner += `<line x1="${px(cx)}" y1="${px(yq3)}" x2="${px(cx)}" y2="${px(yhi)}" ` +
            `stroke="var(--chart-muted)" stroke-width="1.4"/>`
          inner += `<line x1="${px(cx - cap)}" y1="${px(yhi)}" x2="${px(cx + cap)}" y2="${px(yhi)}" ` +
            `stroke="var(--chart-muted)" stroke-width="1.4"/>`
        }
        if (ylo - yq1 > 0.5) {
          inner += `<line x1="${px(cx)}" y1="${px(yq1)}" x2="${px(cx)}" y2="${px(ylo)}" ` +
            `stroke="var(--chart-muted)" stroke-width="1.4"/>`
          inner += `<line x1="${px(cx - cap)}" y1="${px(ylo)}" x2="${px(cx + cap)}" y2="${px(ylo)}" ` +
            `stroke="var(--chart-muted)" stroke-width="1.4"/>`
        }

        // A zero-height box is correct for constant data (there is no spread),
        // so it is not padded into existence -- the median line still shows.
        const top = Math.min(yq1, yq3)
        const bh = Math.abs(yq1 - yq3)
        if (bh >= 1) {
          inner += `<rect x="${px(x0)}" y="${px(top)}" width="${px(boxW)}" height="${px(bh)}" rx="2" ` +
            `fill="${color}" fill-opacity="0.55" stroke="${color}" stroke-width="1.2"/>`
        }
        inner += `<line x1="${px(x0)}" y1="${px(ymed)}" x2="${px(x0 + boxW)}" y2="${px(ymed)}" ` +
          `stroke="var(--chart-ink)" stroke-width="2.2"/>`

        for (const v of s.outliers) {
          const y = ys.scale(v)
          // A point the axis deliberately does not cover is reported in the
          // note; drawing it off-canvas would neither show nor explain it.
          if (y < area.y - 0.5 || y > area.y + area.height + 0.5) continue
          inner += `<circle cx="${px(cx)}" cy="${px(y)}" r="2.8" fill="var(--chart-muted)"/>`
        }
      }

      const attrs = [
        `data-group="${i}"`,
        `data-key="${esc(b.key)}"`,
        `data-mode="${b.mode}"`,
        `data-n="${s.count || 0}"`,
      ]
      if (!s.empty) {
        attrs.push(
          `data-lo="${n6(s.min)}"`,
          `data-q1="${n6(s.q1)}"`,
          `data-median="${n6(s.median)}"`,
          `data-q3="${n6(s.q3)}"`,
          `data-hi="${n6(s.max)}"`,
          `data-outliers="${s.outliers.length}"`,
        )
        if (s.iqr <= 1e-12) attrs.push('data-flat="1"')
      }
      out += `<g ${attrs.join(' ')}>${inner}</g>`
    })

    // One hit target per slot, so hovering anywhere in the column works -- the
    // boxes themselves are narrow and the outliers are 3px wide.
    boxes.forEach((b, i) => {
      out += `<rect data-band="${i}" x="${px(bands.left(i))}" y="${area.y}" ` +
        `width="${px(bands.width)}" height="${area.height}" fill="transparent"/>`
    })
    svg.innerHTML = out

    ylab.innerHTML = ticks.map((t) => (
      `<span style="top:${((ys.scale(t) / h) * 100).toFixed(3)}%">${esc(fmtY(t))}</span>`
    )).join('')
    ylab.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${pad.left}px;pointer-events:none`

    const labelW = Math.max(24, Math.min(bands.width * 0.98, 140))
    xlab.innerHTML = boxes.map((b, i) => {
      const left = ((bands.center(i) / w) * 100).toFixed(3)
      return `<span data-x="${i}" title="${esc(b.label)}" ` +
        `style="position:absolute;left:${left}%;transform:translateX(-50%);max-width:${px(labelW)}px;` +
        `overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.label)}</span>`
    }).join('')
    xlab.style.cssText = XLAB_CSS

    const notes = []
    const small = boxes.filter((b) => b.mode === 'points')
    if (small.length) notes.push(`n < ${minBoxSize} 的分组列出全部数据点`)
    if (prep.rejected) notes.push(`已忽略 ${prep.rejected} 个非数值`)
    if (dom.trimmed) notes.push(`${dom.trimmed} 个点超出显示范围`)
    note.textContent = notes.join(' · ')
    note.style.cssText = NOTE_CSS

    svg.setAttribute('aria-label', ariaFor(boxes, prep, dom))
    // The panel has to be re-derived after a redraw too: a resize moves the band
    // a pin sits on, and shrinking the data can strand a pin entirely.
    applyTip()
    state.onRender && state.onRender({ ...prep, domain: [lo, hi], trimmed: dom.trimmed, flat: dom.flat, empty: false })
  }

  function ariaFor(boxes, prep, dom) {
    if (!boxes.length) return 'No data'
    const parts = [`箱线图，${boxes.length} 组`]
    const usable = boxes.filter((b) => !b.stats.empty)
    if (usable.length) {
      const top = usable.reduce((a, b) => (b.stats.median > a.stats.median ? b : a), usable[0])
      parts.push(`${usable.length} 组有可用数值`)
      parts.push(`中位数最高的是「${top.label}」，${formatNumber(top.stats.median)}`)
    }
    const small = boxes.filter((b) => b.mode === 'points')
    if (small.length) parts.push(`${small.length} 组样本少于 ${prep.minBoxSize}，已改为显示全部数据点`)
    if (prep.rejected) parts.push(`已忽略 ${prep.rejected} 个非数值`)
    if (dom.trimmed) parts.push(`${dom.trimmed} 个点超出显示范围未画出`)
    return parts.join('；')
  }

  function schedule() {
    if (state.frame || state.destroyed) return
    state.frame = requestAnimationFrame(draw)
  }

  function bandAt(clientX) {
    const g = state.geom
    if (!g || !g.boxes.length) return null
    const box = svg.getBoundingClientRect()
    if (!box.width) return null
    const vx = ((clientX - box.left) / box.width) * g.width
    const i = Math.floor((vx - g.area.x) / g.bands.width)
    return (i < 0 || i >= g.boxes.length) ? null : i
  }

  function tipHtml(b) {
    const title = `<div class="chart-tip-title">${esc(b.label)}</div>`
    if (b.stats.empty) return `${title}<div class="chart-tip-row"><i></i>无可用数值<b>0</b></div>`
    const s = b.stats
    const color = catColor(b.index)
    const row = (name, value, dot = false) => `<div class="chart-tip-row"><i${dot ? ` style="background:${esc(color)}"` : ''}></i>` +
      `${esc(name)}<b>${esc(value)}</b></div>`

    let html = title
    html += row('n', String(s.count))
    html += row('上须（1.5×IQR 内最远点）', fmtValue(s.max))
    html += row('Q3', fmtValue(s.q3))
    html += row('中位数', fmtValue(s.median), true)
    html += row('Q1', fmtValue(s.q1))
    html += row('下须（1.5×IQR 内最远点）', fmtValue(s.min))
    if (s.outliers.length) {
      let oLo = s.outliers[0]
      let oHi = s.outliers[0]
      for (const v of s.outliers) { if (v < oLo) oLo = v; if (v > oHi) oHi = v }
      html += row(`离群点 ${s.outliers.length} 个`, oLo === oHi ? fmtValue(oLo) : `${fmtValue(oLo)} – ${fmtValue(oHi)}`)
    } else {
      html += row('离群点', '无')
    }
    if (s.iqr <= 1e-12) html += row('四分位距', '0（多数取值相同）')
    if (b.mode === 'points') html += row('提示', `n < ${minBoxSize}：箱体不可靠，已列出全部点`)
    return html
  }

  /**
   * Show the panel for whatever is being pointed at -- unless something is
   * pinned, in which case the pinned reading wins and stays put when the mouse
   * leaves. The two states are deliberately different: hover answers "what am I
   * pointing at", the pin answers "what did I ask to keep". Releasing a pin
   * therefore falls back to whatever is under the pointer, not to nothing.
   */
  function applyTip() {
    const g = state.geom
    const i = state.selected !== null ? state.selected : state.hover
    if (i === null || !g || !g.boxes[i]) {
      tip.style.display = 'none'
      return
    }
    tip.innerHTML = tipHtml(g.boxes[i])
    // NOT `''`. theme.css sets `.chart-tip { display: none }`, so an empty
    // inline value just clears the override and the element falls back to
    // `none` -- the panel would never appear at all. A screenshot of a static
    // chart cannot reveal this, which is why the tests below assert the exact
    // inline value rather than "not none".
    tip.style.display = 'block'

    const box = svg.getBoundingClientRect()
    if (!box.width) return
    const at = (g.bands.center(i) / g.width) * box.width
    const tw = num(tip.offsetWidth, 0)
    // Flip to the other side near the right edge rather than running off it.
    const left = at > box.width * 0.62 ? at - tw - 14 : at + 14
    tip.style.left = `${Math.max(8, Math.min(Math.max(8, box.width - tw - 8), left))}px`
    tip.style.top = '4px'
  }

  host.addEventListener('mousemove', (e) => {
    const i = bandAt(e.clientX)
    if (i === state.hover) return
    state.hover = i
    applyTip()
    const g = state.geom
    state.onHover && state.onHover(i === null || !g ? null : g.boxes[i], i)
    schedule()
  })

  host.addEventListener('mouseleave', () => {
    if (state.hover === null) return
    state.hover = null
    applyTip()                       // a pinned reading stays; an unpinned one goes
    state.onHover && state.onHover(null, null)
    schedule()
  })

  host.addEventListener('click', (e) => {
    // Clicking the same group again, or the empty space beside the boxes,
    // clears the pin. Without both, a pin becomes a trap.
    const i = bandAt(e.clientX)
    state.selected = (i === null || state.selected === i) ? null : i
    applyTip()
    const g = state.geom
    const b = state.selected === null || !g ? null : g.boxes[state.selected]
    state.onSelect && state.onSelect(b, state.selected)
    schedule()
  })

  host.addEventListener('keydown', (e) => {
    const g = state.geom
    if (!g || !g.boxes.length) return
    const n = g.boxes.length
    const cur = state.selected
    let next
    if (e.key === 'Escape') next = null
    else if (e.key === 'Enter' || e.key === ' ') next = cur === null ? 0 : null
    else if (e.key === 'ArrowRight') next = cur === null ? 0 : Math.min(n - 1, cur + 1)
    else if (e.key === 'ArrowLeft') next = cur === null ? n - 1 : Math.max(0, cur - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    else return
    if (e.preventDefault) e.preventDefault()
    state.selected = next
    applyTip()
    state.onSelect && state.onSelect(next === null ? null : g.boxes[next], next)
    schedule()
  })

  observer.observe(host)
  schedule()

  return {
    /** Replace the data (or any option) and redraw. */
    update(next = {}) {
      Object.assign(state, next)
      schedule()
    },
    /** Programmatic pin, mirroring a click. `null` clears it. */
    select(index) {
      state.selected = index === undefined ? null : index
      applyTip()
      schedule()
    },
    /** Current per-group statistics, for callers that need the same numbers. */
    data: prepare,
    destroy() {
      state.destroyed = true
      state.geom = null
      observer.disconnect()
      if (state.frame) cancelAnimationFrame(state.frame)
      host.innerHTML = ''
    },
  }
}
