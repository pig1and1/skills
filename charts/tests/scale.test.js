/**
 * Unit tests for the sequential colour scale appended to core.js.
 *
 * Run: node --test
 *
 * These exist for the same reason core.test.js does: the binning is the part of
 * a heatmap most likely to be wrong and least likely to be noticed. A chart with
 * the wrong ramp still renders, still looks plausible, and still misinforms --
 * so the choice between equal-interval and quantile bins has to be pinned down
 * by numbers, not by looking at it.
 *
 * Every test below names the real failure it guards.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  quantile, distributionShape, chooseBinMethod, colorBins, stepScale,
  boxStats, isNum,
} from '../src/core.js'

// ─────────────────────────────────────────────── quantile

test('quantile agrees with boxStats, so the two never disagree on the same data', () => {
  const values = [1, 2, 3, 4, 5, 100]
  const s = boxStats(values)
  assert.equal(quantile(values, 0.25), s.q1)
  assert.equal(quantile(values, 0.5), s.median)
  assert.equal(quantile(values, 0.75), s.q3)
})

test('quantile handles the ends, dirty input and a missing sample', () => {
  assert.equal(quantile([3, 1, 2], 0), 1)
  assert.equal(quantile([3, 1, 2], 1), 3)
  // Dirty input must not produce NaN in the middle of a scale.
  assert.equal(quantile([1, NaN, 3, null, '5'], 0.5), 2)
  assert.ok(Number.isNaN(quantile([], 0.5)))
  assert.ok(Number.isNaN(quantile([NaN, Infinity], 0.5)))
  // q outside [0,1] is clamped rather than extrapolated.
  assert.equal(quantile([1, 2, 3], 5), 3)
  assert.equal(quantile([1, 2, 3], -5), 1)
})

// ─────────────────────────────────────────────── distribution shape

test('distributionShape reports the real extremes, not the whisker ends', () => {
  // boxStats stops its whiskers at the last inlier. If the shape inherited those
  // numbers, the ramp would end at 5 while the data runs to 100 -- and the
  // winning outlier would be painted as an ordinary low value.
  const values = [1, 2, 3, 4, 5, 100]
  const shape = distributionShape(values)
  assert.equal(shape.max, 100, 'the top of the ramp must be the real maximum')
  assert.equal(shape.min, 1)
  assert.equal(boxStats(values).max, 5, 'boxStats itself still reports the whisker end')
  assert.equal(shape.outliers, 1)
  assert.equal(shape.distinct, 6)
})

test('distributionShape measures what equal-interval bins would really do', () => {
  // This measurement is what the method choice reads, so it has to be the real
  // occupancy -- not a proxy statistic.
  const uniform = Array.from({ length: 1000 }, (_, i) => i)
  assert.ok(distributionShape(uniform, { probeBins: 5 }).probeMaxShare < 0.25,
    'a uniform spread fills equal bins evenly')

  const spiked = Array.from({ length: 1000 }, (_, i) => (i % 10) + 1).concat([1000])
  assert.ok(distributionShape(spiked, { probeBins: 5 }).probeMaxShare > 0.9,
    'one far outlier flattens every ordinary value into the first equal bin')

  const probe = distributionShape(spiked, { probeBins: 5 }).probeCounts
  assert.equal(probe.length, 5)
  assert.equal(probe.reduce((a, b) => a + b, 0), 1001, 'every usable value is probed')
})

test('distributionShape survives empty, single and constant input', () => {
  const empty = distributionShape([])
  assert.equal(empty.empty, true)
  assert.equal(empty.count, 0)
  assert.equal(empty.probeCounts.length, 5)
  assert.equal(empty.probeMaxShare, 0)
  assert.ok(Number.isNaN(empty.min))

  const one = distributionShape([42])
  assert.equal(one.min, 42)
  assert.equal(one.max, 42)
  assert.equal(one.distinct, 1)
  assert.ok(Number.isFinite(one.probeMaxShare), 'a constant must not divide by zero')
  assert.equal(one.probeMaxShare, 1)

  const constant = distributionShape([7, 7, 7, 7])
  assert.equal(constant.iqr, 0)
  assert.equal(constant.skew, 0, 'a constant has no skew, not NaN')
})

test('distributionShape ignores non-finite values instead of poisoning the domain', () => {
  const shape = distributionShape([1, 2, 3, NaN, null, 'x', Infinity, undefined])
  assert.equal(shape.count, 3)
  assert.equal(shape.min, 1)
  assert.equal(shape.max, 3)
  assert.ok(Number.isFinite(shape.probeMaxShare))
})

test('distributionShape reports outliers as a share, and skew in the right direction', () => {
  const highTail = Array.from({ length: 99 }, () => 5)
  highTail.push(100)
  const up = distributionShape(highTail)
  assert.ok(up.outlierShare > 0)
  assert.equal(up.outliers, 1)

  // Quartile (Bowley) skew is about WHERE the median sits between the quartiles,
  // which is why one isolated outlier cannot move it: the exponential-like set
  // below is the clearest sign case, not the single-spike one above.
  assert.equal(distributionShape(Array.from({ length: 20 }, (_, i) => i + 1)).skew, 0,
    'a symmetric spread has no skew')
  const longUpper = Array.from({ length: 200 }, (_, i) => Math.round(Math.exp(i / 20)))
  assert.ok(distributionShape(longUpper).skew > 0, 'a long upper tail skews positive')
  const tailAboveABlock = Array.from({ length: 80 }, (_, i) => i % 5)
    .concat(Array.from({ length: 20 }, (_, i) => 50 + i * 10))
  assert.ok(distributionShape(tailAboveABlock).skew < 0,
    'a block of low values with a spread-out top skews negative')
})

// ─────────────────────────────────────────────── the method choice

test('chooseBinMethod measures the failure instead of guessing from a statistic', () => {
  const uniform = Array.from({ length: 500 }, (_, i) => i)
  const pick = chooseBinMethod(distributionShape(uniform, { probeBins: 5 }))
  assert.equal(pick.method, 'equal')
  assert.equal(pick.reason, 'even')
  assert.ok(pick.detail.length > 0)

  const spiked = Array.from({ length: 500 }, (_, i) => (i % 10) + 1).concat([10000])
  const other = chooseBinMethod(distributionShape(spiked, { probeBins: 5 }))
  assert.equal(other.method, 'quantile')
  assert.equal(other.reason, 'imbalance')
  // The reason must quote the measurement, or the reader cannot check it.
  assert.ok(/%/.test(other.detail), `detail should carry the measured share: ${other.detail}`)
})

test('chooseBinMethod refuses quantile when there is nothing to spread', () => {
  assert.equal(chooseBinMethod(distributionShape([])).reason, 'empty')
  assert.equal(chooseBinMethod(distributionShape([3, 3, 3])).reason, 'degenerate')
  // Two distinct values: quantile edges would land on top of each other.
  const two = chooseBinMethod(distributionShape(Array.from({ length: 100 }, (_, i) => i % 2)))
  assert.equal(two.method, 'equal')
  assert.equal(two.reason, 'discrete')
  assert.equal(chooseBinMethod(null).reason, 'empty')
})

test('chooseBinMethod honours a caller-supplied tolerance', () => {
  const uniform = distributionShape(Array.from({ length: 500 }, (_, i) => i), { probeBins: 5 })
  assert.equal(chooseBinMethod(uniform, { maxBinShare: 0.9 }).method, 'equal')
  assert.equal(chooseBinMethod(uniform, { maxBinShare: 0.05 }).method, 'quantile')
  // A nonsense limit is clamped, not obeyed.
  assert.equal(chooseBinMethod(uniform, { maxBinShare: 0 }).method, 'equal' && 'quantile')
  assert.equal(chooseBinMethod(uniform, { maxBinShare: NaN }).method, 'equal')
})

// ─────────────────────────────────────────────── colorBins

test('colorBins picks quantile when equal intervals would waste the ramp', () => {
  // The concrete failure: one value three orders of magnitude above a tight
  // cluster. Equal intervals leave all but three cells in the first bin, so the
  // heatmap is one flat colour and the ramp says nothing.
  const values = Array.from({ length: 1000 }, (_, i) => 1 + (i % 10)).concat([1000, 900, 800])

  const equal = colorBins(values, { bins: 5, method: 'equal' })
  assert.equal(equal.counts[0], 1000, 'equal intervals bury the bulk in bin 0')
  assert.ok(equal.counts.filter((c) => c === 0).length >= 2, 'and leave bins empty')

  const auto = colorBins(values, { bins: 5 })
  assert.equal(auto.method, 'quantile')
  assert.equal(auto.reason, 'imbalance')
  assert.ok(auto.counts[0] < values.length * 0.5,
    `quantile must resolve the bulk, got ${auto.counts.join(',')}`)
  assert.equal(auto.total, values.length, 'every value is still placed')
  assert.equal(auto.counts.reduce((a, b) => a + b, 0), values.length)
})

test('colorBins keeps equal intervals when they are affordable', () => {
  const uniform = Array.from({ length: 995 }, (_, i) => i)
  const auto = colorBins(uniform, { bins: 5 })
  assert.equal(auto.method, 'equal')
  assert.equal(auto.reason, 'even')
  // Equal intervals are the readable choice: evenly spaced edges mean the legend
  // can round them without the rounding ever contradicting the next boundary.
  assert.deepEqual(auto.edges, [0, 198.8, 397.6, 596.4, 795.2, 994])
})

test('colorBins quantile bins carry roughly equal populations', () => {
  const values = []
  for (let i = 0; i < 1000; i++) values.push(i < 900 ? i / 100 : 500 + i)
  const auto = colorBins(values, { bins: 5 })
  assert.equal(auto.method, 'quantile')
  const shares = auto.counts.map((c) => c / auto.total)
  for (const s of shares) assert.ok(s > 0.1 && s < 0.35, `bin share out of band: ${shares.join(',')}`)
})

test('colorBins drops collapsed quantile edges and says how many it lost', () => {
  // Ties are normal in count data, and two identical edges are an empty bin.
  const clumped = new Array(60).fill(0).concat(Array.from({ length: 40 }, (_, i) => i + 1))
  const out = colorBins(clumped, { bins: 5, method: 'quantile' })
  assert.ok(out.bins < out.requested, `expected fewer bins than requested, got ${out.bins}`)
  assert.ok(out.collapse > 0)
  assert.equal(out.bins, out.edges.length - 1)
  assert.equal(out.counts.length, out.bins, 'counts and bins must agree, or the legend lies')
  assert.equal(out.total, 100)
  for (let i = 1; i < out.edges.length; i++) {
    assert.ok(out.edges[i] > out.edges[i - 1], `edges must strictly ascend: ${out.edges}`)
  }
})

test('colorBins falls back to equal intervals when quantile would not help', () => {
  // An explicit low tolerance asks for balance. With heavy ties there is no
  // quantile cut that beats equal spacing, so quantile must not be claimed as a
  // win: choosing it and delivering a flatter ramp is not a defensible trade.
  const flat = Array.from({ length: 1000 }, (_, i) => 1 + (i % 10))
  const out = colorBins(flat, { bins: 5, maxBinShare: 0.05 })
  assert.equal(out.method, 'equal')
  assert.equal(out.reason, 'no-gain')
  assert.ok(/no-gain|%/.test(out.detail))
  assert.equal(out.total, 1000)
})

test('colorBins honours an explicitly requested method', () => {
  const values = Array.from({ length: 1000 }, (_, i) => 1 + (i % 10)).concat([1000])
  const forcedEqual = colorBins(values, { bins: 4, method: 'equal' })
  assert.equal(forcedEqual.method, 'equal')
  assert.equal(forcedEqual.reason, 'forced')
  assert.equal(forcedEqual.bins, 4)

  const forcedQuantile = colorBins(values, { bins: 4, method: 'quantile' })
  assert.equal(forcedQuantile.method, 'quantile')
  assert.equal(forcedQuantile.reason, 'forced')
  // Forcing quantile is honoured even when the automatic policy would refuse it.
  const flat = Array.from({ length: 1000 }, (_, i) => 1 + (i % 10))
  assert.equal(colorBins(flat, { bins: 5, method: 'quantile' }).method, 'quantile')
})

test('colorBins is renderable for every degenerate input', () => {
  for (const input of [[], null, undefined, 'nonsense', [NaN], [null, undefined], [7], [7, 7, 7]]) {
    const out = colorBins(input, { bins: 5 })
    assert.ok(Array.isArray(out.edges), 'edges must be an array')
    assert.ok(out.edges.length >= 2, `at least one bin: ${JSON.stringify(input)}`)
    assert.ok(out.bins >= 1)
    assert.equal(out.counts.length, out.bins, `counts align with bins for ${JSON.stringify(input)}`)
    assert.ok(out.edges.every(isNum), `finite edges for ${JSON.stringify(input)}`)
    assert.ok(out.domain.every(isNum))
    assert.ok(out.domain[1] > out.domain[0], 'the domain always has width')
    assert.ok(out.counts.every((c) => Number.isInteger(c) && c >= 0))
  }
})

test('colorBins puts a constant series in a visible middle bin', () => {
  const out = colorBins([7, 7, 7, 7], { bins: 5 })
  assert.equal(out.reason, 'degenerate')
  assert.equal(out.method, 'equal')
  assert.equal(out.bins, 5)
  assert.ok(out.edges[0] < 7 && out.edges[out.edges.length - 1] > 7, 'the domain is expanded around the value')
  const filled = out.counts.findIndex((c) => c === 4)
  assert.ok(filled > 0 && filled < out.bins - 1,
    `a constant must not sit on the lightest step, landed on bin ${filled}`)
})

test('colorBins counts values outside a forced domain instead of hiding them', () => {
  const out = colorBins([1, 2, 50, -30], { bins: 2, domain: [0, 10] })
  assert.deepEqual(out.domain, [0, 10])
  assert.equal(out.outside, 2, 'both 50 and -30 are outside and must be reported')
  assert.equal(out.total, 4, 'out-of-domain values still belong to a bin')
  assert.equal(out.bins, 2)
})

test('colorBins is deterministic and never mutates its input', () => {
  const values = [5, 1, 9, 3, 7, 1, 1, 100]
  const frozen = JSON.stringify(values)
  const a = colorBins(values, { bins: 4 })
  const b = colorBins(values, { bins: 4 })
  assert.deepEqual(a.edges, b.edges)
  assert.deepEqual(a.counts, b.counts)
  assert.equal(a.method, b.method)
  assert.equal(JSON.stringify(values), frozen, 'the caller keeps its array untouched')
})

test('colorBins clamps a nonsense bin count instead of returning nothing', () => {
  const values = [1, 2, 3, 4, 5]
  for (const bins of [0, -3, NaN, 0.4]) {
    const out = colorBins(values, { bins })
    assert.ok(out.bins >= 1, `bins=${bins} produced ${out.bins}`)
    assert.equal(out.counts.length, out.bins)
  }
  assert.equal(colorBins(values, { bins: 1 }).bins, 1)
})

test('colorBins survives extreme magnitudes without producing NaN', () => {
  const wide = [1e-300, 1e-200, 1, 1e200, 1e300, -1e300]
  const out = colorBins(wide, { bins: 5 })
  assert.ok(out.edges.every(Number.isFinite), `edges: ${out.edges}`)
  assert.ok(out.edges[out.edges.length - 1] > out.edges[0])
  assert.equal(out.total, wide.length)
  // Values must all be placeable in the resulting scale.
  const scale = stepScale(out.edges)
  for (const v of wide) {
    const idx = scale.step(v)
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx < out.bins, `step(${v}) = ${idx}`)
  }
})

// ─────────────────────────────────────────────── stepScale

test('stepScale maps a missing value to null, never to bin 0', () => {
  // This is the whole safety property: bin 0 is the ramp's weakest step, so
  // returning 0 for "no measurement" would paint an absent cell as the lowest
  // measured value. Missing data has to be distinguishable.
  const scale = stepScale([0, 10, 20, 30])
  for (const missing of [NaN, null, undefined, '5', Infinity, -Infinity, {}, []]) {
    assert.equal(scale.step(missing), null, `${String(missing)} must not be a bin`)
  }
  assert.equal(scale.step(0), 0, 'a real zero is still bin 0')
})

test('stepScale uses half-open bins with the top edge inside the last bin', () => {
  const scale = stepScale([0, 10, 20, 30])
  assert.equal(scale.count, 3)
  assert.equal(scale.step(-5), 0, 'below the first edge clamps to the first bin')
  assert.equal(scale.step(0), 0)
  assert.equal(scale.step(9.999), 0)
  assert.equal(scale.step(10), 1, 'an edge belongs to the bin above it')
  assert.equal(scale.step(20), 2)
  assert.equal(scale.step(30), 2, 'the maximum is inside the last bin, not outside the scale')
  assert.equal(scale.step(999), 2)
})

test('stepScale repairs unusable edges instead of dividing by zero', () => {
  for (const edges of [[], null, [5], [5, 5], [NaN, NaN], ['a', 'b'], undefined]) {
    const scale = stepScale(edges)
    assert.equal(scale.degenerate, true, `edges ${JSON.stringify(edges)} should fall back`)
    assert.deepEqual(scale.edges, [0, 1])
    assert.equal(scale.count, 1)
    assert.equal(scale.step(0.5), 0)
    assert.ok(Number.isFinite(scale.step(1)))
  }
})

test('stepScale deduplicates and sorts the edges it is given', () => {
  const scale = stepScale([30, 10, 10, 20, 0, 0])
  assert.deepEqual(scale.edges, [0, 10, 20, 30])
  assert.equal(scale.count, 3)
  assert.equal(scale.degenerate, false)
  assert.equal(scale.step(15), 1)
})

test('every bin a colorBins scale produces is reachable and in range', () => {
  // A bin the scale can never select is an empty legend entry, which reads as a
  // bug in the data rather than in the scale.
  const values = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 1000]
  for (const method of ['auto', 'equal', 'quantile']) {
    const out = colorBins(values, { bins: 5, method })
    const scale = stepScale(out.edges)
    for (const v of values) {
      const idx = scale.step(v)
      assert.ok(idx >= 0 && idx < out.bins, `${method}: step(${v}) = ${idx} of ${out.bins}`)
    }
    assert.equal(out.counts.reduce((a, b) => a + b, 0), values.length, `${method}: all values placed`)
  }
})
