// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Freshness, RenderComponent } from '@stashley/shared'
import { useEffect, useState, type ReactNode } from 'react'
import { useIntl } from 'react-intl'
import { ApiError } from '../../../api/client.ts'
import { useT } from '../../../i18n/use-t.ts'
import { Badge, Button } from '../../../ui/controls.tsx'
import { formatRelative } from '../format.ts'
import { usePageContext } from '../page-context.tsx'
import styles from './blocks.module.css'

/** "Data as of 3 min ago", updated every 30 s (§12). */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export function FreshnessLine(props: {
  freshness: Freshness | undefined
  onRefresh?: (() => void) | undefined
  refreshing?: boolean
  refreshError?: unknown
}) {
  const t = useT()
  const intl = useIntl()
  const now = useNow()
  const { designer } = usePageContext()
  const freshness = props.freshness
  if (freshness === undefined) return null
  const limited =
    props.refreshError instanceof ApiError && props.refreshError.code === 'rate_limited'
  return (
    <div className={styles.foot}>
      <span>{t('block.fetched', { time: formatRelative(intl, freshness.fetchedAt, now) })}</span>
      {freshness.stale && <Badge tone="warning">{t('block.stale')}</Badge>}
      {props.onRefresh !== undefined && (
        <Button variant="ghost" onPress={props.onRefresh} isDisabled={props.refreshing === true}>
          {t('block.refresh')}
        </Button>
      )}
      {limited && <span role="status">{t('block.refreshLimited')}</span>}
      {designer && freshness.hint?.code === 'slow_live_query' && (
        <span>{t('block.slowLive', { seconds: freshness.hint.recommendedTtlSeconds })}</span>
      )}
      {designer && freshness.notCached === 'too_large' && <span>{t('block.tooLarge')}</span>}
    </div>
  )
}

/** Title, description, tools and the body of a block. */
export function BlockFrame(props: {
  component: RenderComponent
  tools?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  const component = props.component
  const headingId = `block-${component.id}`
  return (
    <section
      className={styles.block}
      aria-labelledby={component.title === '' ? undefined : headingId}
    >
      {(component.title !== '' || props.tools !== undefined) && (
        <div className={styles.head}>
          <div>
            {component.title !== '' && (
              <h2 id={headingId} className={styles.title}>
                {component.title}
              </h2>
            )}
            {component.description !== undefined && component.description !== '' && (
              <p className={styles.description}>{component.description}</p>
            )}
          </div>
          {props.tools !== undefined && <div className={styles.tools}>{props.tools}</div>}
        </div>
      )}
      <div className={styles.body}>{props.children}</div>
      {props.footer}
    </section>
  )
}

/** Loading, empty and error states inside a block (§ Ergebnisformen). */
export function BlockState(props: { kind: 'loading' | 'empty' | 'error' | 'unconfigured' }) {
  const t = useT()
  const text = {
    loading: t('block.loading'),
    empty: t('block.empty'),
    error: t('block.error'),
    unconfigured: t('block.unconfigured'),
  }[props.kind]
  return (
    <div className={styles.state} role={props.kind === 'error' ? 'alert' : 'status'}>
      {text}
    </div>
  )
}

/** A hint for managers when a result exceeds the limits of its visualization. */
export function LimitHint(props: { exceeded: boolean; truncated?: boolean }) {
  const t = useT()
  const { designer } = usePageContext()
  if (!designer || (!props.exceeded && props.truncated !== true)) return null
  return (
    <p className={styles.hint}>
      {props.truncated === true ? t('block.truncated') : t('block.exceeded')}
    </p>
  )
}
