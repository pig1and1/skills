/**
 * Heatmap (matrix) chart.
 *
 * Same contract as line.js / bar.js:
 *   heatmapChart(el, options) -> { update, select, data, destroy }
 * and the same division of labour: every number comes from core.js, which is
 * unit tested; this file only places numbers into SVG.
 *
 * Four decisions that are deliberate rather than incidental:
 *
 *   1. BOTH AXES ARE CATEGORICAL. Rows and columns are slots, so bands are
 *      evenly spaced. A numeric axis with uneven spacing (2020, 2021, 2025)
 *      would then be drawn evenly, which is a distortion -- so it is DETECTED
 *      and reported (`rowSpacingUneven` / `colSpacingUneven`) instead of being
 *      left silent.
 *   2. A MISSING CELL IS NEVER A RAMP STEP. "No measurement" and "the lowest
 *      measurement" are different statements, so an absent value gets a hatched
 *      neutral tile, never the ramp's weakest step, and the legend names it.
 *   3. HOLES KEEP THEIR PLACE. A (row, column) pair with no record still gets a
 *      cell, so adjacency in the matrix keeps meaning adjacency in the data.
 *   4. THE RAMP IS A LIGHTNESS LADDER, NOT A RAINBOW. See HEAT_RAMP: seven steps
 *      of the dedicated `--chart-seq-*` tokens, one set per theme, monotone in
 *      OKLab lightness in both and at least 3:1 from the surface at its weakest
 *      step. `options.colors` still replaces it outright.
 *
 * The grid assembly, the tooltip markup and the keyboard movement are exported
 * as pure functions so they can be tested in node -- this package has no browser
 * in its test loop, and an untested renderer is how escaping bugs ship.
 *
 * All text lives in HTML overlays, never inside the SVG: the plot fills its box
 * with preserveAspectRatio="none", which would stretch any text drawn in there.
 */
import {
  isNum, num, stepScale, colorBins, bandScale, plotArea,
  formatNumber, intervalsAreEven, esc, px,
} from './core.js'

const NS = 'http://www.w3.org/2000/svg'

/** Stand-in label for a record whose row or column label is empty or missing. */
export const BLANK_LABEL = '(未命名)'

/**
 * The sequential ramp: theme.css's `--chart-seq-*` tokens, weakest step first.
 *
 * theme.css ships them as one hue's lightness ladder, one set per theme, and the
 * direction of meaning is the same in both: a larger value sits further from the
 * surface (palest -> darkest in light mode, darkest -> palest in dark mode), so
 * "stronger" never means two different things depending on the reader's theme.
 * One array serves both themes because the theme picks the values.
 *
 * This replaces a hand-picked subset of `--chart-cat-*`. That subset was a
 * workaround, not a design: the categorical tokens are NOT monotone in both
 * themes, the longest monotone subset had to begin at a step that measured 1.5:1
 * against a white surface -- a step the eye reads as an empty cell -- and reusing
 * them left magnitude and identity sharing one set of colours.
 *
 * Four properties, all measured by tests/seq.test.js against theme.css itself:
 * monotone OKLab lightness in each theme, adjacent steps at least 0.04 apart in
 * OKLab L, at least 3:1 against the theme's own surface at the weakest step, and
 * a single hue across all fourteen values. Change the values if a better ladder
 * appears; do not quietly drop one of those properties.
 */
export const HEAT_RAMP = [
  'var(--chart-seq-1)',   // weakest
  'var(--chart-seq-2)',
  'var(--chart-seq-3)',
  'var(--chart-seq-4)',
  'var(--chart-seq-5)',
  'var(--chart-seq-6)',
  'var(--chart-seq-7)',   // strongest
]

/**
 * The ramp to paint with: the caller's tokens when they supplied a usable list,
 * otherwise the theme's sequential ladder.
 *
 * Pure and exported on purpose -- "the option still overrides the default" is a
 * behaviour worth a direct test, and it is exactly the behaviour that breaks
 * silently when a default is refactored.
 */
export function resolveRamp(colors) {
  return Array.isArray(colors) && colors.length ? colors : HEAT_RAMP
}

/** Missing data: a neutral tile, hatched so it cannot be mistaken for a step. */
export const MISSING_FILL = 'var(--chart-sunken)'
export const MISSING_HATCH = 'var(--chart-faint)'

const DEFAULT_BINS = 5
const NUMBER_LIKE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const KEY_ITEM = 'display:inline-flex;align-items:center;gap:6px'
const KEY_SWATCH = 'display:inline-block;width:11px;height:11px;border-radius:3px;flex:none'

let seq = 0

// ────────────────────────────────────────────── pure helpers (unit tested)

/** A label the reader can see. A blank one is named, not silently dropped. */
export function normalizeLabel(v) {
  if (v === null || v === undefined) return BLANK_LABEL
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : BLANK_LABEL
  if (typeof v === 'boolean') return String(v)
  const s = String(v).trim()
  return s === '' ? BLANK_LABEL : s
}

/**
 * Read a cell value the way real data arrives.
 *
 * `"142"` is a numeric string from a JSON API and is accepted -- the skill's
 * dirty-data rule. `"18,540"` is refused, because a thousands separator means
 * the upstream is doing display formatting; tolerating it invites worse input.
 * `""`, `null`, `"N/A"` and `"+-"` are absences, not zeros.
 *
 * @returns {number|null} the value, or null when it is not usable
 */
export function coerceCellValue(v) {
  if (isNum(v)) return v
  if (typeof v === 'string') {
    const s = v.trim()
    if (!NUMBER_LIKE.test(s)) return null
    const n = Number(s)
    return isNum(n) ? n : null
  }
  return null
}

/** Final axis order: the caller's explicit order first, then anything unseen. */
function orderAxis(seen, wanted) {
  if (!Array.isArray(wanted) || !wanted.length) {
    return { labels: seen.slice(), unlisted: 0, extra: 0 }
  }
  const seenSet = new Set(seen)
  const used = new Set()
  const labels = []
  let extra = 0
  for (const w of wanted) {
    const lab = normalizeLabel(w)
    if (used.has(lab)) continue
    used.add(lab)
    labels.push(lab)
    // A label the caller listed but the data never mentions is kept: "this
    // device reported nothing" is a fact worth showing as an empty row.
    if (!seenSet.has(lab)) extra += 1
  }
  let unlisted = 0
  for (const lab of seen) {
    if (used.has(lab)) continue
    used.add(lab)
    labels.push(lab)
    unlisted += 1
  }
  return { labels, unlisted, extra }
}

/**
 * Long-format rows -> a rectangular cell grid, with every loss counted.
 *
 * Field-level hygiene rather than row-level (the skill prefers it): a record
 * whose value is unusable still proves its row and column exist, so the cell is
 * created and marked `unusable-value` instead of vanishing.
 *
 * @param {object} options
 * @param {object[]} options.rows
 * @param {(row:object)=>unknown} [options.row] row label accessor
 * @param {(row:object)=>unknown} [options.col] column label accessor
 * @param {(row:object)=>unknown} [options.value] value accessor
 * @param {unknown[]} [options.rowOrder] explicit row order
 * @param {unknown[]} [options.colOrder] explicit column order
 */
export function prepareHeatmap(options = {}) {
  const list = Array.isArray(options.rows) ? options.rows : []
  const readRow = typeof options.row === 'function' ? options.row : (r) => (r ? r.row : undefined)
  const readCol = typeof options.col === 'function' ? options.col : (r) => (r ? r.col : undefined)
  const readVal = typeof options.value === 'function' ? options.value : (r) => (r ? r.value : undefined)

  const seenRows = []
  const seenCols = []
  const colSeen = new Set()
  const byRow = new Map()             // rowLabel -> Map(colLabel -> {sum, n, bad})
  let rejected = 0
  let coerced = 0
  let duplicates = 0
  let blankLabels = 0

  for (const row of list) {
    let rawRow, rawCol, rawVal
    try {
      rawRow = readRow(row)
      rawCol = readCol(row)
      rawVal = readVal(row)
    } catch {
      rejected += 1                   // an accessor that throws cannot be placed
      continue
    }
    const rowLabel = normalizeLabel(rawRow)
    const colLabel = normalizeLabel(rawCol)
    if (rowLabel === BLANK_LABEL || colLabel === BLANK_LABEL) blankLabels += 1

    let cols = byRow.get(rowLabel)
    if (!cols) {
      cols = new Map()
      byRow.set(rowLabel, cols)
      seenRows.push(rowLabel)
    }
    if (!colSeen.has(colLabel)) {
      colSeen.add(colLabel)
      seenCols.push(colLabel)
    }
    let cell = cols.get(colLabel)
    if (!cell) {
      cell = { sum: 0, n: 0, bad: 0 }
      cols.set(colLabel, cell)
    }

    const value = coerceCellValue(rawVal)
    if (value === null) {
      rejected += 1
      cell.bad += 1
      continue
    }
    if (typeof rawVal !== 'number') coerced += 1
    // Two records in one cell are averaged, never "last one wins": an average is
    // defensible, a silent overwrite is not. The count is kept so the tooltip
    // can say how many records the number came from.
    if (cell.n > 0) duplicates += 1
    cell.sum += value
    cell.n += 1
  }

  const rowAxis = orderAxis(seenRows, options.rowOrder)
  const colAxis = orderAxis(seenCols, options.colOrder)
  const rowLabels = rowAxis.labels
  const colLabels = colAxis.labels

  const cells = []
  const values = []
  let missing = 0
  for (const rowLabel of rowLabels) {
    const cols = byRow.get(rowLabel)
    const line = []
    for (const colLabel of colLabels) {
      const acc = cols ? cols.get(colLabel) : undefined
      if (!acc || acc.n === 0) {
        missing += 1
        line.push({
          row: rowLabel,
          col: colLabel,
          value: null,
          n: 0,
          // The two reasons matter: "nobody measured this" and "it was measured
          // and the number was unusable" are different, and the tooltip says so.
          reason: acc && acc.bad > 0 ? 'unusable-value' : 'no-record',
        })
      } else {
        const value = acc.sum / acc.n
        values.push(value)
        line.push({ row: rowLabel, col: colLabel, value, n: acc.n, reason: null })
      }
    }
    cells.push(line)
  }

  const spacingEven = (labels) => !(labels.length >= 4 &&
    labels.every((l) => NUMBER_LIKE.test(l)) &&
    !intervalsAreEven(labels.map((l) => ({ t: Number(l) }))))

  const total = rowLabels.length * colLabels.length
  return {
    rowLabels,
    colLabels,
    rowCount: rowLabels.length,
    colCount: colLabels.length,
    cells,
    values,
    duplicates,
    coerced,
    rejected,
    blankLabels,
    unlistedRows: rowAxis.unlisted,
    unlistedCols: colAxis.unlisted,
    extraRows: rowAxis.extra,
    extraCols: colAxis.extra,
    missing,
    filled: total - missing,
    /** Numeric labels with uneven spacing are drawn evenly; the caller is told. */
    rowSpacingUneven: !spacingEven(rowLabels),
    colSpacingUneven: !spacingEven(colLabels),
    empty: rowLabels.length === 0 || colLabels.length === 0,
    allMissing: total > 0 && total === missing,
  }
}

/** Which token a bin index uses, spreading `bins` across the whole ramp. */
export function rampIndexFor(step, bins, ramp = HEAT_RAMP) {
  const list = Array.isArray(ramp) && ramp.length ? ramp : HEAT_RAMP
  const n = list.length
  const b = Math.max(1, Math.floor(num(bins, n)))
  // A single class is not the top of the ramp: one colour for everything means
  // the middle of the ladder, which claims nothing about the values.
  if (b <= 1) return Math.floor((n - 1) / 2)
  const i = Math.max(0, Math.min(b - 1, Math.floor(num(step, 0))))
  return Math.max(0, Math.min(n - 1, Math.round((i * (n - 1)) / (b - 1))))
}

/**
 * Fill for one cell. A missing value returns the MISSING token, never a ramp
 * step, which is what makes `stepScale` returning null structurally safe.
 */
export function fillForStep(step, options = {}) {
  const ramp = resolveRamp(options.ramp)
  if (!isNum(step)) return options.missing === undefined ? MISSING_FILL : options.missing
  return ramp[rampIndexFor(step, options.bins, ramp)]
}

/**
 * Tooltip markup for one cell.
 *
 * Escaping lives here, in a pure function, on purpose: labels come from data and
 * data is untrusted, and a renderer that can only be checked by looking at it is
 * a renderer whose escaping is never checked.
 */
export function heatTipHtml(cell, options = {}) {
  if (!cell) return ''
  const ramp = resolveRamp(options.ramp)
  const bins = Math.max(1, Math.floor(num(options.bins, ramp.length)))
  const edges = Array.isArray(options.edges) ? options.edges : []
  const fmt = typeof options.formatValue === 'function' ? options.formatValue : (v) => formatNumber(v)
  const rowAxis = options.rowAxis || '行'
  const missingText = options.missingLabel || '无数据'

  const title = `<div class="chart-tip-title">${esc(cell.col)}</div>`
  const head = `<div class="chart-tip-row"><i></i>${esc(rowAxis)}<b>${esc(cell.row)}</b></div>`

  if (!isNum(cell.value)) {
    const why = cell.reason === 'unusable-value' ? '有记录，但数值不可用' : '该格没有记录'
    return title + head +
      `<div class="chart-tip-row"><i style="background:${MISSING_FILL}"></i>${esc(missingText)}<b>—</b></div>` +
      `<div class="chart-tip-row"><i></i>原因<b>${esc(why)}</b></div>`
  }

  const step = isNum(cell.step) ? cell.step : null
  const from = step !== null && isNum(edges[step]) ? edges[step] : null
  const to = step !== null && isNum(edges[step + 1]) ? edges[step + 1] : null
  const range = from !== null && to !== null ? `${fmt(from)} – ${fmt(to)}` : '—'
  const swatch = fillForStep(step, { ramp, bins })
  return title + head +
    `<div class="chart-tip-row"><i style="background:${esc(swatch)}"></i>数值<b>${esc(fmt(cell.value))}</b></div>` +
    `<div class="chart-tip-row"><i></i>色档<b>${esc(range)}</b></div>` +
    `<div class="chart-tip-row"><i></i>记录数<b>${esc(String(num(cell.n, 0)))}</b></div>`
}

/** Arrow-key movement over the grid, clamped at the edges. */
export function moveCell(cell, key, dims = {}) {
  const rows = Math.floor(num(dims.rows, 0))
  const cols = Math.floor(num(dims.cols, 0))
  if (rows < 1 || cols < 1) return null
  const cur = cell && isNum(cell.r) && isNum(cell.c) ? cell : { r: 0, c: 0 }
  let r = Math.max(0, Math.min(rows - 1, Math.floor(cur.r)))
  let c = Math.max(0, Math.min(cols - 1, Math.floor(cur.c)))
  if (key === 'ArrowRight') c += 1
  else if (key === 'ArrowLeft') c -= 1
  else if (key === 'ArrowDown') r += 1
  else if (key === 'ArrowUp') r -= 1
  else if (key === 'Home') c = 0
  else if (key === 'End') c = cols - 1
  else if (key === 'PageUp') r = 0
  else if (key === 'PageDown') r = rows - 1
  else return null
  return { r: Math.max(0, Math.min(rows - 1, r)), c: Math.max(0, Math.min(cols - 1, c)) }
}

function axisIndex(v, labels) {
  if (isNum(v)) {
    const i = Math.floor(v)
    return i >= 0 && i < labels.length ? i : null
  }
  const i = labels.indexOf(normalizeLabel(v))
  return i < 0 ? null : i
}

/**
 * Turn a programmatic selection into a position: a row-major index, or
 * `{row, col}` given either as labels or as indices.
 */
export function resolveCell(target, axes = {}) {
  const rowLabels = Array.isArray(axes.rowLabels) ? axes.rowLabels : []
  const colLabels = Array.isArray(axes.colLabels) ? axes.colLabels : []
  const cols = colLabels.length
  if (target === null || target === undefined) return null
  if (isNum(target)) {
    if (cols < 1 || rowLabels.length < 1) return null
    const i = Math.floor(target)
    if (i < 0 || i >= rowLabels.length * cols) return null
    return { r: Math.floor(i / cols), c: i % cols }
  }
  if (typeof target === 'object') {
    const r = axisIndex(target.row, rowLabels)
    const c = axisIndex(target.col, colLabels)
    return r === null || c === null ? null : { r, c }
  }
  return null
}

// ────────────────────────────────────────────── renderer

/**
 * @param {HTMLElement} host
 * @param {object} options
 * @param {Array<Record<string, any>>} options.rows  long format: one record per cell
 * @param {(row:object)=>unknown} [options.row]      row label accessor
 * @param {(row:object)=>unknown} [options.col]      column label accessor
 * @param {(row:object)=>unknown} [options.value]    value accessor
 * @param {unknown[]} [options.rowOrder]             explicit row order
 * @param {unknown[]} [options.colOrder]             explicit column order
 * @param {number} [options.height=320]              reserved before data arrives
 * @param {number} [options.bins=DEFAULT_BINS]       colour classes
 * @param {'auto'|'equal'|'quantile'} [options.binMethod='auto']
 * @param {number} [options.maxBinShare=0.5]         occupancy that tips the auto choice
 * @param {string[]} [options.colors]                override the ramp (tokens only; default --chart-seq-1..7)
 * @param {number} [options.cellGap=0.08]            gap between cells, as a share of the band
 * @param {string} [options.rowAxis='行']            axis name, for the tooltip
 * @param {string} [options.missingLabel='无数据']
 * @param {(v:number)=>string} [options.formatValue]
 * @param {(cell:object|null, index:number|null)=>void} [options.onHover]
 * @param {(cell:object|null, index:number|null)=>void} [options.onSelect]
 * @param {(info:object)=>void} [options.onRender]
 */
export function heatmapChart(host, options = {}) {
  if (!host) throw new Error('heatmapChart: host element is required')

  const state = { ...options, hover: null, selected: null, frame: 0, destroyed: false, cache: null }
  const pad = { top: 58, right: 14, bottom: 34, left: 78, ...(options.padding || {}) }
  const gap = 0.08

  // ---- static DOM scaffold: created once, never rebuilt --------------------
  host.classList.add('chart')
  host.style.position = 'relative'
  host.innerHTML = ''
  // The chart is reachable by keyboard: hover alone would leave keyboard users
  // with a picture and no readings.
  if (state.focusable !== false) host.setAttribute('tabindex', '0')

  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('preserveAspectRatio', 'none')
  const tip = document.createElement('div')
  tip.className = 'chart-tip'
  const rowLab = document.createElement('div')
  rowLab.className = 'chart-ylab'
  const colLab = document.createElement('div')
  colLab.className = 'chart-collab'
  const legend = document.createElement('div')
  legend.className = 'chart-heat-legend'
  const note = document.createElement('div')
  note.className = 'chart-heat-note'
  host.append(svg, rowLab, colLab, legend, note, tip)

  const missId = `heatmiss-${++seq}`
  const observer = new ResizeObserver(() => schedule())
  const height = () => num(state.height, 320)
  const fmtVal = (v) => (typeof state.formatValue === 'function' ? state.formatValue(v) : formatNumber(v))
  const rampOf = () => resolveRamp(state.colors)

  /** Pure: options -> grid + colour bins + the value -> bin scale. */
  function build() {
    const grid = prepareHeatmap(state)
    const ramp = rampOf()
    // The ramp is the limit on class count: cycling colours would make bin 6 look
    // like bin 1 and turn an ordered scale into a lie.
    const requestedBins = Math.max(1, Math.min(Math.floor(num(state.bins, DEFAULT_BINS)), ramp.length))
    const colorScale = colorBins(grid.values, {
      bins: requestedBins,
      method: state.binMethod || 'auto',
      maxBinShare: state.maxBinShare,
      domain: state.domain,
    })
    return {
      ...grid,
      ramp,
      requestedBins,
      colorScale,
      bins: colorScale.bins,
      scale: stepScale(colorScale.edges),
    }
  }

  /** Cached: hovering must not re-bin the whole matrix on every mousemove. */
  function prepare() {
    if (!state.cache) state.cache = build()
    return state.cache
  }

  function schedule() {
    if (state.frame || state.destroyed) return
    state.frame = requestAnimationFrame(draw)   // at most one redraw per frame
  }

  function cellInfo(prep, pos) {
    if (!pos) return null
    const line = prep.cells[pos.r]
    const cell = line ? line[pos.c] : null
    if (!cell) return null
    return {
      row: cell.row,
      col: cell.col,
      value: cell.value,
      n: cell.n,
      reason: cell.reason,
      step: prep.scale.step(cell.value),
    }
  }

  function tipCtx(prep) {
    return {
      edges: prep.colorScale.edges,
      ramp: prep.ramp,
      bins: prep.bins,
      rowAxis: state.rowAxis || '行',
      missingLabel: state.missingLabel || '无数据',
      formatValue: fmtVal,
    }
  }

  function placeTip(prep, pos) {
    const box = svg.getBoundingClientRect()
    const w = Math.max(1, host.clientWidth)
    const h = height()
    const area = plotArea(w, h, pad)
    const rs = bandScale(prep.rowCount, [area.y, area.y + area.height], { padding: gap })
    const cs = bandScale(prep.colCount, [area.x, area.x + area.width], { padding: gap })
    const bw = box.width || w
    const bh = box.height || h
    const cx = cs.center(pos.c) * (box.width ? box.width / w : 1)
    const cy = rs.center(pos.r) * (box.height ? box.height / h : 1)
    const tw = num(tip.offsetWidth, 0)
    const th = num(tip.offsetHeight, 0)
    // Near the right edge the panel flips to the other side, or it hangs off the
    // plot exactly where the reader is looking.
    const left = cx > bw * 0.55 ? cx - tw - 14 : cx + 14
    const top = cy - th / 2
    tip.style.left = `${Math.max(6, Math.min(Math.max(6, bw - tw - 6), left)).toFixed(1)}px`
    tip.style.top = `${Math.max(6, Math.min(Math.max(6, bh - th - 6), top)).toFixed(1)}px`
  }

  /**
   * Show the reading for the hovered cell, or for the pinned one when nothing is
   * hovered. Transient hover wins while it lasts; the pinned cell keeps its
   * accent outline either way, so moving the mouse away never loses the answer
   * you pinned.
   */
  function refreshTip(prep) {
    const pos = state.hover || state.selected
    const info = pos ? cellInfo(prep, pos) : null
    if (!info) {
      tip.style.display = 'none'
      return
    }
    tip.innerHTML = heatTipHtml(info, tipCtx(prep))
    // 'block', NOT ''. `.chart-tip` is `display: none` in theme.css, so clearing
    // the inline value leaves the element on the CSS default and the tooltip
    // never appears at all -- a hover reading that silently does not exist.
    // (line.js and bar.js both clear it instead; that is their bug, not the
    // intended behaviour.)
    tip.style.display = 'block'
    placeTip(prep, pos)
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

    // A position that no longer exists must not survive a data swap.
    if (state.hover && !cellInfo(prep, state.hover)) state.hover = null
    if (state.selected && !cellInfo(prep, state.selected)) state.selected = null

    if (prep.empty) {
      svg.innerHTML = ''
      rowLab.innerHTML = ''
      colLab.innerHTML = ''
      legend.innerHTML = ''
      note.textContent = ''
      tip.style.display = 'none'
      svg.setAttribute('aria-label', 'No data')
      state.onRender && state.onRender({ ...prep, empty: true })
      return
    }

    const area = plotArea(w, h, pad)
    const rs = bandScale(prep.rowCount, [area.y, area.y + area.height], { padding: gap })
    const cs = bandScale(prep.colCount, [area.x, area.x + area.width], { padding: gap })

    // Cells are grouped by colour step into one path each: a 60x60 matrix is six
    // paths instead of 3600 rects, which is the difference between smooth and
    // unusable. Highlighting is a separate overlay, so nothing is lost.
    const groups = new Map()
    const holes = []
    for (let r = 0; r < prep.rowCount; r++) {
      for (let c = 0; c < prep.colCount; c++) {
        const x = cs.left(c)
        const y = rs.left(r)
        const d = `M${px(x)} ${px(y)}h${px(cs.band)}v${px(rs.band)}h${px(-cs.band)}Z`
        const step = prep.scale.step(prep.cells[r][c].value)
        if (step === null) holes.push(d)
        else groups.set(step, (groups.get(step) || '') + d)
      }
    }

    let out = `<defs><pattern id="${esc(missId)}" patternUnits="userSpaceOnUse" width="7" height="7">` +
      `<rect width="7" height="7" fill="${MISSING_FILL}"/>` +
      `<path d="M-1 1L1 -1M0 7L7 0M6 8L8 6" stroke="${MISSING_HATCH}" stroke-width="1"/>` +
      '</pattern></defs>'
    for (const [step, d] of groups) {
      out += `<path d="${d}" fill="${esc(fillForStep(step, { ramp: prep.ramp, bins: prep.bins }))}"/>`
    }
    if (holes.length) out += `<path d="${holes.join('')}" fill="url(#${esc(missId)})"/>`

    const outline = (pos, isSelected) => {
      if (!pos) return ''
      return `<rect x="${px(cs.left(pos.c))}" y="${px(rs.left(pos.r))}" width="${px(cs.band)}" ` +
        `height="${px(rs.band)}" fill="none" ` +
        `stroke="${isSelected ? 'var(--chart-accent)' : 'var(--chart-guide)'}" ` +
        `stroke-width="${isSelected ? 2 : 1.5}"${isSelected ? '' : ' stroke-dasharray="4 3"'}/>`
    }
    out += outline(state.hover, false)
    out += outline(state.selected, true)
    svg.innerHTML = out

    // The hover idiom matches the chart type: a heatmap's structure is its row
    // and column labels, so those are what light up -- not a column band.
    const activeRows = new Set()
    const activeCols = new Set()
    if (state.hover) { activeRows.add(state.hover.r); activeCols.add(state.hover.c) }
    if (state.selected) { activeRows.add(state.selected.r); activeCols.add(state.selected.c) }
    const emph = 'color:var(--chart-ink);font-weight:600;'

    rowLab.innerHTML = prep.rowLabels.map((lab, r) => (
      `<span style="left:0;right:10px;text-align:right;overflow:hidden;text-overflow:ellipsis;` +
      `top:${(prep.rowCount ? (rs.center(r) / h) * 100 : 0).toFixed(3)}%;` +
      `${activeRows.has(r) ? emph : ''}" title="${esc(lab)}">${esc(lab)}</span>`
    )).join('')
    rowLab.style.cssText = `position:absolute;left:0;top:${area.y}px;height:${area.height}px;` +
      `width:${Math.max(24, pad.left - 10)}px;pointer-events:none;overflow:hidden`

    // Narrow cells mean the column labels cannot sit side by side at full length;
    // rotating them keeps every label rather than dropping every other one.
    const rotate = prep.colCount > 6 && cs.band < 46
    colLab.innerHTML = prep.colLabels.map((lab, c) => {
      const left = prep.colCount ? (cs.center(c) / w) * 100 : 0
      const shape = rotate
        ? 'transform:translateX(-50%) rotate(-45deg);transform-origin:center;white-space:nowrap;'
        : `transform:translateX(-50%);max-width:${Math.max(8, cs.band - 2).toFixed(1)}px;` +
          'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;'
      return `<span style="position:absolute;top:0;left:${left.toFixed(3)}%;font-size:11px;line-height:1.15;` +
        `${activeCols.has(c) ? emph : 'color:var(--chart-faint);'}${shape}" title="${esc(lab)}">${esc(lab)}</span>`
    }).join('')
    colLab.style.cssText = `position:absolute;left:${area.x}px;width:${area.width}px;` +
      `top:${area.y + area.height + 4}px;height:${Math.max(10, pad.bottom - 6)}px;pointer-events:none`

    // ---- legend: what colour means what number ----------------------------
    const buckets = prep.colorScale
    const keys = []
    for (let i = 0; i < prep.bins; i++) {
      const label = `${fmtVal(buckets.edges[i])} – ${fmtVal(buckets.edges[i + 1])}`
      const share = buckets.total ? Math.round((buckets.counts[i] / buckets.total) * 100) : 0
      const hint = `${label} · ${buckets.counts[i]} 格 (${share}%)`
      keys.push(`<span class="heat-key" style="${KEY_ITEM}" title="${esc(hint)}">` +
        `<i style="${KEY_SWATCH};background:${esc(fillForStep(i, { ramp: prep.ramp, bins: prep.bins }))}"></i>` +
        `${esc(label)}</span>`)
    }
    keys.push(`<span class="heat-key" style="${KEY_ITEM}" ` +
      `title="${esc('该格没有任何可用数值，用斜纹表示，刻意不与任何色档重合')}">` +
      `<i style="${KEY_SWATCH};background:${MISSING_FILL};box-shadow:inset 0 0 0 1px ${MISSING_HATCH}"></i>` +
      `${esc(state.missingLabel || '无数据')}</span>`)
    // Which method produced these numbers is a product decision, so it is stated
    // on the chart instead of hiding in the source.
    const methodText = buckets.method === 'quantile'
      ? `按分位数分 ${prep.bins} 档`
      : `按等距分 ${prep.bins} 档`
    keys.push(`<span class="heat-method" title="${esc(buckets.detail)}">${esc(methodText)}</span>`)
    legend.innerHTML = keys.join('')
    legend.style.cssText = `position:absolute;left:${pad.left}px;right:${pad.right}px;top:4px;` +
      'display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;overflow:hidden;' +
      `max-height:${Math.max(16, pad.top - 24)}px;font-size:11px;line-height:16px;` +
      'color:var(--chart-faint);font-variant-numeric:tabular-nums'

    // ---- what was ignored, dropped or averaged ---------------------------
    const notes = []
    if (prep.missing) notes.push(`矩阵 ${prep.rowCount}×${prep.colCount} 中 ${prep.missing} 格无可用数值（斜纹）`)
    if (prep.rejected) notes.push(`已忽略 ${prep.rejected} 条数值不可用的记录`)
    if (prep.duplicates) notes.push(`${prep.duplicates} 条重复记录按格取平均`)
    if (prep.coerced) notes.push(`${prep.coerced} 条字符串数值已转为数字`)
    if (prep.blankLabels) notes.push(`${prep.blankLabels} 条记录缺行或列标签`)
    if (prep.unlistedRows + prep.unlistedCols) {
      notes.push(`${prep.unlistedRows + prep.unlistedCols} 个轴标签未出现在指定顺序中，已追加在末尾`)
    }
    if (prep.rowSpacingUneven || prep.colSpacingUneven) {
      notes.push(`${prep.rowSpacingUneven ? '行' : ''}${prep.colSpacingUneven ? '列' : ''}标签是数值但间距不等，按等距格排布`)
    }
    if (isNum(state.bins) && state.bins > prep.requestedBins) {
      notes.push(`色阶只有 ${prep.ramp.length} 级，档数由 ${state.bins} 收窄到 ${prep.requestedBins}`)
    }
    if (buckets.collapse) notes.push(`${buckets.collapse} 个分位边界与相邻边界重合，实际 ${prep.bins} 档`)
    note.textContent = notes.join('；')
    note.title = note.textContent      // textContent, so no escaping question arises
    note.style.cssText = `position:absolute;left:${pad.left}px;right:${pad.right}px;` +
      `top:${Math.max(24, pad.top - 18)}px;font-size:11px;line-height:15px;` +
      'color:var(--chart-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis'

    const aria = [
      state.label ? `${state.label}: ` : '',
      `heatmap ${prep.rowCount} rows by ${prep.colCount} columns`,
      prep.allMissing ? 'no usable values' : `values ${formatNumber(buckets.edges[0])} to ${formatNumber(buckets.edges[prep.bins])}`,
      `${prep.bins} ${buckets.method === 'quantile' ? 'quantile' : 'equal-interval'} colour classes`,
      prep.missing ? `${prep.missing} cells without data` : '',
    ].filter(Boolean)
    svg.setAttribute('aria-label', aria.join(', '))

    refreshTip(prep)
    state.onRender && state.onRender({ ...prep, domain: buckets.domain, empty: false })
  }

  // ---- interaction --------------------------------------------------------

  function cellAt(clientX, clientY) {
    const prep = prepare()
    if (!prep.rowCount || !prep.colCount) return null
    const box = svg.getBoundingClientRect()
    if (!box.width || !box.height) return null
    const w = Math.max(1, host.clientWidth)
    const h = height()
    const area = plotArea(w, h, pad)
    const vx = ((clientX - box.left) / box.width) * w
    const vy = ((clientY - box.top) / box.height) * h
    const rs = bandScale(prep.rowCount, [area.y, area.y + area.height], { padding: gap })
    const cs = bandScale(prep.colCount, [area.x, area.x + area.width], { padding: gap })
    const c = Math.floor((vx - area.x) / cs.width)
    const r = Math.floor((vy - area.y) / rs.width)
    if (r < 0 || r >= prep.rowCount || c < 0 || c >= prep.colCount) return null
    return { r, c }
  }

  function setHover(pos) {
    const same = (pos === null && state.hover === null) ||
      (pos !== null && state.hover !== null && pos.r === state.hover.r && pos.c === state.hover.c)
    if (same) return
    state.hover = pos
    const prep = prepare()
    refreshTip(prep)
    state.onHover && state.onHover(cellInfo(prep, pos), pos ? pos.r * prep.colCount + pos.c : null)
    schedule()
  }

  function toggleSelect(pos) {
    const prep = prepare()
    const next = !pos ? null
      : (state.selected && state.selected.r === pos.r && state.selected.c === pos.c) ? null
        : { r: pos.r, c: pos.c }
    state.selected = next
    refreshTip(prep)
    state.onSelect && state.onSelect(cellInfo(prep, next), next ? next.r * prep.colCount + next.c : null)
    schedule()
  }

  function onMouseMove(e) { setHover(cellAt(e.clientX, e.clientY)) }

  function onMouseLeave() {
    if (state.hover === null) return
    state.hover = null
    refreshTip(prepare())     // a pinned cell keeps its reading on screen
    state.onHover && state.onHover(null, null)
    schedule()
  }

  function onClick(e) { toggleSelect(cellAt(e.clientX, e.clientY)) }

  function onFocus() { if (!state.hover) setHover(state.selected || { r: 0, c: 0 }) }

  function onBlur() { setHover(null) }

  function onKeyDown(e) {
    const prep = prepare()
    if (prep.empty) return
    if (e.key === 'Escape') {
      // A pin must always have a way out, or the panel looks stuck.
      if (!state.selected) return
      state.selected = null
      refreshTip(prep)
      state.onSelect && state.onSelect(null, null)
      schedule()
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.preventDefault) e.preventDefault()
      toggleSelect(state.hover || state.selected)
      return
    }
    const move = moveCell(state.hover || state.selected, e.key, {
      rows: prep.rowCount,
      cols: prep.colCount,
    })
    if (!move) return
    if (e.preventDefault) e.preventDefault()
    setHover(move)
  }

  host.addEventListener('mousemove', onMouseMove)
  host.addEventListener('mouseleave', onMouseLeave)
  host.addEventListener('click', onClick)
  host.addEventListener('keydown', onKeyDown)
  host.addEventListener('focus', onFocus)
  host.addEventListener('blur', onBlur)
  observer.observe(host)
  schedule()

  return {
    /** Replace the data or options and redraw. */
    update(next = {}) {
      Object.assign(state, next)
      state.cache = null
      schedule()
    },
    /**
     * Pin a cell programmatically (a row-major index, or {row, col} by label or
     * index). Like line.js and bar.js this does not fire onSelect -- the caller
     * already knows, it was their call.
     */
    select(target) {
      const prep = prepare()
      state.selected = resolveCell(target, { rowLabels: prep.rowLabels, colLabels: prep.colLabels })
      refreshTip(prep)
      schedule()
    },
    /** Current prepared grid, for callers that need the same numbers. */
    data: prepare,
    destroy() {
      state.destroyed = true
      observer.disconnect()
      if (state.frame) cancelAnimationFrame(state.frame)
      host.removeEventListener('mousemove', onMouseMove)
      host.removeEventListener('mouseleave', onMouseLeave)
      host.removeEventListener('click', onClick)
      host.removeEventListener('keydown', onKeyDown)
      host.removeEventListener('focus', onFocus)
      host.removeEventListener('blur', onBlur)
      host.innerHTML = ''
    },
  }
}
