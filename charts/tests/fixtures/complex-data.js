/**
 * Deliberately hostile fixtures.
 *
 * Not random numbers: each generator targets one specific failure mode that a
 * chart implementation gets wrong. If a fixture stops being hostile, the test
 * built on it stops meaning anything, so each one documents what it is for.
 *
 *   dirtyTimeSeries   gaps, NaN/null strings, duplicates, unsorted, a flat run,
 *                     one spike, a zero run, mixed granularity
 *   manyCategories    50 series against a palette that only has 8 usable slots
 *   degenerate        all-equal, single point, empty, entirely unusable
 *   huge              200k points, far past any hand-rolled rendering path
 *   hostileLabels     very long text, markup, emoji, RTL, control characters
 */

const DAY = 864e5
const HOUR = 36e5
export const T0 = Date.parse('2026-05-01T00:00:00Z')

/**
 * A 90-day hourly series that is wrong in nine different ways.
 * Returns { points, truth } where `truth` records what was injected, so tests
 * can assert the implementation *found* the problem rather than merely survived.
 */
export function dirtyTimeSeries() {
  const points = []
  const truth = {
    injected: {
      nanValues: 0, nullValues: 0, stringValues: 0, negativeValues: 0,
      duplicates: 0, gapRuns: [], flatRun: null, spikeAt: null, zeroRun: null,
    },
    clean: 0,
  }

  const TOTAL_HOURS = 90 * 24

  for (let h = 0; h < TOTAL_HOURS; h++) {
    // gap 1: hours 300-360 missing (2.5 days)
    // gap 2: hours 1200-1440 missing (10 days)
    const inGap = (h >= 300 && h < 360) || (h >= 1200 && h < 1440)
    if (inGap) {
      if (h === 300) truth.injected.gapRuns.push({ from: h, to: 360 })
      if (h === 1200) truth.injected.gapRuns.push({ from: h, to: 1440 })
      continue
    }

    const t = T0 + h * HOUR
    let v = 92 + Math.sin(h / 40) * 6 + Math.sin(h / 7) * 1.5

    // a flat run: 200 identical values in a row (a stuck sensor)
    if (h >= 700 && h < 900) {
      v = 77
      truth.injected.flatRun = { from: h, to: 900, value: 77 }
    }
    // a zero run: another stuck state, at the floor
    if (h >= 1600 && h < 1700) {
      v = 0
      truth.injected.zeroRun = { from: h, to: 1700 }
    }
    // one spike, far outside everything else
    if (h === 1000) {
      v = 4800
      truth.injected.spikeAt = { hour: h, value: 4800 }
    }

    let pushed = { t, value: v }

    // dirty values, spread through the series
    if (h % 211 === 0) { pushed = { t, value: NaN }; truth.injected.nanValues++ }
    else if (h % 307 === 0) { pushed = { t, value: null }; truth.injected.nullValues++ }
    else if (h % 401 === 0) { pushed = { t, value: 'n/a' }; truth.injected.stringValues++ }
    else if (h % 503 === 0) { pushed = { t, value: -Math.abs(v) }; truth.injected.negativeValues++ }

    points.push(pushed)
    truth.clean++

    // duplicate timestamps (two samples in one hour)
    if (h % 97 === 0) {
      points.push({ t, value: v + 4 })
      truth.injected.duplicates++
      truth.clean++
    }
  }

  // unsorted: shuffle deterministically so the test is reproducible
  let seed = 42
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = points.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const s = points[i]; points[i] = points[j]; points[j] = s
  }

  return { points, truth, totalHours: TOTAL_HOURS }
}

/** 50 categories, only the first few of which matter. */
export function manyCategories(count = 50) {
  const rows = []
  for (let d = 0; d < 30; d++) {
    const row = { t: T0 + d * DAY }
    for (let c = 0; c < count; c++) {
      // A long tail: category 0 dominates, most are near zero, some are absent.
      row['c' + c] = c === 0 ? 40 + d
        : c < 5 ? 5 + ((d * (c + 3)) % 12)
          : c < 15 ? (d + c) % 4
            : 0
    }
    rows.push(row)
  }
  const series = Array.from({ length: count }, (_, c) => ({
    key: 'c' + c,
    label: 'Category ' + String(c + 1).padStart(2, '0'),
    color: `var(--chart-cat-${(c % 8) + 1})`,
  }))
  return { rows, series, count }
}

/** Degenerate inputs. Any chart must survive all of these. */
export function degenerate() {
  return {
    allEqual: Array.from({ length: 500 }, (_, i) => ({ t: T0 + i * HOUR, value: 88 })),
    single: [{ t: T0, value: 73 }],
    empty: [],
    allDirty: Array.from({ length: 200 }, (_, i) => ({ t: T0 + i * HOUR, value: i % 2 ? NaN : null })),
    twoPoints: [{ t: T0, value: 1 }, { t: T0 + HOUR, value: 2 }],
    oneHour: Array.from({ length: 40 }, (_, i) => ({ t: T0, value: i })),   // all same timestamp
    hugeValues: [{ t: T0, value: 1e15 }, { t: T0 + HOUR, value: -1e15 }, { t: T0 + 2 * HOUR, value: 0 }],
    tinyValues: [{ t: T0, value: 1e-12 }, { t: T0 + HOUR, value: 2e-12 }, { t: T0 + 2 * HOUR, value: 3e-12 }],
  }
}

/** 200k points over ~2.3 years at 10-minute resolution. */
export function huge(count = 200000) {
  const step = 6e5
  const points = new Array(count)
  for (let i = 0; i < count; i++) {
    points[i] = { t: T0 + i * step, value: 90 + Math.sin(i / 900) * 8 + Math.sin(i / 37) * 2 }
  }
  return points
}

/** Labels that try to break the renderer. */
export function hostileLabels() {
  return [
    { key: 'long', label: 'x'.repeat(400) },
    { key: 'html', label: '<img src=x onerror="alert(1)">' },
    { key: 'quote', label: `it's "quoted" & <angled>` },
    { key: 'emoji', label: '🚗💨 车辆 · USB' },
    { key: 'rtl', label: 'مركبة اختبار' },
    { key: 'control', label: 'line\u0000break\u2028and\u2029para' },
    { key: 'empty', label: '' },
    { key: 'space', label: '   ' },
  ]
}

/** A series whose gaps are the whole point: three blocks, two holes. */
export function threeBlocks() {
  const points = []
  const truth = { gaps: [] }
  let t = T0
  for (let block = 0; block < 3; block++) {
    for (let i = 0; i < 40; i++) points.push({ t, value: 80 + block * 5 + Math.sin(i / 5) * 2 }), t += HOUR
    if (block < 2) { t += (block + 1) * 30 * HOUR; truth.gaps.push(points.length) }
  }
  return { points, truth }
}
