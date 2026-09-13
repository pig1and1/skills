/**
 * Unit tests for the pure core.
 *
 * Run: node --test tests/
 *
 * These exist because the alternative is checking charts by looking at them,
 * which means never actually checking them. Each test below names the real
 * failure it guards: degenerate domains, dirty values, lossy dedup, gaps that
 * must not be bridged.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isNum, num, linearScale, niceTicks, zeroBasedDomain, robustDomain,
  sanitize, sortedBy, collapseBy,
  stack, histogram, boxStats, movingAverage, gapIndices, splitAt, downsample,
  formatNumber, formatDate, bandScale, plotArea,
  esc, px, barSegmentPath, linePath, areaPath,
} from '../src/core.js'

// ─────────────────────────────────────────────── scales

test('linearScale maps endpoints exactly', () => {
  const s = linearScale([0, 100], [0, 200])
  assert.equal(s.scale(0), 0)
  assert.equal(s.scale(100), 200)
  assert.equal(s.scale(50), 100)
})

test('linearScale centres a degenerate domain instead of dividing by zero', () => {
  // All values equal is extremely common (a metric stuck at 0, a constant).
  // The naive formula returns NaN here and the whole chart disappears.
  const s = linearScale([7, 7], [0, 100])
  assert.equal(s.degenerate, true)
  assert.equal(s.scale(7), 50)
  assert.ok(Number.isFinite(s.scale(999)))
})

test('linearScale tolerates non-finite bounds', () => {
  assert.ok(Number.isFinite(linearScale([NaN, Infinity], [0, 10]).scale(1)))
})

test('linearScale normalises a reversed domain but honours a reversed range', () => {
  // A reversed DOMAIN is a caller mistake, so it is normalised.
  const d = linearScale([10, 0], [0, 100])
  assert.equal(d.scale(0), 0)
  assert.equal(d.scale(10), 100)
  // A reversed RANGE is legitimate: it is how a y axis is flipped, since pixel
  // coordinates grow downward.
  const y = linearScale([0, 10], [100, 0])
  assert.equal(y.scale(0), 100)
  assert.equal(y.scale(10), 0)
})

test('linearScale never returns NaN for a garbage value', () => {
  const s = linearScale([0, 10], [0, 100])
  assert.ok(Number.isFinite(s.scale(NaN)))
  assert.ok(Number.isFinite(s.scale(null)))
  assert.ok(Number.isFinite(s.scale(undefined)))
})

// ─────────────────────────────────────────────── ticks

test('niceTicks produces round labels, not float noise', () => {
  const t = niceTicks(0, 1, 5)
  // The failure this guards: 0.30000000000000004 appearing on an axis.
  for (const v of t) assert.equal(Number(v.toFixed(10)), v)
  assert.ok(t.length >= 2)
})

test('niceTicks picks steps from the 1/2/5 ladder', () => {
  assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10])
  // Closest rung, not next-up: 25 -> 20 (six ticks), not 50 (three ticks).
  assert.deepEqual(niceTicks(0, 100, 4), [0, 20, 40, 60, 80, 100])
})

test('niceTicks survives a degenerate or reversed range', () => {
  assert.deepEqual(niceTicks(5, 5), [5])
  assert.ok(niceTicks(10, 0, 4).length > 1)
  assert.ok(niceTicks(NaN, 1).length >= 1)
})

test('zeroBasedDomain always starts at zero and never collapses', () => {
  assert.deepEqual(zeroBasedDomain([5, 10, 2]), [0, 11])
  // All-zero data must still yield a usable domain, not [0, 0].
  const z = zeroBasedDomain([0, 0])
  assert.equal(z[0], 0)
  assert.ok(z[1] > 0)
})

test('robustDomain trims an outlier and reports how many', () => {
  const flat = new Array(999).fill(95)
  flat.push(5)
  const r = robustDomain(flat)
  assert.ok(r.lo > 5, 'the outlier must not drag the lower bound down')
  assert.ok(r.trimmed >= 1, 'the excluded point must be counted, not silently dropped')
})

test('robustDomain on constant data still returns a usable band', () => {
  const r = robustDomain([3, 3, 3])
  assert.ok(r.domain[1] > r.domain[0])
})

// ─────────────────────────────────────────────── hygiene

test('sanitize splits usable rows and reports why the rest failed', () => {
  const rows = [{ v: 1 }, { v: NaN }, { v: null }, { v: 'x' }, { v: 5 }]
  const r = sanitize(rows, { v: (row) => row.v })
  assert.equal(r.rows.length, 2)
  assert.equal(r.rejected, 3)
  assert.equal(r.reasons.v, 3)
})

test('sanitize tolerates a missing or non-array input', () => {
  assert.equal(sanitize(undefined, {}).rows.length, 0)
  assert.equal(sanitize(null, {}).rejected, 0)
})

test('sortedBy is stable and does not mutate its input', () => {
  const rows = [{ t: 2, id: 'b' }, { t: 1, id: 'a' }, { t: 1, id: 'c' }]
  const frozen = JSON.stringify(rows)
  const out = sortedBy(rows, (r) => r.t)
  assert.deepEqual(out.map((r) => r.id), ['a', 'c', 'b'])   // equal keys keep input order
  assert.equal(JSON.stringify(rows), frozen)
})

test('collapseBy averages duplicates rather than dropping them', () => {
  // Two events in the same millisecond are normal in event data.
  const rows = [{ t: 1, v: 10 }, { t: 1, v: 20 }, { t: 2, v: 5 }]
  const out = collapseBy(rows, (r) => r.t, (r) => r.v)
  assert.equal(out.length, 2)
  assert.equal(out[0].value, 15)
  assert.equal(out[0].n, 2)
})

// ─────────────────────────────────────────────── stacking

test('stack accumulates from zero in a stable order', () => {
  const rows = [{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }]
  const out = stack(rows, ['a', 'b', 'c'])
  assert.deepEqual(out[0].segments.map((s) => [s.from, s.to]), [[0, 1], [1, 3], [3, 6]])
  assert.equal(out[0].total, 6)
  assert.equal(out[1].total, 15)
  // Order must be identical in every column or the legend means nothing.
  assert.deepEqual(out[0].segments.map((s) => s.key), out[1].segments.map((s) => s.key))
})

test('stack clamps negatives and survives missing keys', () => {
  const out = stack([{ a: -5, b: 2 }], ['a', 'b', 'c'])
  assert.deepEqual(out[0].segments.map((s) => s.value), [0, 2, 0])
  assert.equal(out[0].total, 2)
})

test('stack handles an empty input without throwing', () => {
  assert.deepEqual(stack([], ['a']), [])
  assert.deepEqual(stack(null, ['a']), [])
})

// ─────────────────────────────────────────────── distributions

test('histogram uses half-open bins [from, to) and closes the last one', () => {
  const h = histogram([0, 5, 10], { bins: 2, domain: [0, 10] })
  assert.equal(h.bins.length, 2)
  // Bins are [0,5) and [5,10]: 0 alone in the first, 5 and the top edge in the second.
  assert.equal(h.bins[0].count, 1)
  assert.equal(h.bins[1].count, 2)
  assert.equal(h.total, 3)
})

test('histogram on constant data still produces bins', () => {
  const h = histogram([7, 7, 7], { bins: 4 })
  assert.equal(h.bins.length, 4)
  assert.equal(h.total, 3)
  assert.ok(h.width > 0)
})

test('histogram separates non-finite from out-of-domain', () => {
  const h = histogram([1, NaN, 100, null], { bins: 2, domain: [0, 10] })
  assert.equal(h.total, 1, 'only the in-domain value is binned')
  assert.equal(h.ignored, 1, '100 is outside the domain and is reported, not silently dropped')
})

test('boxStats computes quartiles and flags outliers', () => {
  const s = boxStats([1, 2, 3, 4, 5, 100])
  assert.equal(s.q1, 2.25)
  assert.equal(s.median, 3.5)
  assert.equal(s.q3, 4.75)
  assert.ok(s.outliers.includes(100))
  assert.equal(s.max, 5)
})

test('boxStats flags low outliers too, not only high ones', () => {
  // Mutation testing found this gap: the original case had a high outlier only,
  // so breaking the LOWER fence changed nothing and the mutant survived.
  const s = boxStats([-100, 1, 2, 3, 4, 5])
  assert.ok(s.outliers.includes(-100), 'a far-below point must be an outlier')
  assert.equal(s.min, 1, 'the whisker stops at the last inlier')
  assert.equal(s.count, 6)

  // Both sides at once.
  const both = boxStats([-500, 1, 2, 3, 4, 5, 900])
  assert.ok(both.outliers.includes(-500))
  assert.ok(both.outliers.includes(900))
  assert.equal(both.min, 1)
  assert.equal(both.max, 5)
})

test('boxStats on empty and single inputs', () => {
  assert.equal(boxStats([]).empty, true)
  const one = boxStats([42])
  assert.equal(one.median, 42)
  assert.equal(one.min, 42)
  assert.equal(one.max, 42)
  assert.equal(one.outliers.length, 0)
})

test('boxStats on identical values has no spurious outliers', () => {
  const s = boxStats([5, 5, 5, 5])
  assert.equal(s.iqr, 0)
  assert.equal(s.outliers.length, 0)
})

// ─────────────────────────────────────────────── series

test('movingAverage never emits NaN at the head', () => {
  const ma = movingAverage([1, 2, 3, 4], 2)
  assert.deepEqual(ma, [1, 1.5, 2.5, 3.5])
  assert.ok(ma.every(Number.isFinite))
})

test('movingAverage tolerates dirty input', () => {
  const ma = movingAverage([1, NaN, 3], 2)
  assert.ok(ma.every(Number.isFinite))
})

test('gapIndices finds a real gap and ignores regular spacing', () => {
  const even = [0, 1000, 2000, 3000, 4000]
  assert.deepEqual(gapIndices(even), [])
  const gapped = [0, 1000, 2000, 100000, 101000]
  assert.deepEqual(gapIndices(gapped), [3])
})

test('gapIndices needs at least three points', () => {
  assert.deepEqual(gapIndices([0, 99]), [])
  assert.deepEqual(gapIndices([]), [])
})

test('splitAt breaks a series at the cuts', () => {
  const parts = splitAt([1, 2, 3, 4, 5], [2, 4])
  assert.deepEqual(parts, [[1, 2], [3, 4], [5]])
  assert.deepEqual(splitAt([1, 2, 3], []), [[1, 2, 3]])
})

test('downsample reduces point count and keeps the shape', () => {
  const points = Array.from({ length: 5000 }, (_, i) => ({ t: i, value: i === 2500 ? 1000 : 1 }))
  const d = downsample(points, 500)
  assert.ok(d.points.length <= 500)
  assert.equal(d.sampled, true)
  assert.ok(d.factor > 1)
  // The spike must still lift its bucket, i.e. the shape survives.
  const peak = Math.max(...d.points.map((p) => p.value))
  assert.ok(peak > 1)
})

test('downsample is a no-op below the threshold', () => {
  const d = downsample([{ t: 1, value: 1 }], 700)
  assert.equal(d.sampled, false)
  assert.equal(d.factor, 1)
})

// ─────────────────────────────────────────────── formatting

test('formatNumber uses separators and drops false precision', () => {
  assert.equal(formatNumber(1240000), '1,240,000')
  assert.equal(formatNumber(3.14159, { decimals: 1 }), '3.1')
  assert.equal(formatNumber(94.23671, { decimals: 1 }), '94.2')
  assert.equal(formatNumber(NaN), '—')
})

test('formatNumber compact form', () => {
  assert.equal(formatNumber(1240000, { compact: true }), '1.2M')
  assert.equal(formatNumber(1500, { compact: true }), '1.5k')
  assert.equal(formatNumber(999, { compact: true }), '999')
})

test('formatDate is sortable and unambiguous', () => {
  const t = Date.parse('2026-08-01T05:00:00Z')
  assert.equal(formatDate(t), '2026-08-01')
  assert.equal(formatDate(t, { granularity: 'month' }), '2026-08')
  assert.equal(formatDate(NaN), '—')
})

// ─────────────────────────────────────────────── layout

test('bandScale centres bands and keeps them inside the range', () => {
  const b = bandScale(4, [0, 100], { padding: 0.5 })
  assert.equal(b.center(0), 12.5)
  assert.equal(b.center(3), 87.5)
  assert.ok(b.band > 0 && b.band < b.width)
})

test('bandScale on zero items does not produce NaN', () => {
  const b = bandScale(0, [0, 100])
  assert.ok(Number.isFinite(b.center(0)))
})

test('plotArea clamps to at least one pixel', () => {
  const a = plotArea(10, 10, { left: 50, right: 50 })
  assert.ok(a.width >= 1)
  assert.ok(a.height >= 1)
})

// ─────────────────────────────────────────────── svg primitives

test('esc neutralises markup from data', () => {
  // Chart labels come from data, and data is untrusted.
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;')
  assert.equal(esc("it's"), 'it&#39;s')
  assert.equal(esc(null), '')
})

test('px rounds and survives garbage', () => {
  assert.equal(px(1.23456), 1.23)
  assert.equal(px(NaN), 0)
})

test('barSegmentPath rounds only the cap', () => {
  const square = barSegmentPath(0, 0, 10, 10, 0, false)
  assert.ok(square.startsWith('M0 0'))
  const capped = barSegmentPath(0, 0, 10, 10, 3, true)
  assert.ok(capped.includes('Q'), 'a capped segment must use a curve')
  assert.equal(barSegmentPath(0, 0, 10, 0, 3, true), '', 'zero-height segments draw nothing')
})

test('linePath and areaPath reject unusable points', () => {
  assert.equal(linePath([]), '')
  assert.equal(linePath([{ x: NaN, y: 1 }]), '')
  assert.equal(linePath([{ x: 0, y: 0 }, { x: 1, y: 1 }]), 'M0 0L1 1')
  assert.equal(areaPath([{ x: 0, y: 0 }], 10), '', 'an area needs two points')
  assert.ok(areaPath([{ x: 0, y: 0 }, { x: 1, y: 1 }], 10).endsWith('Z'))
})

// ─────────────────────────────────────────────── helpers

test('isNum and num behave for the values that actually show up', () => {
  assert.equal(isNum(0), true)
  assert.equal(isNum(NaN), false)
  assert.equal(isNum(Infinity), false)
  assert.equal(isNum('5'), false)
  assert.equal(num(undefined, 7), 7)
  assert.equal(num(Infinity, 7), 7)
})
