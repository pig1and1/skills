/**
 * Line / area chart.
 *
 * Everything computed here comes from core.js, which is unit-tested. This file
 * only places numbers into SVG, so it stays thin enough to read in one pass.
 *
 * Behaviour that is deliberate rather than incidental:
 *   - Gaps BREAK the line. A continuous line asserts "it was like this the whole
 *     time"; across a gap there was no measurement, so drawing through it states
 *     something false.
 *   - The y domain fits the data by default, because a line encodes position,
 *     not magnitude. Bars are the opposite -- see bar.js.
 *   - Labels live in HTML overlays, never inside the SVG, so that non-uniform
 *     scaling (which is how the plot fills a responsive box) cannot distort text.
 */
import {
  isNum, num, linearScale, niceTicks, formatNumber, formatDate, plotArea,
  prepareSeries, gapIndices, splitAt,
  esc, px, linePath, areaPath,
} from './core.js'

const NS = 'http://www.w3.org/2000/svg'

/**
 * @param {HTMLElement} host
 * @param {object} options
 * @param {Array<{t:number, value:number}>} options.points
 * @param {number} [options.height=260]
 * @param {number} [options.padding]
 * @param {boolean} [options.showArea=false]
 * @param {boolean} [options.showPoints=true]
 * @param {boolean} [options.showEndLabel=true]   label the last point directly
 * @param {boolean} [options.connectGaps=false]   true draws through gaps (not advised)
 * @param {boolean} [options.yFromZero=false]
 * @param {number}  [options.maxPoints=700]       downsample above this
 * @param {(t:number)=>string} [options.formatX]
 * @param {(v:number)=>string} [options.formatY]
 * @param {string}  [options.label]               series name, for the a11y summary
 * @param {(point:object|null, index:number|null)=>void} [options.onHover]
 * @param {(point:object|null, index:number|null)=>void} [options.onSelect]
 */
export function lineChart(host, options = {}) {
  if (!host) throw new Error('lineChart: host element is required')

  const state = {
    ...options,
    selected: null,
    hover: null,
    frame: 0,
    destroyed: false,
  }

  const pad = {
    top: 18, right: 64, bottom: 30, left: 56,
    ...(options.padding || {}),
  }

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
  const endLabel = document.createElement('span')
  endLabel.className = 'chart-endlabel'
  host.append(svg, ylab, tip, endLabel)

  const observer = new ResizeObserver(() => schedule())

  function height() {
    return num(state.height, 260)
  }

  /**
   * Pure: rows -> plot-ready points. Delegates to core's pipeline, which is the
   * part that must be testable -- it used to live here in a closure and had no
   * coverage at all.
   */
  function prepare() {
    return prepareSeries(state.points, {
      maxPoints: num(state.maxPoints, 700),
      zeroBased: state.yFromZero === true,
      robust: state.yFromZero !== true,
      floor: state.clampAtZero === true ? (v) => Math.max(0, v) : undefined,
    })
  }

  function draw() {
    state.frame = 0
    if (state.destroyed) return

    const prep = prepare()
    const pts = prep.points
    const w = Math.max(1, host.clientWidth)
    const h = height()
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
    host.style.height = `${h}px`

    if (!pts.length) {
      svg.innerHTML = ''
      ylab.innerHTML = ''
      endLabel.style.display = 'none'
      tip.style.display = 'none'
      svg.setAttribute('aria-label', 'No data')
      state.onRender && state.onRender({ ...prep, empty: true })
      return
    }

    // The domain comes from the pipeline, so exactly one place decides
    // fitted-vs-zero-based, and one place guards against degeneracy.
    const [lo, hi] = prep.domain
    const trimmed = prep.trimmed

    const area = plotArea(w, h, pad)
    const xs = linearScale([pts[0].t, pts[pts.length - 1].t], [area.x, area.x + area.width])
    const ys = linearScale([lo, hi], [area.y + area.height, area.y])

    const ticks = niceTicks(lo, hi, 4)
    const fmtY = state.formatY || ((v) => formatNumber(v, { compact: true }))
    const fmtX = state.formatX || ((t) => formatDate(t))

    // ---- geometry
    const screen = pts.map((p) => ({ x: xs.scale(p.t), y: ys.scale(p.value), src: p }))
    const timeCuts = state.connectGaps ? [] : gapIndices(pts.map((p) => p.t))
    const segments = splitAt(screen, timeCuts)
    const cuts = []
    { let acc = 0; for (const seg of segments) { acc += seg.length; cuts.push(acc) } cuts.pop() }

    const color = 'var(--chart-accent)'
    let out = ''

    // grid: three lines, faintest tone, zero baseline slightly stronger
    for (const t of ticks) {
      const y = px(ys.scale(t))
      out += `<line x1="${area.x}" y1="${y}" x2="${px(area.x + area.width)}" y2="${y}" ` +
        `stroke="${t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}" stroke-width="1"/>`
    }

    // selection / hover band sits under the data
    const mark = state.selected !== null ? state.selected : state.hover
    if (mark !== null && screen[mark]) {
      const x = screen[mark].x
      out += `<rect x="${px(x - 9)}" y="${area.y}" width="18" height="${area.height}" rx="5" ` +
        `fill="${state.selected !== null ? 'var(--chart-selected)' : 'var(--chart-hover)'}"/>`
    }

    // area + line, per segment so gaps stay gaps
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (state.showArea && seg.length > 1) {
        out += `<path d="${areaPath(seg, area.y + area.height)}" fill="${color}" opacity="0.10"/>`
      }
      if (seg.length > 1) {
        out += `<path d="${linePath(seg)}" fill="none" stroke="${color}" stroke-width="1.9" ` +
          `stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
      }
    }
    // A lone point still gets a mark, so a single-sample series is visible.
    if (state.showPoints !== false) {
      for (const s of screen) {
        const isMark = state.selected === screen.indexOf(s)
        out += `<circle cx="${px(s.x)}" cy="${px(s.y)}" r="${isMark ? 4.6 : 2.9}" fill="${color}" ` +
          `stroke="var(--chart-surface)" stroke-width="${isMark ? 2.4 : 1.4}"/>`
      }
    }

    // hit layer: the whole plot, so hovering anywhere gives a reading
    out += `<rect x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}" fill="transparent" data-hit="1"/>`
    svg.innerHTML = out

    ylab.innerHTML = ticks.map((t) => {
      const y = ys.scale(t)
      return `<span style="top:${((y / h) * 100).toFixed(3)}%">${esc(fmtY(t))}</span>`
    }).join('')
    ylab.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${pad.left}px;pointer-events:none`

    const first = pts[0], last = pts[pts.length - 1]
    const granularity = last.t - first.t > 300 * 864e5 ? 'month' : 'day'
    host.dataset.xstart = fmtX(first.t)
    host.dataset.xend = fmtX(last.t)
    host.dataset.granularity = granularity

    endLabel.style.display = state.showEndLabel === false ? 'none' : ''
    endLabel.textContent = fmtY(last.value)
    endLabel.style.top = `${((ys.scale(last.value) / h) * 100).toFixed(2)}%`

    svg.setAttribute('aria-label', ariaFor(pts, prep, state.label))
    state.onRender && state.onRender({ ...prep, domain: [lo, hi], trimmed, empty: false })
  }

  function ariaFor(pts, prep, label) {
    const vs = pts.map((p) => p.value)
    const parts = [
      label ? `${label}: ` : '',
      `${pts.length} points`,
      `from ${formatNumber(Math.min(...vs))} to ${formatNumber(Math.max(...vs))}`,
    ]
    if (prep.sampled) parts.push(`downsampled from ${prep.rejected + pts.length}`)
    return parts.join(', ')
  }

  function schedule() {
    if (state.frame || state.destroyed) return
    state.frame = requestAnimationFrame(draw)
  }

  function indexAt(clientX) {
    const box = svg.getBoundingClientRect()
    if (!box.width) return null
    const w = host.clientWidth
    const area = plotArea(w, height(), pad)
    const vx = ((clientX - box.left) / box.width) * w
    const prep = prepare()
    if (!prep.points.length) return null
    const pts = prep.points
    const xs = linearScale([pts[0].t, pts[pts.length - 1].t], [area.x, area.x + area.width])
    const frac = (vx - area.x) / area.width
    if (frac < -0.02 || frac > 1.02) return null
    return Math.max(0, Math.min(pts.length - 1, Math.round(frac * (pts.length - 1))))
  }

  host.addEventListener('mousemove', (e) => {
    const i = indexAt(e.clientX)
    if (i === state.hover) return
    state.hover = i
    const prep = prepare()
    const p = i === null ? null : prep.points[i]
    if (p) {
      const area = plotArea(host.clientWidth, height(), pad)
      const pts = prep.points
      const xs = linearScale([pts[0].t, pts[pts.length - 1].t], [area.x, area.x + area.width])
      const box = svg.getBoundingClientRect()

      tip.innerHTML = `<b>${esc(formatDate(p.t))}</b>　${esc((state.formatY || formatNumber)(p.value))}`
      tip.style.display = ''
      const left = (xs.scale(p.t) / host.clientWidth) * box.width
      tip.style.left = `${Math.max(8, Math.min(box.width - tip.offsetWidth - 8, left + 14))}px`
      tip.style.top = '4px'
    } else {
      tip.style.display = 'none'
    }
    state.onHover && state.onHover(p, i)
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
    const i = indexAt(e.clientX)
    state.selected = (i === null || state.selected === i) ? null : i
    const prep = prepare()
    const p = i === null ? null : prep.points[state.selected ?? i]
    state.onSelect && state.onSelect(p, state.selected)
    schedule()
  })

  observer.observe(host)
  schedule()

  return {
    /** Replace the data and redraw. */
    update(next = {}) {
      Object.assign(state, next)
      schedule()
    },
    /** Programmatic selection (mirrors a click). */
    select(index) {
      state.selected = index
      schedule()
    },
    /** Current prepared series, for callers that need the same numbers. */
    data: prepare,
    destroy() {
      state.destroyed = true
      observer.disconnect()
      if (state.frame) cancelAnimationFrame(state.frame)
      host.innerHTML = ''
    },
  }
}
