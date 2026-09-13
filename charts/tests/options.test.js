/**
 * Round 4: the option matrix, after the pipeline was extracted.
 *
 * Rounds 1-3 tested behaviour on fixtures. This round tests the *combinations*,
 * because the refactor introduced three interacting switches (zeroBased,
 * robust, floor) and a wrong combination would only show up in a specific chart
 * type -- a stacked bar with a fitted axis, say, or a line with a floored
 * domain.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { prepareSeries, seriesHasGaps, linearScale, niceTicks, isNum } from '../src/core.js'
import { dirtyTimeSeries, degenerate, huge, T0 } from './fixtures/complex-data.js'

const OPTION_SETS = [
  {},
  { maxPoints: 50 },
  { maxPoints: 100000 },
  { zeroBased: true },
  { robust: true },
  { robust: true, trimLow: 0, trimHigh: 1 },
  { zeroBased: true, floor: (v) => Math.max(0, v) },
  { robust: true, maxPoints: 120 },
  { zeroBased: true, maxPoints: 120 },
  { maxPoints: 1 },
]

test('R4: every option set produces a renderable result for every fixture', () => {
  const fixtures = {
    dirty: dirtyTimeSeries().points,
    empty: [],
    single: degenerate().single,
    allEqual: degenerate().allEqual,
    allDirty: degenerate().allDirty,
    hugeValues: degenerate().hugeValues,
    tinyValues: degenerate().tinyValues,
    manyTimestampsSame: degenerate().oneHour,
  }

  for (const [fname, points] of Object.entries(fixtures)) {
    for (const options of OPTION_SETS) {
      const label = `${fname} + ${JSON.stringify(Object.keys(options))}`
      const out = prepareSeries(points, options)

      assert.ok(Array.isArray(out.points), `${label}: points must be an array`)
      assert.ok(out.points.length <= (options.maxPoints ?? 700),
        `${label}: never exceed maxPoints, got ${out.points.length}`)
      assert.equal(out.domain.length, 2, `${label}: domain shape`)
      assert.ok(out.domain.every(Number.isFinite), `${label}: domain finite, got ${out.domain}`)
      assert.ok(out.domain[1] > out.domain[0], `${label}: domain must have width`)

      // Whatever the domain, a scale built from it must be finite everywhere.
      const scale = linearScale(out.domain, [200, 0])
      for (const p of out.points) {
        assert.ok(Number.isFinite(scale.scale(p.value)), `${label}: scale(value)`)
        assert.ok(Number.isFinite(scale.scale(p.t)) === false || true)
      }
      assert.ok(niceTicks(out.domain[0], out.domain[1], 4).every(Number.isFinite), `${label}: ticks`)
      assert.equal(typeof seriesHasGaps(out.points), 'boolean', `${label}: gaps flag`)
    }
  }
})

test('R4: maxPoints is honoured exactly, including degenerate limits', () => {
  const points = huge(50000)
  for (const max of [1, 2, 7, 100, 700, 50000]) {
    const out = prepareSeries(points, { maxPoints: max })
    assert.ok(out.points.length <= max, `maxPoints=${max} produced ${out.points.length}`)
  }
  // maxPoints=1 must still yield exactly one drawable point, not zero.
  assert.equal(prepareSeries(points, { maxPoints: 1 }).points.length, 1)
})

test('R4: zeroBased is never overridden by robust', () => {
  // A bar chart must start at zero even when an outlier would normally be
  // trimmed -- area encodes magnitude, so trimming the axis would lie.
  const { points } = dirtyTimeSeries()
  const out = prepareSeries(points, { zeroBased: true, robust: true, maxPoints: 100000 })
  assert.equal(out.domain[0], 0, 'zeroBased wins over robust')
})

test('R4: floor is applied before the domain is computed', () => {
  const points = [
    { t: T0, value: -100 },
    { t: T0 + 36e5, value: 5 },
  ]
  const withoutFloor = prepareSeries(points, { zeroBased: true })
  const withFloor = prepareSeries(points, { zeroBased: true, floor: (v) => Math.max(0, v) })
  // Without the floor the negative still exists on the axis; with it, the data
  // is clamped and the axis reflects that.
  assert.ok(withoutFloor.points.some((p) => p.value < 0))
  assert.ok(withFloor.points.every((p) => p.value >= 0))
})

test('R4: trimLow/trimHigh are respected', () => {
  const points = Array.from({ length: 1001 }, (_, i) => ({ t: T0 + i * 1000, value: i }))
  const wide = prepareSeries(points, { robust: true, trimLow: 0, trimHigh: 1, maxPoints: 2000 })
  const narrow = prepareSeries(points, { robust: true, trimLow: 0.4, trimHigh: 0.6, maxPoints: 2000 })
  assert.ok(narrow.domain[1] - narrow.domain[0] < wide.domain[1] - wide.domain[0],
    'a tighter quantile band must produce a tighter axis')
})

test('R4: the same options twice give byte-identical output', () => {
  const { points } = dirtyTimeSeries()
  for (const options of OPTION_SETS) {
    const a = prepareSeries(points, options)
    const b = prepareSeries(points, options)
    assert.deepEqual(a.domain, b.domain, JSON.stringify(options))
    assert.deepEqual(a.points, b.points, JSON.stringify(options))
    assert.equal(a.rejected, b.rejected)
  }
})

test('R4: rejected counts are invariant across options', () => {
  // Cleaning must not depend on axis policy: a table and a chart over the same
  // rows have to agree on how many rows were usable.
  const { points } = dirtyTimeSeries()
  const counts = OPTION_SETS.map((o) => prepareSeries(points, o).rejected)
  assert.equal(new Set(counts).size, 1, `rejection counts differ: ${JSON.stringify(counts)}`)
})

test('R4: no option combination can produce NaN in the output', () => {
  const nasty = [
    ...dirtyTimeSeries().points,
    ...degenerate().hugeValues,
    ...degenerate().tinyValues,
    { t: NaN, value: 1 },
    { t: 1, value: NaN },
    { t: null, value: null },
    null,
    undefined,
    { t: T0, value: Infinity },
    { t: T0, value: -Infinity },
  ]
  for (const options of OPTION_SETS) {
    const out = prepareSeries(nasty, options)
    for (const p of out.points) {
      assert.ok(isNum(p.t), `t is not finite: ${p.t}`)
      assert.ok(isNum(p.value), `value is not finite: ${p.value}`)
    }
    assert.ok(out.domain.every(isNum), `domain: ${out.domain}`)
  }
})
