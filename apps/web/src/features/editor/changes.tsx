// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { PageChange, PageDocument } from '@stashley/shared'
import { componentsOf, diffPages } from '@stashley/shared'
import { useT } from '../../i18n/use-t.ts'
import styles from './editor.module.css'

function short(value: unknown): string {
  if (value === undefined) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

/**
 * The structured diff of two documents (§13.2), grouped per component and setting. `before`
 * and `after` name the two sides, e.g. "version 3" and "draft".
 */
export function ChangeList(props: { before: PageDocument; after: PageDocument }) {
  const t = useT()
  const changes = diffPages(props.before, props.after)
  const titles = new Map<string, string>()
  for (const document of [props.before, props.after]) {
    for (const { component } of componentsOf(document))
      titles.set(`component:${component.id}`, component.title || component.id)
    for (const filter of document.filters)
      titles.set(`filter:${filter.id}`, filter.label || filter.id)
  }
  if (changes.length === 0) return <p className={styles.muted}>{t('changes.none')}</p>
  const groups = new Map<string, PageChange[]>()
  for (const change of changes)
    groups.set(change.scope, [...(groups.get(change.scope) ?? []), change])
  const scopeLabel = (scope: string) => {
    if (scope === 'page') return t('changes.scope.page')
    if (scope.startsWith('row:')) return t('changes.scope.row', { id: scope.slice(4) })
    if (scope.startsWith('filter:'))
      return t('changes.scope.filter', { name: titles.get(scope) ?? scope.slice(7) })
    return t('changes.scope.component', { name: titles.get(scope) ?? scope.slice(10) })
  }
  const kindLabel = {
    added: t('changes.added'),
    removed: t('changes.removed'),
    changed: t('changes.changed'),
    moved: t('changes.moved'),
  }
  return (
    <div className={styles.changes}>
      {[...groups].map(([scope, entries]) => (
        <section key={scope}>
          <h3 className={styles.changesTitle}>{scopeLabel(scope)}</h3>
          <ul>
            {entries.map((change, index) => (
              <li key={index}>
                <span className={styles.changeKind}>{kindLabel[change.kind]}</span>{' '}
                {change.path !== '' && <code>{change.path}</code>}
                {change.kind === 'changed' && (
                  <span className={styles.muted}>
                    {' '}
                    {short(change.before)} → {short(change.after)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
