// Canvas line chart skeleton: DPR-correct, space-reserving, resize-throttled.
// No dependencies.
//
// It exists to demonstrate four rules from `frontend-tables-and-charts`:
//
//   1. The container's height is fixed BEFORE data arrives, so loading cannot
//      shift the page. Layout shift is measurable -- aim for ~0 CLS.
//   2. A canvas is sized in device pixels and scaled down in CSS pixels;
//      otherwise it is blurry on every display with DPR > 1.
//   3. Resize is observed and throttled to one redraw per frame -- never a
//      rebuild per event.
//   4. BOTH axes get labels. The x-axis is the one most often left off,
//      because "it's obviously time" -- see the skill's section 6.
//      This skeleton reserved PAD_BOTTOM from the start but drew nothing in
//      it until 2026-09-14, while section 6 called the missing x-axis the
//      most commonly dropped rule. The body and the skeleton disagreed.
//
// AXIS POLICY. This draws a line chart, so the y-domain is FITTED TO THE DATA:
// a line communicates position and trend, not magnitude, and forcing zero would
// flatten real variation into a straight line. If you switch this to bars or an
// area fill, the domain MUST start at zero -- see the skill's section 6.

export interface Series {
  label: string
  color: string
  values: number[]
}

export interface LineChartOptions {
  /** Fixed height in CSS pixels. The container gets this immediately. */
  height?: number
  /** Optional fixed domain. Omit to fit the data on every draw. */
  domain?: [number, number]
  /** Formats a value for the y-axis labels. */
  format?: (v: number) => string
  /**
   * One label per data point, drawn at 4-6 evenly spaced positions along the
   * x-axis (skill section 6). Omit it and the x-axis is simply not drawn --
   * which is exactly the omission section 6 warns about, so pass it.
   */
  xLabels?: string[]
}

/** Left gutter reserved for axis labels. Fixed so the plot area never reflows. */
const AXIS_W = 44
const PAD_TOP = 10
const PAD_BOTTOM = 20

export function createLineChart(container: HTMLElement, options: LineChartOptions = {}) {
  const height = options.height ?? 220
  const format = options.format ?? ((v: number) => String(Math.round(v)))

  // Rule 1: reserve the space up front. Everything below happens inside a box
  // whose height is already fixed, so no later work can move the page.
  container.style.position = 'relative'
  container.style.height = `${height}px`
  container.style.contain = 'layout paint'

  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = `${height}px`
  canvas.setAttribute('role', 'img')
  container.appendChild(canvas)

  const context = canvas.getContext('2d')
  // Fail loudly instead of drawing nothing. `getContext` is nullable, and
  // TypeScript will not carry a narrowing of it into the nested draw()
  // closure, so bind a non-null alias once and use that everywhere below
  // (otherwise the whole file is 25 x TS18047 under --strict).
  if (!context) throw new Error('line chart: 2d context unavailable')
  const ctx: CanvasRenderingContext2D = context
  let series: Series[] = []
  let frame = 0

  /** Rule 2: size in device pixels, draw in CSS pixels. */
  function resizeBackingStore() {
    const dpr = window.devicePixelRatio || 1
    const cssW = container.clientWidth
    const cssH = height
    const w = Math.max(1, Math.round(cssW * dpr))
    const h = Math.max(1, Math.round(cssH * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // draw in CSS pixels from here on
    return { cssW, cssH }
  }

  function domainOf(values: number[]): [number, number] {
    if (options.domain) return options.domain
    let min = Infinity
    let max = -Infinity
    for (const v of values) {
      if (v < min) min = v
      if (v > max) max = v
    }
    if (!isFinite(min)) return [0, 1]
    if (min === max) return [min - 1, max + 1]
    const pad = (max - min) * 0.12
    return [min - pad, max + pad]
  }

  function draw() {
    frame = 0
    const { cssW, cssH } = resizeBackingStore()
    const style = getComputedStyle(container)
    const gridColor = style.getPropertyValue('--chart-grid').trim() || 'rgba(128,128,128,.18)'
    const labelColor = style.getPropertyValue('--chart-label').trim() || '#8a94a6'

    ctx.clearRect(0, 0, cssW, cssH)
    if (!series.length || !series[0].values.length) return

    const all = series.flatMap((s) => s.values)
    const [lo, hi] = domainOf(all)
    const plotW = Math.max(1, cssW - AXIS_W)
    const plotH = Math.max(1, cssH - PAD_TOP - PAD_BOTTOM)
    const n = series[0].values.length
    const x = (i: number) => AXIS_W + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW)
    const y = (v: number) => PAD_TOP + plotH - ((v - lo) / (hi - lo)) * plotH

    // Horizontal grid only, and only three lines: grid lines are scaffolding,
    // not content.
    ctx.strokeStyle = gridColor
    ctx.lineWidth = 1
    ctx.fillStyle = labelColor
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (let t = 0; t <= 2; t++) {
      const v = lo + ((hi - lo) * t) / 2
      const py = Math.round(y(v)) + 0.5 // half-pixel: crisp 1px line
      ctx.beginPath()
      ctx.moveTo(AXIS_W, py)
      ctx.lineTo(cssW, py)
      ctx.stroke()
      ctx.fillText(format(v), AXIS_W - 8, py)
    }

    // X axis (section 6): 4-6 ticks, plus a baseline for them to sit on.
    // NOTE the ticks are evenly spaced by INDEX, not by time. If your points
    // are not evenly spaced in time, index spacing lies about time -- section 6
    // means TIME-equal when it says 等距. Resample first, or pass real
    // timestamps and place the ticks by value instead.
    const labels = options.xLabels
    if (labels && labels.length === n) {
      const axisY = Math.round(PAD_TOP + plotH) + 0.5
      ctx.strokeStyle = gridColor
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(AXIS_W, axisY)
      ctx.lineTo(cssW, axisY)
      ctx.stroke()

      const want = cssW < 420 ? 4 : cssW < 700 ? 5 : 6
      const ticks = Math.min(want, n)
      ctx.fillStyle = labelColor
      ctx.textBaseline = 'top'
      for (let t = 0; t < ticks; t++) {
        const i = ticks === 1 ? 0 : Math.round((t * (n - 1)) / (ticks - 1))
        // Pin the outermost labels inside the canvas; centring them on the
        // edge would clip half the text.
        ctx.textAlign = i === 0 ? 'left' : i === n - 1 ? 'right' : 'center'
        ctx.fillText(labels[i], x(i), axisY + 6)
      }
    }

    for (const s of series) {
      ctx.strokeStyle = s.color
      ctx.lineWidth = 1.75
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      s.values.forEach((v, i) => {
        const px = x(i)
        const py = y(v)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.stroke()
    }

    // The accessible name carries the summary, since a canvas has no text.
    canvas.setAttribute(
      'aria-label',
      series
        .map((s) => `${s.label}: ${format(Math.min(...s.values))} – ${format(Math.max(...s.values))}`)
        .join('; '),
    )
  }

  /** Rule 3: coalesce every trigger into at most one draw per frame. */
  function schedule() {
    if (frame) return
    frame = requestAnimationFrame(draw)
  }

  const observer = new ResizeObserver(schedule)
  observer.observe(container)

  return {
    setData(next: Series[]) {
      series = next
      schedule()
    },
    destroy() {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
      canvas.remove()
    },
  }
}
