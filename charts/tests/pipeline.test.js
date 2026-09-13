/**
 * Round 2: the extracted pipeline.
 *
 * Round 1 found that the data handling lived inside the renderer's closure and
 * had zero coverage. It now lives in core.prepareSeries, so these tests can hit
 * it directly -- which is the entire point of extracting it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { prepareSeries, seriesHasGaps, isNum } from '../src/core.js'
import { dirtyTimeSeries, degenerate, huge, T0 } from './fixtures/complex-data.js'

test('R2: the pipeline reports what it rejected, and why', () => {
  const { points, truth } = dirtyTimeSeries()
  // maxPoints must be raised here, or the default 700 downsamples the result
  // and the point-count assertion says nothing about rejection.
  const out = prepareSeries(points, { maxPoints: 100000 })
  const bad = truth.injected.nanValues + truth.injected.nullValues + truth.injected.stringValues
  assert.equal(out.rejected, bad)
  assert.ok(out.empty === false)
  assert.ok(out.points.length > 1000, `got ${out.points.length} points`)
})

test('R3: the default maxPoints really does downsample', () => {
  // The counterpart to the test above: with defaults, a 1500+ point series must
  // come out drawable. Round 2's failure was an assertion that ignored this.
  const { points } = dirtyTimeSeries()
  const out = prepareSeries(points)
  assert.equal(out.sampled, true)
  assert.ok(out.points.length <= 700, `got ${out.points.length}`)
  assert.ok(out.factor > 1)
})

test('R3: two charts over one series agree on the numbers they share', () => {
  const { points } = dirtyTimeSeries()
  // A table and a chart must not disagree about how many records were usable.
  const forLine = prepareSeries(points, { maxPoints: 100000, robust: true })
  const forBar = prepareSeries(points, { maxPoints: 100000, zeroBased: true })

  assert.equal(forLine.rejected, forBar.rejected, 'same input, same rejection count')
  assert.equal(forLine.points.length, forBar.points.length, 'same points before sampling')
  assert.notDeepEqual(forLine.domain, forBar.domain, 'but honestly different axes')

  // The underlying values must be identical -- only the axis policy differs.
  assert.deepEqual(
    forLine.points.map((p) => p.value),
    forBar.points.map((p) => p.value),
  )
})

test('R3: sampling is stable under small input changes', () => {
  // A chart that re-buckets on every keystroke looks like it is flickering.
  const base = Array.from({ length: 5000 }, (_, i) => ({ t: T0 + i * 6e5, value: 90 + Math.sin(i / 50) * 5 }))
  const nudged = base.map((p, i) => (i === 4999 ? { ...p, value: p.value + 0.1 } : p))

  const a = prepareSeries(base, { maxPoints: 300 })
  const b = prepareSeries(nudged, { maxPoints: 300 })

  assert.equal(a.factor, b.factor, 'bucket size must not change for one edited value')
  assert.deepEqual(a.points.map((p) => p.t), b.points.map((p) => p.t),
    'bucket boundaries must stay put')
})

test('R3: an all-zero series still gets a usable zero-based axis', () => {
  const zeros = Array.from({ length: 100 }, (_, i) => ({ t: T0 + i * 36e5, value: 0 }))
  const out = prepareSeries(zeros, { zeroBased: true })
  assert.equal(out.domain[0], 0)
  assert.ok(out.domain[1] > 0, 'a zero-only axis must not collapse to [0, 0]')
  assert.ok(out.domain.every(Number.isFinite))
})

test('R2: the output is ordered, deduplicated and finite', () => {
  const { points } = dirtyTimeSeries()
  const out = prepareSeries(points, { maxPoints: 100000 })
  for (let i = 1; i < out.points.length; i++) {
    assert.ok(out.points[i].t >= out.points[i - 1].t, 'must be ordered')
    assert.ok(out.points[i].t > out.points[i - 1].t, 'duplicates must be merged')
  }
  assert.ok(out.points.every((p) => isNum(p.t) && isNum(p.value)))
  assert.equal(out.merged, true, 'the fixture has duplicate timestamps')
})

test('R2: holes survive the pipeline', () => {
  const { points } = dirtyTimeSeries()
  const out = prepareSeries(points, { maxPoints: 100000 })
  assert.equal(seriesHasGaps(out.points), true,
    'a 10-day hole must still read as a hole after sanitize/sort/collapse')

  // And a gapless series must NOT report gaps.
  const even = Array.from({ length: 100 }, (_, i) => ({ t: T0 + i * 36e5, value: i }))
  assert.equal(seriesHasGaps(prepareSeries(even).points), false)
})

test('R2: downsample runs after collapse, not before', () => {
  // If the order were reversed, duplicate-heavy input would skew the buckets.
  const dupes = []
  for (let i = 0; i < 5000; i++) {
    dupes.push({ t: T0 + i * 1000, value: 10 })
    dupes.push({ t: T0 + i * 1000, value: 20 })   // same timestamp, twice
  }
  const out = prepareSeries(dupes, { maxPoints: 100000 })
  assert.equal(out.points.length, 5000, 'duplicates merge first, then nothing is sampled')
  assert.ok(out.points.every((p) => p.value === 15), 'merged value is the mean')
  assert.equal(out.collapsed, 5000)
})

test('R2: zeroBased and fitted domains differ in the way that matters', () => {
  const points = Array.from({ length: 200 }, (_, i) => ({ t: T0 + i * 36e5, value: 90 + Math.sin(i / 9) * 3 }))

  const fitted = prepareSeries(points, { robust: true })
  assert.ok(fitted.domain[0] > 50, 'a fitted domain must not start at zero')

  const zero = prepareSeries(points, { zeroBased: true })
  assert.equal(zero.domain[0], 0, 'a zero-based domain must start at zero')

  // Same data, two honest answers -- which is why the caller must choose.
  assert.notDeepEqual(fitted.domain, zero.domain)
})

test('R2: robust mode drops the spike and says how many', () => {
  const { points, truth } = dirtyTimeSeries()
  const fitted = prepareSeries(points, { maxPoints: 100000, robust: true })
  assert.ok(fitted.trimmed >= 1)
  assert.ok(fitted.domain[1] < truth.injected.spikeAt.value / 10)

  const naive = prepareSeries(points, { maxPoints: 100000 })
  assert.ok(naive.domain[1] >= truth.injected.spikeAt.value,
    'without robust mode the spike defines the top of the axis')
})

test('R2: floor clamps negative counts before they reach the axis', () => {
  const points = [
    { t: T0, value: -5 },
    { t: T0 + 36e5, value: 10 },
    { t: T0 + 72e5, value: 3 },
  ]
  const raw = prepareSeries(points, { zeroBased: true })
  assert.ok(raw.points.some((p) => p.value < 0), 'without a floor, negatives pass through')

  const floored = prepareSeries(points, { zeroBased: true, floor: (v) => Math.max(0, v) })
  assert.ok(floored.points.every((p) => p.value >= 0))
  assert.equal(floored.domain[0], 0)
})

test('R2: every degenerate input yields a usable domain, never NaN', () => {
  for (const [name, points] of Object.entries(degenerate())) {
    const out = prepareSeries(points)
    assert.ok(Array.isArray(out.points), `${name}: points`)
    assert.ok(out.domain.length === 2, `${name}: domain shape`)
    assert.ok(out.domain.every(Number.isFinite), `${name}: domain finite, got ${out.domain}`)
    assert.ok(out.domain[1] > out.domain[0], `${name}: domain must have width`)
    assert.equal(out.empty, out.points.length === 0, `${name}: empty flag`)
  }
})

test('R2: an empty pipeline is safe and self-describing', () => {
  for (const input of [[], null, undefined, 'nonsense']) {
    const out = prepareSeries(input)
    assert.equal(out.empty, true)
    assert.deepEqual(out.points, [])
    assert.ok(out.domain.every(Number.isFinite))
  }
})

test('R2: 200k points go through the whole pipeline in reasonable time', () => {
  const points = huge()
  const t0 = Date.now()
  const out = prepareSeries(points, { maxPoints: 700 })
  const ms = Date.now() - t0

  assert.ok(out.sampled)
  assert.ok(out.points.length <= 700)
  assert.equal(out.rejected, 0, 'the huge fixture is clean, only large')
  assert.ok(ms < 3000, `200k through the full pipeline took ${ms}ms`)
  assert.ok(out.domain.every(Number.isFinite))
})

test('R2: the pipeline never mutates its input', () => {
  const { points } = dirtyTimeSeries()
  const before = JSON.stringify(points.slice(0, 100))
  prepareSeries(points)
  assert.equal(JSON.stringify(points.slice(0, 100)), before)
})

test('R2: repeated runs are deterministic', () => {
  const { points } = dirtyTimeSeries()
  const a = prepareSeries(points, { maxPoints: 500 })
  const b = prepareSeries(points, { maxPoints: 500 })
  assert.deepEqual(a.domain, b.domain)
  assert.deepEqual(a.points.map((p) => p.value), b.points.map((p) => p.value))
})
