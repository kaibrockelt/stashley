// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { autocompletion, closeBrackets, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { MariaSQL, MySQL, sql } from '@codemirror/lang-sql'
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view'
import { useEffect, useRef } from 'react'

/** Read once: CodeMirror inserts its styles with the page's CSP nonce (§14.7). */
function cspNonce(): string | undefined {
  return document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content || undefined
}

const theme = EditorView.theme({
  '&': {
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    fontSize: 'var(--font-size-sm)',
  },
  '&.cm-focused': { outline: '2px solid var(--color-focus)', outlineOffset: '1px' },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    minHeight: '12rem',
    caretColor: 'var(--color-text)',
  },
  '.cm-gutters': {
    background: 'var(--color-bg)',
    color: 'var(--color-text-muted)',
    border: 'none',
  },
  '.cm-activeLine': { background: 'transparent' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    background: 'var(--color-accent-subtle)',
  },
  '.cm-tooltip': {
    background: 'var(--color-surface-raised)',
    border: '1px solid var(--color-border)',
  },
})

export interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  /** Exposed objects and their columns, for completion (§ SQL-Editor). */
  schema: Record<string, string[]>
  dialect: 'mariadb' | 'mysql' | null
  label: string
  placeholderText: string
  /** A position to select, e.g. where the validation found a problem. */
  focus?: { offset: number; nonce: number } | undefined
  readOnly?: boolean
}

export default function SqlEditorView(props: SqlEditorProps) {
  const parent = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const language = useRef(new Compartment())
  const editable = useRef(new Compartment())
  const onChange = useRef(props.onChange)
  useEffect(() => {
    onChange.current = props.onChange
  }, [props.onChange])

  useEffect(() => {
    if (parent.current === null) return
    const nonce = cspNonce()
    const instance = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          ...(nonce === undefined ? [] : [EditorView.cspNonce.of(nonce)]),
          lineNumbers(),
          history(),
          closeBrackets(),
          bracketMatching(),
          autocompletion(),
          syntaxHighlighting(defaultHighlightStyle),
          keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          placeholder(props.placeholderText),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': props.label, 'aria-multiline': 'true' }),
          theme,
          language.current.of([]),
          editable.current.of(EditorState.readOnly.of(props.readOnly === true)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = instance
    return () => {
      instance.destroy()
      view.current = null
    }
    // The editor is created once; later props arrive through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    view.current?.dispatch({
      effects: language.current.reconfigure(
        sql({
          dialect: props.dialect === 'mysql' ? MySQL : MariaSQL,
          schema: props.schema,
          upperCaseKeywords: true,
        }),
      ),
    })
  }, [props.schema, props.dialect])

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorState.readOnly.of(props.readOnly === true)),
    })
  }, [props.readOnly])

  useEffect(() => {
    const current = view.current
    if (current === null || current.state.doc.toString() === props.value) return
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: props.value } })
  }, [props.value])

  useEffect(() => {
    const current = view.current
    if (current === null || props.focus === undefined) return
    const at = Math.max(0, Math.min(props.focus.offset, current.state.doc.length))
    current.dispatch({ selection: EditorSelection.cursor(at), scrollIntoView: true })
    current.focus()
  }, [props.focus])

  return <div ref={parent} />
}
