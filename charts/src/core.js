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

// ────────────────────────────────────────────────────────────── pipeline

/**
 * The full data pipeline every series chart runs, as one pure function.
 *
 * Round 1 of testing found this living inside the renderer's closure, where it
 * could not be reached by a test. That is the whole reason it now sits here:
 * a chart's data handling is the part most likely to be wrong and the part
 * hardest to eyeball, so it must be callable without a DOM.
 *
 * Order matters and is not arbitrary:
 *   sanitize   – drop values that are not finite, and count them
 *   sort       – the input order is not trustworthy
 *   collapse   – duplicate timestamps average rather than fight for position
 *   downsample – only after collapsing, or buckets would be skewed by dupes
 *   domain     – fitted or zero-based, never degenerate
 *
 * @param {Array<{t:number,value:number}>} input
 * @param {object} [options]
 * @param {number} [options.maxPoints=700]
 * @param {boolean} [options.zeroBased=false]  true for bars, false for lines
 * @param {boolean} [options.robust=false]     trim outliers (fitted domains only)
 * @param {number} [options.trimLow=0.01]
 * @param {number} [options.trimHigh=0.99]
 * @param {(v:number)=>number} [options.floor] optional lower clamp (0 for counts)
 */
export function prepareSeries(input, options = {}) {
  const list = Array.isArray(input) ? input : []
  const maxPoints = Math.max(1, num(options.maxPoints, 700))

  const clean = sanitize(list, {
    t: (p) => p && p.t,
    value: (p) => p && p.value,
  })

  const sorted = sortedBy(clean.rows, (p) => p.t)
  const collapsedAll = collapseBy(sorted, (p) => p.t, (p) => p.value)
    .map((c) => ({ t: c.key, value: options.floor ? options.floor(c.value) : c.value, n: c.n }))

  const down = downsample(collapsedAll, maxPoints, (p) => p.t)
  const points = down.points

  let domain = [0, 1]
  let trimmed = 0
  if (points.length) {
    const values = points.map((p) => p.value)
    if (options.zeroBased) {
      domain = zeroBasedDomain(values)
    } else if (options.robust) {
      const r = robustDomain(values, {
        low: num(options.trimLow, 0.01),
        high: num(options.trimHigh, 0.99),
      })
      domain = r.domain
      trimmed = r.trimmed
    } else {
      const lo = Math.min(...values)
      const hi = Math.max(...values)
      const pad = (hi - lo) * 0.12
      domain = (hi - lo > 1e-12) ? [lo - pad, hi + pad] : [lo - 1, hi + 1]
    }
  }

  return {
    points,
    domain,
    /** How many input rows were unusable, and why. Surface this to the user. */
    rejected: clean.rejected,
    reasons: clean.reasons,
    /** Duplicate timestamps that were merged. */
    merged: collapsedAll.length < sorted.length,
    collapsed: collapsedAll.length,
    sampled: down.sampled,
    factor: down.factor,
    trimmed,
    empty: points.length === 0,
  }
}

/** True when a series has holes big enough that a continuous line would lie. */
export function seriesHasGaps(points, options = {}) {
  const list = Array.isArray(points) ? points : []
  if (list.length < 3) return false
  return gapIndices(list.map((p) => p.t), options).length > 0
}

/**
 * Are the samples evenly spaced in time?
 *
 * This decides whether a line chart should draw a marker at every point.
 * Evenly spaced data gains nothing from markers -- the spacing carries no
 * information, so dots are pure noise, and at a few hundred points they are
 * overwhelming. Unevenly spaced data is the opposite: the reader has to see
 * where the samples actually are, or the line silently implies a regularity
 * that is not there.
 *
 * @param {Array<{t:number}>} points already sorted
 * @param {number} [tolerance=0.15] relative deviation still counted as "even"
 * @param {number} [minShare=0.9] share of gaps that must sit inside tolerance
 */
export function intervalsAreEven(points, { tolerance = 0.15, minShare = 0.9 } = {}) {
  const list = Array.isArray(points) ? points : []
  if (list.length < 4) return true       // too few points for spacing to read as a pattern
  const deltas = []
  for (let i = 1; i < list.length; i++) {
    if (!isNum(list[i].t) || !isNum(list[i - 1].t)) return false
    deltas.push(list[i].t - list[i - 1].t)
  }
  const sorted = deltas.slice().sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1]
  if (!(median > 0)) return false        // all at one timestamp: nothing to be even about
  const inside = deltas.filter((d) => Math.abs(d - median) <= median * tolerance).length
  return inside / deltas.length >= minShare
}

/**
 * Should this series draw a marker at every point?
 *
 * Two separate reasons to show where the samples are, and they are not the same
 * thing:
 *   - spacing is irregular (the gaps between samples carry information), or
 *   - there is a hole (the line would otherwise run across missing data).
 *
 * A single hole does NOT make the spacing irregular -- every other interval can
 * still be identical -- so testing regularity alone would miss it.
 */
export function wantsPointMarkers(points, { few = 20, tolerance = 0.15 } = {}) {
  const list = Array.isArray(points) ? points : []
  if (list.length <= few) return true
  if (!intervalsAreEven(list, { tolerance })) return true
  return gapIndices(list.map((p) => p.t)).length > 0
}


/**
 * Human-readable numbers.
 *
 * Round numbers and thousands separators are not cosmetic: "1240000.0" reads as
 * a raw debug print, and three decimal places on a count implies a precision
 * the data does not have.
 */
// ────────────────────────────────────────────────────────────── formatting

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

// ────────────────────────────────────────────────────────────── sequential colour scale

/**
 * The one scale the other charts did not need: an ORDERED ramp from a numeric
 * domain to a bin index. A heatmap cannot be drawn without it.
 *
 * Everything here returns NUMBERS -- edges, indices, counts. None of it knows
 * what colour bin 3 is. The renderer owns that mapping, which keeps theme.css
 * the only place in the package where a colour exists, and it is why the
 * binning can be tested without a browser.
 *
 * The decision with real consequences is equal-interval vs quantile bins, and it
 * is not a matter of taste:
 *
 *   equal intervals  the legend's numbers are evenly spaced, so a reader can
 *                    interpolate between them. Right when the values are spread
 *                    fairly evenly across the domain.
 *   quantile         each bin holds roughly the same NUMBER OF CELLS, so the
 *                    ramp resolves the bulk of the data instead of the tail. The
 *                    legend's numbers are then unevenly spaced -- which is
 *                    visible rather than hidden, because the legend prints the
 *                    real edges.
 *
 * One value at 1000 with a thousand values between 1 and 10: equal bins put
 * 99.9% of the cells in bin 0 and the chart is a single flat colour; quantile
 * bins put about 20% in each. So the choice is made by MEASURING what equal
 * intervals would actually do (distributionShape reports the fullest equal bin)
 * rather than by guessing from a skew number. colorBins() reports which method
 * it used, why, and -- when quantile was chosen and did not help -- that it
 * changed its mind.
 */

/** `n` evenly spaced edges spanning [lo, hi]. */
function evenEdges(lo, hi, n) {
  const out = []
  for (let i = 0; i <= n; i++) out.push(lo + ((hi - lo) * i) / n)
  return out
}

/** Strictly ascending edges: identical neighbours would mean an empty bin. */
function dedupeEdges(list) {
  const kept = []
  for (const e of list) {
    const v = Number(e)
    if (!isNum(v)) continue
    if (!kept.length || v > kept[kept.length - 1] + 1e-12) kept.push(v)
  }
  return { edges: kept, collapse: list.length - kept.length }
}

/** Population of each half-open bin, plus how many values fell outside the span. */
function countBins(edges, values) {
  const scale = stepScale(edges)
  const size = Math.max(1, edges.length - 1)
  const counts = new Array(size).fill(0)
  let outside = 0
  for (const v of values) {
    if (v < edges[0] || v > edges[edges.length - 1]) outside += 1
    counts[Math.min(size - 1, Math.max(0, scale.step(v)))] += 1
  }
  return { counts, outside }
}

/** Share of the values in the fullest bin -- the measure the choice is made on. */
function maxShare(counts) {
  const total = counts.reduce((a, b) => a + b, 0)
  return total ? Math.max(...counts) / total : 0
}

/**
 * Linear-interpolation quantile -- the same convention boxStats uses, so
 * quantile(values, 0.25) equals boxStats(values).q1.
 */
export function quantile(values, q = 0.5) {
  const clean = (Array.isArray(values) ? values : []).filter(isNum).slice().sort((a, b) => a - b)
  if (!clean.length) return NaN
  const qq = Math.min(1, Math.max(0, num(q, 0)))
  const pos = (clean.length - 1) * qq
  const base = Math.floor(pos)
  const rest = pos - base
  const next = clean[base + 1]
  return next === undefined ? clean[base] : clean[base] + rest * (next - clean[base])
}

/**
 * The distribution facts that decide how a ramp should be cut.
 *
 * `probeCounts` is the population of `probeBins` EQUAL-interval bins over the
 * span. That is the measurement chooseBinMethod() reads: it is what equal bins
 * would really do to this data, which is a far better predictor than any single
 * skew statistic. (The IQR fence is still reported, because a caller showing
 * "N outliers" is useful -- it just no longer decides the binning on its own.)
 *
 * `skew` is the quartile (Bowley) skewness, (q3 + q1 - 2*median) / iqr: 0 for a
 * symmetric spread, positive when the tail runs high. One absurd outlier cannot
 * decide it, unlike the moment skewness.
 *
 * @param {number[]} values
 * @param {object} [options]
 * @param {number} [options.probeBins=5] bin count the occupancy is measured at
 * @param {[number,number]} [options.domain] measure inside a forced span
 */
export function distributionShape(values, options = {}) {
  const clean = (Array.isArray(values) ? values : []).filter(isNum)
  const probes = Math.max(1, Math.floor(num(options.probeBins, 5)))
  if (!clean.length) {
    return {
      empty: true, count: 0, min: NaN, max: NaN,
      q1: NaN, median: NaN, q3: NaN, iqr: 0,
      skew: 0, outliers: 0, outlierShare: 0, distinct: 0,
      probeBins: probes, probeCounts: new Array(probes).fill(0), probeMaxShare: 0,
    }
  }
  const stats = boxStats(clean)                    // reuse: quartiles and the IQR fences
  const sorted = clean.slice().sort((a, b) => a - b)
  const skew = stats.iqr > 1e-12 ? (stats.q3 + stats.q1 - 2 * stats.median) / stats.iqr : 0

  const given = Array.isArray(options.domain) && isNum(options.domain[0]) && isNum(options.domain[1])
    ? [Math.min(options.domain[0], options.domain[1]), Math.max(options.domain[0], options.domain[1])]
    : null
  let lo = given ? given[0] : sorted[0]
  let hi = given ? given[1] : sorted[sorted.length - 1]
  // A degenerate span has to be expanded, exactly as colorBins does, or the
  // probe would divide by zero and report a meaningless occupancy.
  if (!(hi - lo > 1e-12)) {
    const mid = (lo + hi) / 2
    lo = mid - 0.5
    hi = mid + 0.5
  }
  const probeCounts = countBins(evenEdges(lo, hi, probes), clean).counts

  return {
    empty: false,
    count: stats.count,
    // boxStats' own min/max are WHISKER ends -- they stop at the last inlier. A
    // ramp must span the real extremes, or the winning outlier lands outside the
    // scale and gets painted as if it were an ordinary low value.
    min: sorted[0],
    max: sorted[sorted.length - 1],
    q1: stats.q1, median: stats.median, q3: stats.q3, iqr: stats.iqr,
    skew,
    outliers: stats.outliers.length,
    outlierShare: stats.outliers.length / stats.count,
    distinct: new Set(clean).size,
    probeBins: probes,
    probeCounts,
    probeMaxShare: maxShare(probeCounts),
  }
}

/**
 * Equal-interval or quantile? Answered from the measured occupancy, with the
 * reason attached.
 *
 * The default stays equal intervals whenever they are affordable, because evenly
 * spaced legend numbers are easier to read and to interpolate. Quantile is
 * chosen only when equal bins would visibly fail -- when the fullest equal bin
 * would swallow more than `maxBinShare` of the cells, which is the same thing as
 * saying most of the ramp would carry no information.
 *
 * @param {object} shape as returned by distributionShape()
 * @param {object} [options]
 * @param {number} [options.maxBinShare=0.5]
 * @returns {{method:'equal'|'quantile', reason:string, detail:string}}
 */
export function chooseBinMethod(shape, options = {}) {
  const limit = Math.min(1, Math.max(0.05, num(options.maxBinShare, 0.5)))
  if (!shape || shape.empty) {
    return { method: 'equal', reason: 'empty', detail: 'no usable values, so the ramp falls back to an even 0-1 span' }
  }
  if (!(shape.max - shape.min > 1e-12)) {
    return { method: 'equal', reason: 'degenerate', detail: 'every value is identical, so the domain is expanded around it' }
  }
  if (shape.distinct <= 2) {
    return {
      method: 'equal', reason: 'discrete',
      detail: `${shape.distinct} distinct value(s): quantile edges would land on top of each other and collapse the ramp`,
    }
  }
  const share = num(shape.probeMaxShare, 0)
  const bins = num(shape.probeBins, 5)
  if (share > limit) {
    return {
      method: 'quantile', reason: 'imbalance',
      detail: `with equal intervals the fullest of ${bins} bins would hold ${(share * 100).toFixed(1)}% of the cells (limit ${(limit * 100).toFixed(0)}%), so most of the ramp would say nothing`,
    }
  }
  return {
    method: 'equal', reason: 'even',
    detail: `the fullest of ${bins} equal-interval bins holds ${(share * 100).toFixed(1)}% of the cells, so evenly spaced legend numbers are affordable`,
  }
}

/**
 * Cut a value list into colour bins.
 *
 * Returns the edges (so a legend can print the real numbers), the population of
 * each bin, and which method was used and why. Nothing is dropped silently:
 * values outside a caller-supplied domain are counted in `outside`, and quantile
 * edges that collapse onto duplicate values are reported in `collapse` with the
 * reduced bin count -- "5 classes" that is really 3 classes must not be
 * advertised as 5.
 *
 * @param {number[]} values
 * @param {object} [options]
 * @param {number} [options.bins=5]
 * @param {'auto'|'equal'|'quantile'} [options.method='auto']
 * @param {number} [options.maxBinShare=0.5] occupancy that tips the automatic choice
 * @param {[number,number]} [options.domain] force the span, so the ramp does not
 *        move when the caller filters or when two heatmaps are compared
 */
export function colorBins(values, options = {}) {
  const clean = (Array.isArray(values) ? values : []).filter(isNum).slice().sort((a, b) => a - b)
  const requested = Math.max(1, Math.floor(num(options.bins, 5)))
  const given = Array.isArray(options.domain) && isNum(options.domain[0]) && isNum(options.domain[1])
    ? [Math.min(options.domain[0], options.domain[1]), Math.max(options.domain[0], options.domain[1])]
    : null

  // The probe is measured at the bin count actually being chosen, so the number
  // in `detail` is the number this data would really produce.
  const shape = distributionShape(clean, { probeBins: requested, domain: given })

  let lo = given ? given[0] : (shape.empty ? 0 : shape.min)
  let hi = given ? given[1] : (shape.empty ? 1 : shape.max)
  const degenerate = !(hi - lo > 1e-12)
  if (degenerate) {
    // Every value identical, or a single value. Expand around it rather than
    // divide by ~zero, so a constant column still renders instead of vanishing.
    const mid = (lo + hi) / 2
    lo = mid - 0.5
    hi = mid + 0.5
  }

  const forced = options.method === 'equal' || options.method === 'quantile'
  const auto = chooseBinMethod(shape, { maxBinShare: num(options.maxBinShare, 0.5) })
  let method = forced ? options.method : auto.method
  let reason = forced ? 'forced' : auto.reason
  let detail = forced ? `method "${options.method}" was requested explicitly` : auto.detail
  if (degenerate) {
    method = 'equal'
    reason = 'degenerate'
    detail = 'every value is identical, so the domain is expanded around it instead of dividing by zero'
  }

  let edges = dedupeEdges(evenEdges(lo, hi, requested)).edges
  let measured = countBins(edges, clean)
  let collapse = 0

  if (method === 'quantile') {
    const wanted = []
    for (let i = 0; i <= requested; i++) wanted.push(quantile(clean, i / requested))
    wanted[0] = lo
    wanted[wanted.length - 1] = hi
    const candidate = dedupeEdges(wanted)
    if (candidate.edges.length < 2) {
      // Not a preference: fewer than two edges is not a scale.
      method = 'equal'
      reason = 'collapse'
      detail = 'every quantile edge landed on the same value, so the ramp fell back to equal intervals'
    } else {
      const tried = countBins(candidate.edges, clean)
      // Ties can make quantile bins lumpier than equal bins. Choosing quantile
      // and then delivering a flatter ramp is not a defensible trade, so an
      // automatic choice is measured against the candidate it replaces. An
      // explicit method is honoured -- the caller may have reasons.
      if (!forced && maxShare(tried.counts) >= maxShare(measured.counts)) {
        method = 'equal'
        reason = 'no-gain'
        detail = `quantile bins would have peaked at ${(maxShare(tried.counts) * 100).toFixed(1)}% against ${(maxShare(measured.counts) * 100).toFixed(1)}% for equal intervals, so equal intervals were kept`
      } else {
        edges = candidate.edges
        measured = tried
        collapse = candidate.collapse
      }
    }
  }

  const counts = measured.counts
  return {
    edges,
    bins: edges.length - 1,
    requested,
    /** Bins lost because quantile edges landed on duplicate values. */
    collapse,
    method,
    reason,
    detail,
    domain: [lo, hi],
    counts,
    total: counts.reduce((a, b) => a + b, 0),
    /** Values outside a caller-supplied domain; they are clamped, and counted. */
    outside: measured.outside,
    outliers: shape.outliers,
    outlierShare: shape.outlierShare,
    probeMaxShare: shape.probeMaxShare,
    degenerate,
    empty: shape.empty,
    shape,
  }
}

/**
 * Value -> bin index for a set of edges, the way linearScale is domain -> pixel.
 *
 * A non-finite value returns NULL, never 0, and that is the whole point: bin 0
 * is the ramp's weakest step, so "no measurement" would otherwise be painted as
 * "the lowest measurement". The caller has to handle null explicitly, and that
 * is how missing data gets its own visual state instead of joining the ramp.
 *
 * Bins are half-open, [e[i], e[i+1]), with the top edge inside the last bin.
 */
export function stepScale(edges) {
  const cleaned = (Array.isArray(edges) ? edges : []).filter(isNum).slice().sort((a, b) => a - b)
  const kept = []
  for (const v of cleaned) {
    if (!kept.length || v > kept[kept.length - 1] + 1e-12) kept.push(v)
  }
  const fellBack = kept.length < 2
  const list = fellBack ? [0, 1] : kept      // nothing usable: still a renderable scale

  const count = list.length - 1        // number of bins
  const top = count - 1                // index of the last bin
  return {
    edges: list,
    count,
    /** True when the edges were unusable and a 0-1 ramp had to be substituted. */
    degenerate: fellBack,
    step(v) {
      if (!isNum(v)) return null                    // missing is never the lowest step
      if (v <= list[0]) return 0
      if (v >= list[count]) return top
      for (let i = count - 1; i >= 1; i--) if (v >= list[i]) return i
      return 0
    },
  }
}
