/**
 * Bar and stacked-bar chart, optionally with a same-unit average line.
 *
 * The rule this file exists to enforce: A BAR'S AREA ENCODES MAGNITUDE, so the
 * y axis starts at zero. A line may share that axis only if it measures the same
 * unit. Passing `line` means "same unit" -- there is deliberately no second-axis
 * option, because a second axis invents a correlation that is not in the data.
 * If your line is a different unit, use two stacked charts instead.
 *
 * Everything numeric is computed by core.js (unit-tested); this file places it.
 */
import {
  num, zeroBasedDomain, niceTicks, bandScale, plotArea,
  sanitize, stack, formatNumber, formatDate,
  esc, px, barSegmentPath, linePath,
} from './core.js'
const NS = 'http://www.w3.org/2000/svg'

/**
 * @param {HTMLElement} host
 * @param {object} options
 * @param {Array<Record<string, any>>} options.rows
 * @param {Array<{key:string,label:string,color?:string}>} options.series
 * @param {(row:any)=>number|string} [options.x]           x value (time or label)
 * @param {number} [options.height=300]
 * @param {{read:(row:any)=>number,label?:string}} [options.line]
 *        A SAME-UNIT average line drawn on the shared axis.
 * @param {boolean} [options.showValues=false]             print totals above bars
 * @param {(row:any, index:number|null)=>void} [options.onHover]
 * @param {(row:any, index:number|null)=>void} [options.onSelect]
 */
export function barChart(host, options = {}) {
  if (!host) throw new Error('barChart: host element is required')

  const state = { ...options, hover: null, selected: null, frame: 0, destroyed: false }
  const pad = { top: 26, right: 70, bottom: 32, left: 56, ...(options.padding || {}) }

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
  const xlab = document.createElement('div')
  xlab.className = 'chart-xlab'
  xlab.setAttribute('aria-hidden', 'true')   // the svg already carries the a11y summary
  const endLabel = document.createElement('span')
  endLabel.className = 'chart-endlabel'
  host.append(svg, ylab, xlab, tip, endLabel)

  const observer = new ResizeObserver(() => schedule())
  const height = () => num(state.height, 300)

  // Declared before draw() uses it. A `const` arrow declared after the first
  // call site sits in the temporal dead zone and throws at runtime.
  const fmtX = (v) => (state.formatX
    ? state.formatX(v)
    : (typeof v === 'number' ? formatDate(v) : String(v ?? '')))

  /** Pure: rows -> stacked columns plus optional line values, after hygiene. */
  function prepare() {
    const rows = Array.isArray(state.rows) ? state.rows : []
    const keys = (state.series || []).map((s) => s.key)
    const fields = {}
    for (const k of keys) fields[k] = (row) => row && row[k]
    const clean = sanitize(rows, fields)

    const stacked = stack(clean.rows, keys, (v) => num(v, 0))
    const readLine = state.line && typeof state.line.read === 'function' ? state.line.read : null
    const columns = stacked.map((col, i) => ({
      index: i,
      row: col.row,
      x: state.x ? state.x(col.row) : i,
      segments: col.segments,
      total: col.total,
      lineValue: readLine ? readLine(col.row) : null,
    }))
    return { columns, rejected: clean.rejected, reasons: clean.reasons, series: state.series || [] }
  }

  function draw() {
    state.frame = 0
    if (state.destroyed) return

    const prep = prepare()
    const cols = prep.columns
    const w = Math.max(1, host.clientWidth)
    const h = height()
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    host.style.height = `${h}px`

    if (!cols.length) {
      svg.innerHTML = ''; ylab.innerHTML = ''; xlab.innerHTML = ''; endLabel.style.display = 'none'; tip.style.display = 'none'
      svg.setAttribute('aria-label', 'No data')
      state.onRender && state.onRender({ ...prep, empty: true })
      return
    }

    // Zero-based: bars encode magnitude by area.
    const candidates = cols.map((c) => c.total)
    const lineVals = cols.map((c) => c.lineValue).filter((v) => typeof v === 'number' && Number.isFinite(v))
    const [lo, hi] = zeroBasedDomain(candidates.concat(lineVals), 1.12)

    const area = plotArea(w, h, pad)
    const bands = bandScale(cols.length, [area.x, area.x + area.width], { padding: 0.42 })
    const ys = (v) => area.y + area.height - ((num(v, lo) - lo) / (hi - lo)) * area.height
    const ticks = niceTicks(lo, hi, 4)
    const fmtY = state.formatY || ((v) => formatNumber(v, { compact: true }))

    const radius = num(state.barRadius, 5)
    let out = ''

    for (const t of ticks) {
      const y = px(ys(t))
      out += `<line x1="${area.x}" y1="${y}" x2="${px(area.x + area.width)}" y2="${y}" ` +
        `stroke="${t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}" stroke-width="1"/>`
    }

    const mark = state.selected !== null ? state.selected : state.hover
    if (mark !== null && cols[mark]) {
      out += `<rect x="${px(bands.left(mark) - bands.width * 0.16)}" y="${px(area.y - 8)}" ` +
        `width="${px(bands.band + bands.width * 0.32)}" height="${px(area.height + 12)}" rx="7" ` +
        `fill="${state.selected !== null ? 'var(--chart-selected)' : 'var(--chart-hover)'}"/>`
    }

    cols.forEach((col, ci) => {
      const x = bands.left(ci)
      const bw = bands.band
      col.segments.forEach((seg, si) => {
        const y0 = ys(seg.from)
        const y1 = ys(seg.to)
        const isTop = si === col.segments.length - 1
        const d = barSegmentPath(x, y1, bw, y0 - y1, radius, isTop)
        if (d) {
          const s = prep.series.find((k) => k.key === seg.key)
          out += `<path d="${d}" fill="${esc(s && s.color ? s.color : `var(--chart-cat-${(si % 8) + 1})`)}"/>`
        }
      })
    })

    // Same-unit average line, drawn on the shared axis at each band centre.
    if (state.line && lineVals.length) {
      const pts = cols
        .map((c, i) => ({ x: bands.center(i), y: ys(c.lineValue), v: c.lineValue }))
        .filter((p) => Number.isFinite(p.y))
      if (pts.length > 1) {
        out += `<path d="${linePath(pts)}" fill="none" stroke="var(--chart-accent)" stroke-width="2" ` +
          `stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
      }
      pts.forEach((p, i) => {
        const sel = state.selected === i
        out += `<circle cx="${px(p.x)}" cy="${px(p.y)}" r="${sel ? 4.6 : 3.2}" fill="var(--chart-accent)" ` +
          `stroke="var(--chart-surface)" stroke-width="${sel ? 2.4 : 1.6}"/>`
      })
      const lastPt = pts[pts.length - 1]
      endLabel.style.display = ''
      endLabel.textContent = `${state.line.label || 'avg'} ${fmtY(lastPt.v)}`
      endLabel.style.top = `${((lastPt.y / h) * 100).toFixed(2)}%`
    } else {
      endLabel.style.display = 'none'
    }

    // One hit target per band, taller than the bar so short bars are still easy.
    cols.forEach((col, ci) => {
      out += `<rect data-band="${ci}" x="${px(bands.left(ci) - bands.width * 0.1)}" y="${area.y}" ` +
        `width="${px(bands.band + bands.width * 0.2)}" height="${area.height}" fill="transparent"/>`
    })
    svg.innerHTML = out

    ylab.innerHTML = ticks.map((t) => (
      `<span style="top:${((ys(t) / h) * 100).toFixed(3)}%">${esc(fmtY(t))}</span>`
    )).join('')
    ylab.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${pad.left}px;pointer-events:none`

    // X axis. Bars sit in bands, so a label belongs at each band centre -- but
    // only every Nth one: on a narrow container, 30 bars with 30 dates is a
    // smear. The last column always keeps its label so the range stays legible.
    const room = Math.max(2, Math.floor(area.width / 64))
    const every = Math.max(1, Math.ceil(cols.length / room))
    xlab.innerHTML = cols.map((col, ci) => {
      if (ci % every !== 0 && ci !== cols.length - 1) return ''
      const pct = Math.max(0.5, Math.min(99.5, (bands.center(ci) / w) * 100))
      const raw = fmtX(col.x)
      // Full ISO days are too wide under a bar; MM-DD carries the same meaning.
      const label = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.slice(5) : raw
      return `<span style="position:absolute;left:${pct.toFixed(3)}%;transform:translateX(-50%);` +
        `white-space:nowrap">${esc(label)}</span>`
    }).join('')
    xlab.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:18px;display:block;' +
      'padding-left:0;margin-top:0;pointer-events:none'

    svg.setAttribute('aria-label', ariaFor(prep))
    state.onRender && state.onRender({ ...prep, domain: [lo, hi], empty: false })
  }

  function ariaFor(prep) {
    const cols = prep.columns
    if (!cols.length) return 'No data'
    const peak = cols.reduce((a, b) => (b.total > a.total ? b : a), cols[0])
    return `Stacked bar chart, ${cols.length} columns, peak ${formatNumber(peak.total)} at position ${peak.index + 1}` +
      (state.line ? `, with a same-unit ${state.line.label || 'average'} line` : '')
  }

  function schedule() {
    if (state.frame || state.destroyed) return
    state.frame = requestAnimationFrame(draw)
  }

  function bandAt(clientX) {
    const cols = prepare().columns
    if (!cols.length) return null
    const box = svg.getBoundingClientRect()
    if (!box.width) return null
    const area = plotArea(host.clientWidth, height(), pad)
    const vx = ((clientX - box.left) / box.width) * host.clientWidth
    const bands = bandScale(cols.length, [area.x, area.x + area.width], { padding: 0.42 })
    const i = Math.floor((vx - area.x) / bands.width)
    return (i < 0 || i >= cols.length) ? null : i
  }

  function tipHtml(col) {
    const rows = col.segments
      .filter((s) => s.value > 0)
      .map((s) => {
        const meta = (state.series || []).find((k) => k.key === s.key)
        const color = meta && meta.color ? meta.color : `var(--chart-cat-${(col.segments.indexOf(s) % 8) + 1})`
        return `<div class="chart-tip-row"><i style="background:${esc(color)}"></i>` +
          `${esc(meta ? meta.label : s.key)}<b>${esc(formatNumber(s.value))}</b></div>`
      }).join('')
    const total = `<div class="chart-tip-row"><i></i>合计<b>${esc(formatNumber(col.total))}</b></div>`
    const line = col.lineValue !== null && Number.isFinite(col.lineValue)
      ? `<div class="chart-tip-row"><i style="background:var(--chart-accent)"></i>${esc((state.line && state.line.label) || '平均')}<b>${esc(formatNumber(col.lineValue))}</b></div>`
      : ''
    return `<div class="chart-tip-title">${esc(fmtX(col.x))}</div>${rows}${line}${total}`
  }

  host.addEventListener('mousemove', (e) => {
    const i = bandAt(e.clientX)
    if (i === state.hover) return
    state.hover = i
    if (i === null) {
      tip.style.display = 'none'
    } else {
      const col = prepare().columns[i]
      tip.innerHTML = tipHtml(col)
      // 'block', not '': .chart-tip carries `display:none` in theme.css, so
      // clearing the inline value falls back to none and the tip never appears.
      tip.style.display = 'block'
      const box = svg.getBoundingClientRect()
      const area = plotArea(host.clientWidth, height(), pad)
      const bands = bandScale(prepare().columns.length, [area.x, area.x + area.width], { padding: 0.42 })
      const left = (bands.center(i) / host.clientWidth) * box.width
      tip.style.left = `${Math.max(8, Math.min(box.width - tip.offsetWidth - 8, left + 14))}px`
      tip.style.top = '4px'
    }
    const col = i === null ? null : prepare().columns[i]
    state.onHover && state.onHover(col ? col.row : null, i)
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
    const i = bandAt(e.clientX)
    state.selected = (i === null || state.selected === i) ? null : i
    const cols = prepare().columns
    state.onSelect && state.onSelect(state.selected === null ? null : cols[state.selected].row, state.selected)
    schedule()
  })

  observer.observe(host)
  schedule()

  return {
    update(next = {}) { Object.assign(state, next); schedule() },
    select(index) { state.selected = index; schedule() },
    data: prepare,
    destroy() {
      state.destroyed = true
      observer.disconnect()
      if (state.frame) cancelAnimationFrame(state.frame)
      host.innerHTML = ''
    },
  }
}
