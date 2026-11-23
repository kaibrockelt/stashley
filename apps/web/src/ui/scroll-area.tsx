// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/use-t.ts'
import table from './table.module.css'

/**
 * The horizontally scrolling frame of a table. While its content overflows it takes keyboard
 * focus, so keyboard users can scroll it too (WCAG 2.1.1), and is a named region: `label`, the
 * caption of the table inside, or a generic name. Otherwise it adds no tab stop.
 */
export function ScrollArea(props: { children: ReactNode; label?: string; className?: string }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState<{ caption: string | null } | null>(null)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = () => {
      const overflows = element.scrollWidth > element.clientWidth + 1
      const caption = element.querySelector('caption')?.textContent?.trim() || null
      setOverflow((current) =>
        !overflows ? null : current?.caption === caption ? current : { caption },
      )
    }
    const resize = new ResizeObserver(measure)
    const observe = () => {
      resize.disconnect()
      resize.observe(element)
      for (const child of element.children) resize.observe(child)
      measure()
    }
    observe()
    // Content that is replaced later, e.g. a table after its rows load, is observed too.
    const mutations = new MutationObserver(observe)
    mutations.observe(element, { childList: true })
    return () => {
      mutations.disconnect()
      resize.disconnect()
    }
  }, [])
  return (
    <div
      ref={ref}
      className={[table.wrap, props.className].filter(Boolean).join(' ')}
      {...(overflow !== null && {
        tabIndex: 0,
        role: 'region',
        'aria-label': props.label ?? overflow.caption ?? t('ui.scrollArea'),
      })}
    >
      {props.children}
    </div>
  )
}
