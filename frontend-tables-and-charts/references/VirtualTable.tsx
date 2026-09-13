// Fixed-height virtualized table. No third-party dependencies: with a fixed row
// height the window arithmetic is a few lines, and a fixed height is also what
// keeps every other stability rule in `frontend-table-design` cheap.
//
// Pair with references/table.css. Column widths live in the <colgroup>, so the
// browser never measures content to size a column -- that is what stops columns
// from drifting during scroll.
//
// This is a starting point, not a drop-in component: wire it to your own data
// source, sorting and selection.
//
// Row height appears in three places that must agree:
//   - the `rowHeight` prop below
//   - `height: 36px` in table.css
//   - `contain-intrinsic-size` if you enable it there

import { memo, useEffect, useMemo, useRef, useState } from 'react'

export interface Column<T> {
  key: string
  title: string
  /** Any CSS width: '240px', '12ch', '2fr'. Explicit widths are required. */
  width: string
  align?: 'left' | 'right' | 'center'
  render: (row: T) => React.ReactNode
}

interface Props<T> {
  rows: T[]
  columns: Column<T>[]
  rowHeight?: number
  /** Viewport height of the scroller, in px. */
  height?: number
  overscan?: number
  rowKey: (row: T) => string
}

function VirtualTableInner<T>({
  rows,
  columns,
  rowHeight = 36,
  height = 480,
  overscan = 4,
  rowKey,
}: Props<T>) {
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)

  // The <colgroup> is derived once per columns identity. Memoize `columns` at the
  // call site too, or this rebuilds every render.
  const colgroup = useMemo(
    () => columns.map((c) => <col key={c.key} style={{ width: c.width }} />),
    [columns],
  )

  const totalHeight = rows.length * rowHeight
  const visibleCount = Math.ceil(height / rowHeight) + overscan * 2
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(rows.length, start + visibleCount)
  const slice = rows.slice(start, end)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let frame = 0
    // Passive listener, no layout reads: the offset comes from the event target,
    // never from getBoundingClientRect(). One state update per animation frame.
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setScrollTop(el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div
      ref={scroller}
      className="table-scroll"
      style={{ height, position: 'relative' }}
      role="grid"
      aria-rowcount={rows.length}
      tabIndex={0}
    >
      {/* Header lives outside the scrolling spacer so it never re-mounts. */}
      <table className="data-table">
        <colgroup>{colgroup}</colgroup>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" style={{ textAlign: c.align ?? 'left' }}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
      </table>

      {/* Spacer carries the full scroll height; the body is offset inside it. */}
      <div style={{ height: totalHeight, position: 'relative' }}>
        <table
          className="data-table"
          style={{ position: 'absolute', top: start * rowHeight, left: 0 }}
        >
          <colgroup>{colgroup}</colgroup>
          <tbody>
            {slice.map((row) => (
              <Row key={rowKey(row)} row={row} columns={columns} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Memoized on row identity. During fast scrolling the parent re-renders every
// frame; without this comparator every visible row re-renders with it.
const Row = memo(
  function Row<T>({ row, columns }: { row: T; columns: Column<T>[] }) {
    return (
      <tr>
        {columns.map((c) => (
          <td
            key={c.key}
            className={
              c.align === 'right' ? 'num' : c.align === 'center' ? 'center' : undefined
            }
          >
            {c.render(row)}
          </td>
        ))}
      </tr>
    )
  },
  (a, b) => a.row === b.row && a.columns === b.columns,
) as <T>(props: { row: T; columns: Column<T>[] }) => React.ReactElement

export const VirtualTable = VirtualTableInner
