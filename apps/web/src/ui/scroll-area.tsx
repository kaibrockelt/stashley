// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode, useEffect, useRef, useState } from 'react'
import table from './table.module.css'

/**
 * The horizontally scrolling frame of a table. While its content overflows it takes keyboard
 * focus, so keyboard users can scroll it too (WCAG 2.1.1); otherwise it adds no tab stop.
 */
export function ScrollArea(props: { children: ReactNode; label?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = () => setOverflows(element.scrollWidth > element.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    return () => observer.disconnect()
  }, [])
  return (
    <div
      ref={ref}
      className={[table.wrap, props.className].filter(Boolean).join(' ')}
      {...(overflows && {
        tabIndex: 0,
        ...(props.label !== undefined && { role: 'region', 'aria-label': props.label }),
      })}
    >
      {props.children}
    </div>
  )
}
