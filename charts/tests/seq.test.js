/**
 * The sequential ramp's own tests.
 *
 * Why colour earns a test at all: a renderer that only ever writes
 * `var(--chart-seq-3)` cannot be checked by reading its code. The token says
 * nothing about whether step 3 is lighter than step 2, whether the weakest step
 * is visible on the page at all, or whether the "ladder" is secretly a rainbow.
 * All of that is arithmetic over the hex values in src/theme.css, so it is
 * measurable without a browser and without a screenshot.
 *
 * Nothing here is asserted from memory. The tokens are read back out of
 * theme.css and every claim is recomputed from the values found there, so
 * editing the CSS re-measures the edit instead of quietly invalidating a
 * hard-coded expectation.
 *
 * The four properties this file exists for:
 *   1. monotone OKLab lightness in BOTH themes, with one direction of meaning
 *   2. adjacent steps far enough apart in OKLab L to be told apart
 *   3. >= 3:1 WCAG contrast between the weakest step and its own surface
 *   4. a single hue -- a lightness ladder, not a rainbow
 * and the two things that must not regress while the ramp changes:
 *   the missing-data tile stays off the ramp and stays separable, and the
 *   `--chart-cat-*` values are not touched.
 *
 * Run: node --test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  heatmapChart, HEAT_RAMP, MISSING_FILL, MISSING_HATCH, resolveRamp,
} from '../src/heatmap.js'

const STEPS = 7
/** Measured values sit far above each bar; the bars are "is this still a ramp". */
const MIN_ADJACENT_DL = 0.04      // OKLab L; measured 0.061 (light) / 0.068 (dark)
const MIN_SURFACE_CONTRAST = 3    // WCAG non-text minimum; measured 3.27 / 3.25
const MIN_MISSING_CONTRAST = 2.5  // missing tile vs weakest step; measured 3.08 / 3.40
const MAX_HUE_SPREAD = 10         // degrees; measured 3.1
const MAX_CHROMA = 0.15           // palette is muted; measured max 0.120
const MIN_CHROMA = 0.02           // below this a hue is not really a hue

const CSS = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8')
const DARK_AT = CSS.indexOf('@media (prefers-color-scheme: dark)')
const LIGHT_CSS = CSS.slice(0, DARK_AT)
const DARK_CSS = CSS.slice(DARK_AT)

/** `--token: #rrggbb` declarations in one block. Non-hex values are not colours. */
function tokensIn(text) {
  const out = new Map()
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*[;\n]/g)) {
    out.set(m[1], m[2].toLowerCase())
  }
  return out
}

const LIGHT = tokensIn(LIGHT_CSS)
const DARK = tokensIn(DARK_CSS)

/** The ramp tokens in step order, as hex, for one theme. */
function ladder(map, theme) {
  return Array.from({ length: STEPS }, (_, i) => {
    const name = `--chart-seq-${i + 1}`
    const hex = map.get(name)
    assert.ok(hex, `${theme} does not declare ${name}`)
    return hex
  })
}

const LIGHT_RAMP = ladder(LIGHT, 'light mode')
const DARK_RAMP = ladder(DARK, 'dark mode')

// ── colour maths ───────────────────────────────────────────────────────────
//
// OKLab from Björn Ottosson's definition (sRGB -> linear -> LMS -> cube root ->
// Lab). Its L is the perceptually uniform lightness the palette is built on.
// WCAG relative luminance is kept separate on purpose: it is what the 3:1 rule
// is stated in, and the two are NOT interchangeable -- a blue and a yellow with
// the same OKLab L have different WCAG luminance.

function linear(c) {
  const x = c / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}

function rgb(hex) {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}

/** WCAG 2.x relative luminance. */
function relLum(hex) {
  const [r, g, b] = rgb(hex).map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, always >= 1, order-independent. */
function contrast(a, b) {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function oklab(hex) {
  const [r, g, b] = rgb(hex).map(linear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  }
}

function oklch(hex) {
  const { L, a, b } = oklab(hex)
  return { L, C: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI }
}

const okl = (hex) => oklab(hex).L
const f3 = (n) => n.toFixed(3)

/** One line per step: the evidence, so a failure shows what the ladder became. */
function evidence(theme, ramp, surface) {
  const lines = [`${theme} (surface ${surface})`]
  let prev = null
  ramp.forEach((hex, i) => {
    const L = okl(hex)
    lines.push(`  seq-${i + 1} ${hex}  OKLab L=${f3(L)}  dL=${prev === null ? '  -  ' : f3(L - prev)}  ` +
      `contrast=${contrast(hex, surface).toFixed(2)}:1`)
    prev = L
  })
  return lines.join('\n')
}

// ── the ramp ───────────────────────────────────────────────────────────────

test('theme.css declares one sequential ladder per theme, and heatmap.js uses it', () => {
  assert.ok(DARK_AT > 0, 'theme.css has no dark-mode block -- did the media query move?')
  assert.deepEqual(
    [...LIGHT.keys()].filter((k) => k.startsWith('--chart-seq-')),
    Array.from({ length: STEPS }, (_, i) => `--chart-seq-${i + 1}`),
    'light mode must declare seq-1..seq-7 with no gaps and no extras',
  )
  assert.deepEqual(
    [...DARK.keys()].filter((k) => k.startsWith('--chart-seq-')),
    Array.from({ length: STEPS }, (_, i) => `--chart-seq-${i + 1}`),
    'dark mode must declare its own seq-1..seq-7, not fall through to the light ones',
  )
  // theme.css and heatmap.js must not drift: the renderer paints all of them.
  assert.equal(HEAT_RAMP.length, STEPS, 'the renderer ramp and the token set have different lengths')
  assert.deepEqual(
    HEAT_RAMP,
    Array.from({ length: STEPS }, (_, i) => `var(--chart-seq-${i + 1})`),
    'the default ramp must be the sequential tokens, weakest first',
  )
  for (const token of HEAT_RAMP) {
    assert.ok(LIGHT.has(token.slice(4, -1)) && DARK.has(token.slice(4, -1)),
      `${token} is not declared in both themes`)
  }
})

test('lightness is monotone in both themes, and "stronger" means the same in both', () => {
  const lightL = LIGHT_RAMP.map(okl)
  const darkL = DARK_RAMP.map(okl)
  const rising = (xs) => xs.every((v, i) => i === 0 || v > xs[i - 1])
  const falling = (xs) => xs.every((v, i) => i === 0 || v < xs[i - 1])

  assert.ok(falling(lightL), `light mode is not monotone pale -> dark: ${lightL.map(f3).join(' -> ')}`)
  assert.ok(rising(darkL), `dark mode is not monotone dark -> pale: ${darkL.map(f3).join(' -> ')}`)

  // Opposite lightness runs are the point: the MEANING is one rule -- a larger
  // value sits further from the surface -- so contrast against the theme's own
  // surface must climb with the step index in BOTH themes. If a future edit
  // flips one theme's direction, this is what fails.
  const lightSurface = LIGHT.get('--chart-surface')
  const darkSurface = DARK.get('--chart-surface')
  assert.ok(lightSurface && darkSurface, 'both themes must declare --chart-surface')
  const lightC = LIGHT_RAMP.map((hex) => contrast(hex, lightSurface))
  const darkC = DARK_RAMP.map((hex) => contrast(hex, darkSurface))
  assert.ok(rising(lightC), `light steps do not gain contrast with the surface: ${lightC.map((c) => c.toFixed(2)).join(' -> ')}`)
  assert.ok(rising(darkC), `dark steps do not gain contrast with the surface: ${darkC.map((c) => c.toFixed(2)).join(' -> ')}`)
})

test('adjacent steps are far enough apart in OKLab L to be told apart', () => {
  for (const [theme, ramp] of [['light', LIGHT_RAMP], ['dark', DARK_RAMP]]) {
    const ls = ramp.map(okl)
    const gaps = ls.slice(1).map((v, i) => Math.abs(v - ls[i]))
    const smallest = Math.min(...gaps)
    assert.ok(smallest >= MIN_ADJACENT_DL,
      `${theme}: the closest two steps are ${f3(smallest)} apart in OKLab L (need >= ${MIN_ADJACENT_DL}); ` +
      `gaps were ${gaps.map(f3).join(', ')}`)
    // Even spacing, not "five steps crammed at one end": no gap may be more than
    // twice the smallest, or the ladder reads as a ramp plus a couple of tags.
    assert.ok(Math.max(...gaps) <= 2 * smallest,
      `${theme}: the ladder is unevenly spaced (gaps ${gaps.map(f3).join(', ')})`)
  }
})

test('the weakest step clears 3:1 against its own surface', () => {
  const pairs = [
    ['light', LIGHT_RAMP[0], LIGHT.get('--chart-surface')],
    ['dark', DARK_RAMP[0], DARK.get('--chart-surface')],
  ]
  for (const [theme, weakest, surface] of pairs) {
    const ratio = contrast(weakest, surface)
    assert.ok(ratio >= MIN_SURFACE_CONTRAST,
      `${theme}: the weakest step ${weakest} is only ${ratio.toFixed(2)}:1 against ${surface}. ` +
      'Below 3:1 the lowest bin reads as an empty cell, which is the defect this token set was added to fix.')
  }
  // The strongest step has to be a clear full stop, not a slightly darker bin.
  for (const [theme, ramp, surface] of [['light', LIGHT_RAMP, LIGHT.get('--chart-surface')],
    ['dark', DARK_RAMP, DARK.get('--chart-surface')]]) {
    const ratio = contrast(ramp[STEPS - 1], surface)
    assert.ok(ratio >= 7, `${theme}: the strongest step is only ${ratio.toFixed(2)}:1 against its surface`)
  }
})

test('the ladder is one hue, not a rainbow', () => {
  const all = [...LIGHT_RAMP, ...DARK_RAMP]
  const hues = all.map((hex) => oklch(hex).h)
  const spread = Math.max(...hues) - Math.min(...hues)
  assert.ok(spread <= MAX_HUE_SPREAD,
    `hue drifts ${spread.toFixed(1)} deg across the ramp (limit ${MAX_HUE_SPREAD}) -- that is a rainbow, not a lightness ladder`)
  for (const hex of all) {
    const { C, h } = oklch(hex)
    assert.ok(Number.isFinite(h), `${hex} has no measurable hue`)
    assert.ok(C >= MIN_CHROMA && C <= MAX_CHROMA,
      `${hex} has chroma ${f3(C)}; the palette stays inside ${MIN_CHROMA}..${MAX_CHROMA}`)
  }
  // Sixteen categorical colours must not sneak back in as "the ramp".
  for (const hex of all) {
    for (const i of Array.from({ length: 8 }, (_, k) => k + 1)) {
      assert.notEqual(hex, LIGHT.get(`--chart-cat-${i}`), `${hex} reuses a categorical token`)
      assert.notEqual(hex, DARK.get(`--chart-cat-${i}`), `${hex} reuses a categorical token`)
    }
  }
})

test('the measured ladder', (t) => {
  // The numbers the report quotes, kept where they can be re-run. This test
  // asserts nothing new -- the four above already do -- it prints the evidence
  // so a failure elsewhere is readable without re-deriving the maths.
  t.diagnostic(evidence('light', LIGHT_RAMP, LIGHT.get('--chart-surface')))
  t.diagnostic(evidence('dark', DARK_RAMP, DARK.get('--chart-surface')))
  t.diagnostic(`missing tile vs weakest step: light ${contrast(LIGHT.get('--chart-sunken'), LIGHT_RAMP[0]).toFixed(2)}:1, ` +
    `dark ${contrast(DARK.get('--chart-sunken'), DARK_RAMP[0]).toFixed(2)}:1`)
  assert.equal(LIGHT_RAMP.length, STEPS)
  assert.equal(DARK_RAMP.length, STEPS)
})

// ── what the ramp change must not break ────────────────────────────────────

test('the categorical tokens were not touched', () => {
  // Other renderers encode series identity with these. A sequential scale that
  // "borrows" them again, or an edit that reorders them, breaks those charts.
  const lightCat = ['#c9d2e6', '#7b8ab5', '#39466f', '#232c49', '#8ea2d8', '#5a6a99', '#aab5d0', '#454f73']
  const darkCat = ['#2c3550', '#4d5f92', '#8ea2d8', '#b9c6ea', '#3d4a72', '#6b7cae', '#a3b1d6', '#58648c']
  lightCat.forEach((hex, i) => assert.equal(LIGHT.get(`--chart-cat-${i + 1}`), hex, `light --chart-cat-${i + 1} changed`))
  darkCat.forEach((hex, i) => assert.equal(DARK.get(`--chart-cat-${i + 1}`), hex, `dark --chart-cat-${i + 1} changed`))
})

test('the missing tile is still off the ramp, still hatched, still separable', () => {
  const source = readFileSync(new URL('../src/heatmap.js', import.meta.url), 'utf8')
  // "No measurement" and "the smallest measurement" stay different statements.
  assert.ok(!HEAT_RAMP.includes(MISSING_FILL), 'the missing fill must not be a ramp step')
  assert.notEqual(MISSING_FILL, MISSING_HATCH)
  // The mechanism, not just the intent: a hatched neutral pattern, painted only
  // on the cells whose value is absent.
  assert.match(source, /<pattern id=/, 'the hatch pattern is gone from heatmap.js')
  assert.match(source, /\$\{MISSING_FILL\}/, 'the pattern no longer paints MISSING_FILL')
  assert.match(source, /\$\{MISSING_HATCH\}/, 'the pattern no longer strokes MISSING_HATCH')
  assert.match(source, /fill="url\(#\$\{esc\(missId\)\}\)"/, 'holes are no longer filled with the pattern')

  for (const [theme, surface, ramp] of [['light', LIGHT.get('--chart-sunken'), LIGHT_RAMP],
    ['dark', DARK.get('--chart-sunken'), DARK_RAMP]]) {
    assert.ok(surface, `${theme} does not declare --chart-sunken`)
    const ratio = contrast(surface, ramp[0])
    assert.ok(ratio >= MIN_MISSING_CONTRAST,
      `${theme}: the missing tile ${surface} is ${ratio.toFixed(2)}:1 from the weakest step ${ramp[0]}; ` +
      'the hatch is a second cue, not the only one')
  }
})

test('options.colors still replaces the default ramp', () => {
  const custom = ['var(--chart-good)', 'var(--chart-bad)']
  assert.equal(resolveRamp(custom), custom, 'a usable list must be used as given, not copied or merged')
  // The default applies only when there is nothing to override it with.
  for (const empty of [undefined, null, [], 'nonsense', 42]) {
    assert.equal(resolveRamp(empty), HEAT_RAMP, `${String(empty)} must fall back to the default ramp`)
  }
})

// ── minimal DOM stub ───────────────────────────────────────────────────────
//
// NOT a browser. It cannot say whether the chart looks right. It answers the one
// question a pure function cannot: does the ramp actually reach the markup, and
// does a caller's `colors` actually replace it.

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    style: {},
    attrs: {},
    children: [],
    textContent: '',
    clientWidth: 0,
    offsetWidth: 140,
    offsetHeight: 64,
    listeners: new Map(),
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k] },
    append(...kids) { for (const k of kids) this.children.push(k) },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, [])
      this.listeners.get(type).push(fn)
    },
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 320 } },
  }
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html },
    set(v) { this._html = String(v); if (this._html === '') this.children.length = 0 },
  })
  el._html = ''
  return el
}

function installDom() {
  const g = globalThis
  const previous = {
    document: g.document,
    ResizeObserver: g.ResizeObserver,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
  }
  const frames = new Map()
  let nextId = 1
  g.document = { createElementNS: (ns, tag) => makeEl(tag), createElement: (tag) => makeEl(tag) }
  g.ResizeObserver = class { constructor(cb) { this.cb = cb } observe() {} unobserve() {} disconnect() {} }
  g.requestAnimationFrame = (cb) => { const id = nextId++; frames.set(id, cb); return id }
  g.cancelAnimationFrame = (id) => { frames.delete(id) }
  const host = makeEl('div')
  host.clientWidth = 600
  return {
    host,
    flush() { const pending = Array.from(frames.values()); frames.clear(); for (const cb of pending) cb() },
    restore() {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete g[k]
        else g[k] = v
      }
    },
  }
}

const byClass = (host, cls) => host.children.find((c) => c.className === cls)
const swatchesIn = (legend) => Array.from(legend.innerHTML.matchAll(/background:(var\(--chart-[a-z0-9-]+\))/g)).map((m) => m[1])

/** A 2x2 grid with one hole, so the hatched tile is present too. */
const fixture = {
  rows: [{ r: 'a', c: 'x', v: 1 }, { r: 'a', c: 'y', v: 2 }, { r: 'b', c: 'x', v: 3 }],
  row: (d) => d.r, col: (d) => d.c, value: (d) => d.v,
}

test('the default ramp in the rendered markup is the sequential token set', () => {
  const dom = installDom()
  try {
    const chart = heatmapChart(dom.host, fixture)
    dom.flush()
    const legend = byClass(dom.host, 'chart-heat-legend')
    const rampSwatches = swatchesIn(legend).filter((t) => t !== MISSING_FILL)
    assert.ok(rampSwatches.length >= 2, 'the legend must show the classes it used')
    for (const token of rampSwatches) {
      assert.ok(HEAT_RAMP.includes(token), `the legend painted ${token}, which is not on the ramp`)
    }
    assert.ok(rampSwatches.some((t) => t.startsWith('var(--chart-seq-')), 'the default ramp is not the sequential tokens')

    // A hole is still a hole: neutral fill, hatched, never a ramp step.
    const svg = dom.host.children.find((c) => c.tagName === 'SVG').innerHTML
    assert.match(svg, /<pattern id="heatmiss-\d+"/, 'the hatch pattern is no longer emitted')
    assert.match(svg, /fill="url\(#heatmiss-\d+\)"/, 'the hole is no longer painted with the pattern')
    // Cell paths only: the hatch pattern's own <rect> legitimately carries
    // MISSING_FILL, the cells may never.
    const cells = Array.from(svg.matchAll(/<path d="([^"]*)" fill="([^"]*)"\/>/g)).map((m) => m[2])
    assert.ok(cells.length >= 2, 'the ramp must actually paint cells')
    for (const fill of cells) {
      assert.notEqual(fill, MISSING_FILL, 'a ramp step and the missing tile share a fill')
    }
    chart.destroy()
  } finally {
    dom.restore()
  }
})

test('options.colors reaches the rendered legend instead of the default', () => {
  const dom = installDom()
  try {
    const custom = ['var(--chart-good)', 'var(--chart-bad)']
    const chart = heatmapChart(dom.host, { ...fixture, colors: custom })
    dom.flush()
    const legend = byClass(dom.host, 'chart-heat-legend')
    const rampSwatches = swatchesIn(legend).filter((t) => t !== MISSING_FILL)
    assert.ok(rampSwatches.length >= 2, 'a two-token ramp still paints classes')
    assert.deepEqual([...new Set(rampSwatches)].sort(), [...custom].sort(),
      'the caller\'s tokens must be used, not merged with or replaced by the default')
    assert.ok(!legend.innerHTML.includes('--chart-seq-'), 'the default ladder leaked into an overridden legend')
    chart.destroy()
  } finally {
    dom.restore()
  }
})
