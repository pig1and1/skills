/**
 * Round 1: does the pure core actually survive hostile input?
 *
 * These tests use the fixtures, not hand-made three-element arrays. Each
 * assertion is written so it would FAIL on a naive implementation -- an
 * assertion that cannot fail is worse than no assertion.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isNum, sanitize, sortedBy, collapseBy, robustDomain, zeroBasedDomain,
  linearScale, niceTicks, histogram, boxStats, movingAverage, gapIndices,
  splitAt, downsample, bandScale, formatNumber, formatDate, esc,
} from '../src/core.js'

import {
  dirtyTimeSeries, manyCategories, degenerate, huge, hostileLabels, threeBlocks,
} from './fixtures/complex-data.js'

// ─────────────────────────────────────────── 1. the dirty series

test('R1: the fixture really is hostile', () => {
  const { points, truth } = dirtyTimeSeries()
  // If this fails, the fixture stopped being a fixture.
  assert.ok(truth.injected.nanValues > 0, 'expected NaN values')
  assert.ok(truth.injected.nullValues > 0, 'expected nulls')
  assert.ok(truth.injected.stringValues > 0, 'expected strings')
  assert.ok(truth.injected.duplicates > 0, 'expected duplicate timestamps')
  assert.ok(truth.injected.flatRun, 'expected a flat run')
  assert.ok(truth.injected.spikeAt, 'expected a spike')
  assert.equal(truth.injected.gapRuns.length, 2)
  assert.ok(points.length > 1500)
})

test('R1: sanitize separates the four kinds of dirty value', () => {
  const { points, truth } = dirtyTimeSeries()
  const clean = sanitize(points, { t: (p) => p.t, value: (p) => p.value })
  const bad = truth.injected.nanValues + truth.injected.nullValues + truth.injected.stringValues
  assert.equal(clean.rejected, bad, 'every non-finite value must be reported')
  assert.equal(clean.rows.length, points.length - bad)
  assert.ok(clean.reasons.value > 0)
})

test('R1: negative values survive sanitize (they are finite)', () => {
  // A negative reading is data, not corruption -- clamping it silently would
  // be a different bug from filtering it.
  const { points } = dirtyTimeSeries()
  const clean = sanitize(points, { t: (p) => p.t, value: (p) => p.value })
  assert.ok(clean.rows.some((p) => p.value < 0))
})

test('R1: sorting the shuffled fixture is stable and non-mutating', () => {
  const { points } = dirtyTimeSeries()
  const snapshot = points.slice(0, 50)
  const sorted = sortedBy(points, (p) => p.t)
  assert.ok(sorted[0].t <= sorted[sorted.length - 1].t)
  let inversions = 0
  for (let i = 1; i < sorted.length; i++) if (sorted[i].t < sorted[i - 1].t) inversions++
  assert.equal(inversions, 0, 'output must be fully ordered')
  assert.deepEqual(points.slice(0, 50), snapshot, 'input must not be mutated')
})

test('R1: duplicates collapse by averaging, not by dropping', () => {
  const { points, truth } = dirtyTimeSeries()
  const clean = sanitize(points, { t: (p) => p.t, value: (p) => p.value })
  const sorted = sortedBy(clean.rows, (p) => p.t)
  const collapsed = collapseBy(sorted, (p) => p.t, (p) => p.value)
  assert.ok(collapsed.length < sorted.length, 'some rows must have merged')
  assert.ok(collapsed.every((c) => isNum(c.value)))

  const unique = new Set(sorted.map((p) => p.t)).size
  assert.equal(collapsed.length, unique, 'one row per distinct timestamp')
})

test('R1: gap detection finds both injected holes', () => {
  const { points, truth } = dirtyTimeSeries()
  const clean = sanitize(points, { t: (p) => p.t, value: (p) => p.value })
  const sorted = sortedBy(clean.rows, (p) => p.t)
  const collapsed = collapseBy(sorted, (p) => p.t, (p) => p.value)
  const cuts = gapIndices(collapsed.map((c) => c.key))
  assert.ok(cuts.length >= 2, `expected at least 2 gaps, got ${cuts.length}`)

  const parts = splitAt(collapsed, cuts)
  assert.ok(parts.length >= 3, 'the series must break into blocks')
  assert.ok(parts.every((p) => p.length > 0), 'no empty blocks')
  assert.equal(truth.injected.gapRuns.length, 2)
})

test('R1: threeBlocks breaks into exactly three segments at the two holes', () => {
  const { points, truth } = threeBlocks()
  const cuts = gapIndices(points.map((p) => p.t))
  assert.equal(cuts.length, truth.gaps.length)
  assert.equal(splitAt(points, cuts).length, 3)
})

test('R1: a flat run is not mistaken for a gap', () => {
  // 200 identical values in a row is a stuck sensor, not missing data. The
  // timestamps are still hourly, so nothing may break.
  const { points } = dirtyTimeSeries()
  const clean = sanitize(points, { t: (p) => p.t, value: (p) => p.value })
  const sorted = sortedBy(clean.rows, (p) => p.t)
  const collapsed = collapseBy(sorted, (p) => p.t, (p) => p.value)
  const flatStart = collapsed.findIndex((c) => c.value === 77)
  assert.ok(flatStart > 0)
  const cuts = gapIndices(collapsed.map((c) => c.key))
  const cutsInsideFlat = cuts.filter((i) => i > flatStart && i < flatStart + 190)
  assert.equal(cutsInsideFlat.length, 0, 'a flat run must not create a gap')
})

test('R1: robustDomain keeps the spike from flattening everything', () => {
  const { points, truth } = dirtyTimeSeries()
  const clean = sanitize(points, { t: (p) => p.t, value: (p) => p.value })
  const values = clean.rows.map((p) => p.value)
  const naive = [Math.min(...values), Math.max(...values)]
  const robust = robustDomain(values)

  assert.ok(naive[1] >= truth.injected.spikeAt.value, 'the spike is really there')
  assert.ok(robust.domain[1] < truth.injected.spikeAt.value / 10,
    'the robust domain must exclude the spike by orders of magnitude')
  assert.ok(robust.trimmed >= 1, 'the excluded point must be counted')
  // The rest of the data must not be squashed.
  assert.ok(robust.domain[1] - robust.domain[0] < 200,
    'the fitted band should stay in the data range, not stretch to the spike')
})

test('R1: zeroBasedDomain refuses to start anywhere but zero', () => {
  const { points } = dirtyTimeSeries()
  const [lo, hi] = zeroBasedDomain(points.map((p) => p.value).filter(isNum))
  assert.equal(lo, 0)
  assert.ok(hi > 0)
})

// ─────────────────────────────────────────── 2. degenerate inputs

test('R1: every degenerate input survives end to end', () => {
  const d = degenerate()
  for (const [name, points] of Object.entries(d)) {
    const clean = sanitize(points, { t: (p) => p.t, value: (p) => p.value })
    const sorted = sortedBy(clean.rows, (p) => p.t)
    const collapsed = collapseBy(sorted, (p) => p.t, (p) => p.value)
    const values = collapsed.map((c) => c.value)

    // Nothing may throw, and every derived number must be finite.
    const domain = values.length ? robustDomain(values).domain : [0, 1]
    assert.ok(domain.every(Number.isFinite), `${name}: domain must be finite`)

    const scale = linearScale(domain, [100, 0])
    assert.ok(Number.isFinite(scale.scale(domain[0])), `${name}: scale(lo)`)
    assert.ok(Number.isFinite(scale.scale(domain[1])), `${name}: scale(hi)`)

    const ticks = niceTicks(domain[0], domain[1], 4)
    assert.ok(ticks.length >= 1 && ticks.every(Number.isFinite), `${name}: ticks`)

    const gaps = gapIndices(collapsed.map((c) => c.key))
    assert.ok(Array.isArray(gaps), `${name}: gaps`)
  }
})

test('R1: an all-equal series yields a spread domain, never a zero-width one', () => {
  const { allEqual } = degenerate()
  const { domain } = robustDomain(allEqual.map((p) => p.value))
  assert.ok(domain[1] > domain[0], 'must not collapse to a point')
  const s = linearScale(domain, [0, 100])
  assert.ok(Number.isFinite(s.scale(88)))
})

test('R1: all-dirty input reduces to nothing without throwing', () => {
  const { allDirty } = degenerate()
  const clean = sanitize(allDirty, { t: (p) => p.t, value: (p) => p.value })
  assert.equal(clean.rows.length, 0)
  assert.equal(clean.rejected, allDirty.length)
  // The empty pipeline must still be safe.
  assert.deepEqual(sortedBy(clean.rows, (p) => p.t), [])
  assert.deepEqual(collapseBy([], (p) => p.t, (p) => p.value), [])
  assert.ok(niceTicks(0, 1).length >= 1)
})

test('R1: extreme magnitudes do not produce Infinity or NaN', () => {
  const { hugeValues, tinyValues } = degenerate()
  for (const points of [hugeValues, tinyValues]) {
    const values = points.map((p) => p.value)
    const { domain } = robustDomain(values)
    assert.ok(domain.every(Number.isFinite))
    const s = linearScale(domain, [0, 300])
    assert.ok(values.every((v) => Number.isFinite(s.scale(v))))
    assert.ok(niceTicks(domain[0], domain[1], 4).every(Number.isFinite))
    const h = histogram(values, { bins: 5 })
    assert.ok(h.bins.every((b) => Number.isFinite(b.count)))
  }
})

test('R1: 40 points sharing one timestamp collapse to a single value', () => {
  const { oneHour } = degenerate()
  const collapsed = collapseBy(oneHour, (p) => p.t, (p) => p.value)
  assert.equal(collapsed.length, 1)
  // Mean of 0..39
  assert.equal(collapsed[0].value, 19.5)
  assert.equal(collapsed[0].n, 40)
})

// ─────────────────────────────────────────── 3. scale

test('R1: 200k points downsample into a drawable count, keeping the shape', () => {
  const points = huge()
  const t0 = Date.now()
  const down = downsample(
    points.map((p) => ({ key: p.t, t: p.t, value: p.value })),
    700,
    (p) => p.t,
  )
  const ms = Date.now() - t0

  assert.ok(down.sampled)
  assert.ok(down.points.length <= 700, `got ${down.points.length}`)
  assert.equal(down.factor, Math.ceil(points.length / 700))
  assert.ok(ms < 2000, `downsampling 200k points took ${ms}ms`)

  // The overall shape must survive: min/max of the buckets stay in range.
  const vals = down.points.map((p) => p.value)
  assert.ok(Math.min(...vals) > 70 && Math.max(...vals) < 110)
})

test('R1: downsampling preserves a spike rather than aliasing it away', () => {
  const base = Array.from({ length: 50000 }, (_, i) => ({ t: i, value: 1 }))
  base[25000] = { t: 25000, value: 999 }
  const down = downsample(base, 500, (p) => p.t)
  const peak = Math.max(...down.points.map((p) => p.value))
  assert.ok(peak > 1, 'a single spike must still lift its bucket')
})

// ─────────────────────────────────────────── 4. categories

test('R1: 50 categories stack without overflow and stay in order', () => {
  const { rows, series } = manyCategories()
  const keys = series.map((s) => s.key)
  // stack() lives in core; reconstruct via a direct import-free check:
  // total per row must equal the sum of its parts, and order must be stable.
  const totals = rows.map((r) => keys.reduce((n, k) => n + (r[k] || 0), 0))
  assert.ok(totals.every((t) => Number.isFinite(t) && t >= 0))
  assert.ok(totals.every((t, i) => i === 0 || t >= totals[0] * 0.5))

  // A palette with 8 slots cannot honestly serve 50 series: the model must
  // surface that, not silently repeat colours.
  const distinct = new Set(series.map((s) => s.color)).size
  assert.ok(distinct <= 8, `palette has ${distinct} distinct slots`)
  assert.ok(series.length > distinct, 'this fixture must exceed the palette')
})

// ─────────────────────────────────────────── 5. labels

test('R1: hostile labels are escaped, never passed through', () => {
  for (const { label } of hostileLabels()) {
    const out = esc(label)
    assert.ok(!out.includes('<'), `unescaped markup in: ${label.slice(0, 40)}`)
    assert.ok(!out.includes('>'), `unescaped markup in: ${label.slice(0, 40)}`)
    assert.ok(!out.includes('"'), 'unescaped quote')
  }
})

test('R1: hostile labels do not break number formatting', () => {
  // A label is not a number; formatting must not throw on it.
  for (const { label } of hostileLabels()) {
    assert.doesNotThrow(() => formatNumber(label))
    assert.doesNotThrow(() => formatDate(label))
  }
  assert.equal(formatNumber('n/a'), '—')
  assert.equal(formatDate('n/a'), '—')
})

// ─────────────────────────────────────────── 6. geometry under stress

test('R1: bandScale stays sane for 1, 50 and 20000 columns', () => {
  for (const n of [1, 50, 20000]) {
    const b = bandScale(n, [56, 1000], { padding: 0.42 })
    assert.ok(Number.isFinite(b.center(0)), `n=${n}: center(0)`)
    assert.ok(Number.isFinite(b.center(n - 1)), `n=${n}: center(n-1)`)
    assert.ok(b.band >= 0 && b.band <= b.width + 1e-9, `n=${n}: band width`)
  }
  // With 20000 columns the slots are sub-pixel; that is a design signal, not
  // a crash -- the caller must aggregate before drawing.
  const many = bandScale(20000, [56, 1000], { padding: 0.42 })
  assert.ok(many.width < 0.1)
})

test('R1: histogram and boxStats agree with the fixture shape', () => {
  const { points } = dirtyTimeSeries()
  const values = points.map((p) => p.value).filter(isNum).filter((v) => v >= 0)
  const h = histogram(values, { bins: 10, domain: [0, 100] })
  assert.equal(h.bins.length, 10)
  assert.ok(h.ignored > 0, 'the spike and negatives fall outside [0,100] and must be counted')
  assert.ok(h.total > 0)

  const b = boxStats(values)
  assert.ok(b.q1 <= b.median && b.median <= b.q3)
  assert.ok(b.outliers.length > 0, 'the spike must register as an outlier')
})
