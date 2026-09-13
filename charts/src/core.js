/**
 * Core computation for the chart components.
 *
 * ARCHITECTURE — the whole point of this file:
 *   Every function here is PURE: numbers in, numbers out, no DOM, no globals.
 *   That is what makes a chart testable. A chart whose math lives inside its
 *   render call can only be checked by looking at pixels, which means it is
 *   never checked at all.
 *
 * So the split is:
 *   core.js   -> domain, scales, ticks, stacking, binning, statistics, format
 *   <type>.js -> turns those numbers into SVG strings (thin and boring)
 *
 * Everything is defensive by default: real data is dirty (see the skill's
 * section on dirty data). Nothing here throws on NaN, empty input, or a
 * degenerate domain -- it returns something renderable instead.
 */

/** Is this a usable finite number? */
export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Coerce to a finite number, or fall back. Never returns NaN/Infinity. */
export function num(v, fallback = 0) {
  return isNum(v) ? v : fallback
}

// ────────────────────────────────────────────────────────────── scales

/**
 * A linear scale from a data domain to a pixel range.
 *
 * Handles the three cases that break naive `(v - lo) / (hi - lo)`:
 *   - degenerate domain (all values equal, or a single point) -> centred band
 *   - non-finite bounds -> replaced by a safe default
 *   - inverted range (pixel y grows downward) is allowed
 *
 * @returns {{scale: (v:number)=>number, domain:[number,number], range:[number,number], degenerate:boolean}}
 */
export function linearScale(domain, range) {
  let [lo, hi] = domain
  if (!isNum(lo) || !isNum(hi)) { lo = 0; hi = 1 }
  if (lo > hi) { const t = lo; lo = hi; hi = t }

  const [r0, r1] = range
  const degenerate = !(hi - lo > 1e-12)

  // A degenerate domain still needs a sane pixel answer; put the single value
  // in the middle rather than dividing by ~zero.
  if (degenerate) {
    const mid = (r0 + r1) / 2
    return {
      scale: () => mid,
      domain: [lo, hi],
      range,
      degenerate: true,
    }
  }

  const k = (r1 - r0) / (hi - lo)
  return {
    scale: (v) => r0 + (num(v, lo) - lo) * k,
    domain: [lo, hi],
    range,
    degenerate: false,
  }
}

/**
 * Axis ticks on round numbers covering [lo, hi].
 *
 * Naive tick generation (`lo + i*(hi-lo)/n`) produces labels like 0.30000000000000004
 * and 17333.33, which read as unfinished. This picks a step from the 1/2/5 × 10^n
 * ladder so labels are round.
 *
 * @param {number} lo
 * @param {number} hi
 * @param {number} count approximate number of intervals wanted
 * @returns {number[]} ascending tick values, deduplicated
 */
export function niceTicks(lo, hi, count = 4) {
  if (!isNum(lo) || !isNum(hi)) return [0]
  if (lo > hi) { const t = lo; lo = hi; hi = t }
  if (!(hi - lo > 1e-12)) return [lo]

  const n = Math.max(1, Math.floor(count))
  const raw = (hi - lo) / n
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  // Pick the closest rung of the 1/2/5 ladder in LOG space, not the next one up.
  // Rounding up is the tempting version and it is wrong: for a raw step of 25 it
  // picks 50, which is larger than the spacing we asked for and collapses the
  // axis to three ticks.
  let rung = 10
  let best = Infinity
  for (const cand of [1, 2, 5, 10]) {
    const d = Math.abs(Math.log10(norm) - Math.log10(cand))
    if (d < best) { best = d; rung = cand }
  }
  const step = rung * mag

  const first = Math.ceil(lo / step) * step
  const out = []
  // Guard the loop: floating point can otherwise run away on tiny steps.
  for (let v = first, i = 0; v <= hi + step * 1e-9 && i < 1000; v += step, i++) {
    // Re-round to kill accumulated float noise (0.30000000000000004).
    out.push(Number((Math.round(v / step) * step).toFixed(12)))
  }
  return out.length ? out : [lo]
}

/** The [0, max] domain a bar chart must use, padded for headroom. */
export function zeroBasedDomain(values, headroom = 1.1) {
  const max = values.reduce((m, v) => (isNum(v) && v > m ? v : m), 0)
  const top = max > 0 ? max * headroom : 1
  return [0, top]
}

/**
 * A robust domain that ignores outliers, for line/scatter (not bars).
 *
 * Bars encode magnitude with area, so they must start at zero; a line encodes
 * position, so a single outlier should not flatten every other point into a
 * straight line. This trims to a quantile band and reports what was excluded
 * so the UI can say so.
 */
export function robustDomain(values, { low = 0.01, high = 0.99, pad = 0.12 } = {}) {
  const clean = values.filter(isNum).slice().sort((a, b) => a - b)
  if (!clean.length) return { domain: [0, 1], trimmed: 0, lo: 0, hi: 1 }
  const at = (q) => clean[Math.min(clean.length - 1, Math.max(0, Math.round((clean.length - 1) * q)))]
  let lo = at(low)
  let hi = at(high)
  if (!(hi - lo > 1e-12)) { lo -= 1; hi += 1 }
  const p = (hi - lo) * pad
  const trimmed = clean.filter((v) => v < lo || v > hi).length
  return { domain: [lo - p, hi + p], trimmed, lo, hi }
}

// ────────────────────────────────────────────────────────────── data hygiene

/**
 * Split rows into usable and rejected, with a reason count.
 *
 * Silently dropping rows is worse than failing: the reader sees a chart that
 * looks complete and never learns that a third of the input was unusable. So
 * the caller gets the counts back and is expected to surface them.
 *
 * @param {object[]} rows
 * @param {Record<string, (row:object)=>unknown>} fields numeric fields to validate
 * @returns {{rows:object[], rejected:number, reasons:Record<string,number>}}
 */
export function sanitize(rows, fields) {
  const list = Array.isArray(rows) ? rows : []
  const reasons = {}
  const kept = []
  for (const row of list) {
    let bad = null
    for (const [name, read] of Object.entries(fields)) {
      let v
      try { v = read(row) } catch { v = undefined }
      if (!isNum(v)) { bad = name; break }
    }
    if (bad) { reasons[bad] = (reasons[bad] || 0) + 1 } else { kept.push(row) }
  }
  return { rows: kept, rejected: list.length - kept.length, reasons }
}

/** Sort by an accessor, ascending. Stable, and never mutates the input. */
export function sortedBy(rows, read) {
  return (Array.isArray(rows) ? rows.slice() : [])
    .map((row, i) => ({ row, i, k: read(row) }))
    .sort((a, b) => {
      const av = isNum(a.k) ? a.k : Infinity
      const bv = isNum(b.k) ? b.k : Infinity
      return av === bv ? a.i - b.i : av - bv
    })
    .map((x) => x.row)
}

/**
 * Collapse rows sharing a key by averaging their value.
 *
 * Duplicate timestamps are common in event data (two events in the same
 * millisecond). Keeping the first one and dropping the rest quietly loses
 * information; averaging keeps the aggregate honest.
 */
export function collapseBy(rows, keyOf, valueOf) {
  const map = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const k = keyOf(row)
    const v = valueOf(row)
    if (!isNum(v)) continue
    const cur = map.get(k)
    if (cur) { cur.sum += v; cur.n += 1; cur.value = cur.sum / cur.n }
    else map.set(k, { key: k, sum: v, n: 1, value: v })
  }
  return Array.from(map.values()).map((e) => ({ key: e.key, value: e.value, n: e.n }))
}

// ────────────────────────────────────────────────────────────── shapes

/**
 * Stack series into cumulative segments.
 *
 * `segments[i][j] = { key, value, from, to }` where `from`/`to` are the
 * running totals. Segment ORDER IS PRESERVED across every column -- if it were
 * not, the same colour would mean different things in different bars and the
 * legend would be a lie.
 *
 * @param {Array<Record<string, number>>} rows
 * @param {string[]} keys series keys, in drawing order
 * @param {(v:unknown)=>number} [clean] value coercion
 */
export function stack(rows, keys, clean = num) {
  const list = Array.isArray(rows) ? rows : []
  const k = Array.isArray(keys) ? keys : []
  return list.map((row, i) => {
    let acc = 0
    const segments = k.map((key) => {
      const value = Math.max(0, clean(row?.[key]))   // negative stacks are undefined
      const seg = { key, value, from: acc, to: acc + value }
      acc += value
      return seg
    })
    return { index: i, row, segments, total: acc }
  })
}

/**
 * Bin values into a histogram.
 *
 * `domain` is fixed rather than derived from the data, because a histogram
 * whose bins move as you filter is impossible to compare across views.
 */
export function histogram(values, { bins = 10, domain = null } = {}) {
  const clean = (Array.isArray(values) ? values : []).filter(isNum)
  const n = Math.max(1, Math.floor(bins))

  let lo, hi
  if (domain) [lo, hi] = domain
  else {
    if (!clean.length) { lo = 0; hi = 1 }
    else {
      lo = Math.min(...clean)
      hi = Math.max(...clean)
      if (!(hi - lo > 1e-12)) { lo -= 1; hi += 1 }   // all values equal
    }
  }
  // A degenerate domain must still produce bins, not a division by zero.
  const width = (hi - lo) / n || 1
  const out = Array.from({ length: n }, (_, i) => ({
    from: lo + i * width,
    to: lo + (i + 1) * width,
    count: 0,
  }))
  let placed = 0
  let ignored = 0
  for (const v of clean) {
    if (v < lo || v > hi) { ignored += 1; continue }
    const idx = Math.min(n - 1, Math.max(0, Math.floor((v - lo) / width)))
    out[idx].count += 1
    placed += 1
  }
  // `total` counts what was actually binned. Values outside a caller-supplied
  // domain are reported separately -- dropping them silently would make the
  // histogram look complete when it is not.
  return { bins: out, domain: [lo, hi], width, total: placed, ignored }
}

/**
 * Five-number summary for a box plot: [min, q1, median, q3, max] plus outliers.
 *
 * Uses the linear-interpolation quantile (the same convention as most
 * statistics packages), so the numbers agree with what a reader gets elsewhere.
 */
export function boxStats(values, { iqrFactor = 1.5 } = {}) {
  const clean = (Array.isArray(values) ? values : []).filter(isNum).slice().sort((a, b) => a - b)
  if (!clean.length) return { empty: true, count: 0, outliers: [] }

  const at = (q) => {
    const pos = (clean.length - 1) * q
    const base = Math.floor(pos)
    const rest = pos - base
    const next = clean[base + 1]
    return next === undefined ? clean[base] : clean[base] + rest * (next - clean[base])
  }
  const q1 = at(0.25), med = at(0.5), q3 = at(0.75)
  const iqr = q3 - q1
  const fenceLo = iqr > 0 ? q1 - iqrFactor * iqr : q1
  const fenceHi = iqr > 0 ? q3 + iqrFactor * iqr : q3

  const inliers = clean.filter((v) => v >= fenceLo && v <= fenceHi)
  return {
    empty: false,
    count: clean.length,
    min: inliers.length ? inliers[0] : clean[0],
    q1, median: med, q3,
    max: inliers.length ? inliers[inliers.length - 1] : clean[clean.length - 1],
    outliers: clean.filter((v) => v < fenceLo || v > fenceHi),
    iqr,
  }
}

/** Moving average with a partial-window start (never emits NaN at the head). */
export function movingAverage(values, window = 7) {
  const clean = (Array.isArray(values) ? values : []).map((v) => num(v, 0))
  const w = Math.max(1, Math.floor(window))
  const out = []
  let sum = 0
  for (let i = 0; i < clean.length; i++) {
    sum += clean[i]
    if (i >= w) sum -= clean[i - w]
    out.push(sum / Math.min(i + 1, w))
  }
  return out
}

/**
 * Index cuts where a time series is missing data.
 *
 * A continuous line asserts "it was like this the whole time". Across a gap
 * there was no measurement at all, so the line must break -- otherwise the
 * chart states something false. Returns indices `i` meaning "a gap sits between
 * point i-1 and point i".
 */
export function gapIndices(times, { factor = 3 } = {}) {
  const t = (Array.isArray(times) ? times : []).filter(isNum)
  if (t.length < 3) return []
  const deltas = []
  for (let i = 1; i < t.length; i++) deltas.push(t[i] - t[i - 1])
  const sorted = deltas.slice().sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1]
  if (!(median > 0)) return []
  const cuts = []
  for (let i = 1; i < t.length; i++) {
    if (t[i] - t[i - 1] > median * factor) cuts.push(i)
  }
  return cuts
}

/** Split an array at the given cut indices. */
export function splitAt(list, cuts) {
  const arr = Array.isArray(list) ? list : []
  const marks = Array.from(new Set((cuts || []).filter((i) => i > 0 && i < arr.length))).sort((a, b) => a - b)
  if (!marks.length) return [arr]
  const out = []
  let prev = 0
  for (const cut of marks.concat([arr.length])) {
    const part = arr.slice(prev, cut)
    if (part.length) out.push(part)
    prev = cut
  }
  return out.length ? out : [arr]
}

/**
 * Reduce a series to at most `max` points by averaging time buckets.
 *
 * Points that cannot be seen need not be drawn. Bucketing (rather than
 * dropping) keeps the shape; dropping every Nth point can alias a spike away
 * entirely.
 */
export function downsample(points, max = 700, timeOf = (p) => p.key ?? p.t ?? p.x) {
  const arr = Array.isArray(points) ? points : []
  if (arr.length <= max) return { points: arr, sampled: false, factor: 1 }
  const factor = Math.ceil(arr.length / max)
  const out = []
  for (let i = 0; i < arr.length; i += factor) {
    const slice = arr.slice(i, i + factor)
    const sum = slice.reduce((s, p) => s + num(p.value ?? p.y ?? p.v, 0), 0)
    const tSum = slice.reduce((s, p) => s + num(timeOf(p), 0), 0)
    out.push({ ...slice[0], key: Math.round(tSum / slice.length), t: Math.round(tSum / slice.length), value: sum / slice.length, n: slice.length })
  }
  return { points: out, sampled: true, factor }
}

// ────────────────────────────────────────────────────────────── formatting

/**
 * Human-readable numbers.
 *
 * Round numbers and thousands separators are not cosmetic: "1240000.0" reads as
 * a raw debug print, and three decimal places on a count implies a precision
 * the data does not have.
 */
export function formatNumber(v, { decimals = null, compact = false, prefix = '', suffix = '' } = {}) {
  if (!isNum(v)) return '—'
  const abs = Math.abs(v)
  if (compact && abs >= 1000) {
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]
    for (const [base, unit] of units) {
      if (abs >= base) {
        const scaled = v / base
        const d = Math.abs(scaled) < 10 ? 1 : 0
        return prefix + scaled.toFixed(d).replace(/\.0$/, '') + unit + suffix
      }
    }
  }
  const d = decimals === null ? (Number.isInteger(v) ? 0 : abs < 10 ? 2 : abs < 100 ? 1 : 0) : decimals
  return prefix + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) + suffix
}

/** Compact axis labels: 1.2k rather than 1200 on a tick. */
export function formatTick(v, { compact = false } = {}) {
  return formatNumber(v, { compact, decimals: Number.isInteger(v) ? 0 : null })
}

/** Dates at a granularity the reader can scan. */
export function formatDate(t, { granularity = 'day', locale = 'en-CA' } = {}) {
  if (!isNum(t)) return '—'
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return '—'
  const iso = d.toISOString()
  if (granularity === 'year') return iso.slice(0, 4)
  if (granularity === 'month') return iso.slice(0, 7)
  if (granularity === 'minute') return iso.slice(0, 16).replace('T', ' ')
  return iso.slice(0, 10)     // ISO day: sortable, unambiguous, no locale surprises
}

// ────────────────────────────────────────────────────────────── layout

/** Evenly spaced band centres, for bars: the slot a value sits in. */
export function bandScale(count, range, { padding = 0.2 } = {}) {
  const n = Math.max(0, Math.floor(count))
  const [r0, r1] = range
  const width = n ? (r1 - r0) / n : 0
  const inner = width * (1 - Math.max(0, Math.min(0.9, padding)))
  return {
    width,
    band: inner,
    center: (i) => r0 + width * i + width / 2,
    left: (i) => r0 + width * i + (width - inner) / 2,
  }
}

/** Pad a pixel range into [inner, width - inner] style plot area. */
export function plotArea(width, height, { top = 16, right = 16, bottom = 28, left = 52 } = {}) {
  return {
    x: left,
    y: top,
    width: Math.max(1, width - left - right),
    height: Math.max(1, height - top - bottom),
    left, top, right, bottom,
  }
}

// ────────────────────────────────────────────────────────────── svg primitives

/** Escape text going into SVG (chart labels come from data, so they are untrusted). */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/** Round to 2 decimals: keeps the SVG smaller and the diff quieter. */
export function px(v) {
  return Number(num(v, 0).toFixed(2))
}

/**
 * A rounded-top, square-bottom path — one bar segment in a stack.
 * Rounding only the cap makes a stack read as one bar rather than as boxes.
 */
export function barSegmentPath(x, y, w, h, radius = 0, roundTop = true) {
  const rr = Math.max(0, Math.min(radius, w / 2, Math.max(0, h)))
  if (h <= 0) return ''
  if (!roundTop || rr === 0) {
    return `M${px(x)} ${px(y)}h${px(w)}v${px(h)}h${px(-w)}Z`
  }
  return `M${px(x)} ${px(y + h)}V${px(y + rr)}Q${px(x)} ${px(y)} ${px(x + rr)} ${px(y)}` +
    `H${px(x + w - rr)}Q${px(x + w)} ${px(y)} ${px(x + w)} ${px(y + rr)}V${px(y + h)}Z`
}

/** A polyline path through points; empty string when there is nothing to draw. */
export function linePath(points) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => isNum(p.x) && isNum(p.y))
  if (!pts.length) return ''
  return 'M' + pts.map((p) => `${px(p.x)} ${px(p.y)}`).join('L')
}

/** Close a line path into an area down to `baseY`. */
export function areaPath(points, baseY) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => isNum(p.x) && isNum(p.y))
  if (pts.length < 2) return ''
  return linePath(pts) + `L${px(pts[pts.length - 1].x)} ${px(baseY)}L${px(pts[0].x)} ${px(baseY)}Z`
}
