// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ReactNode } from 'react'
import { useT } from '../i18n/use-t.ts'
import styles from './sortable.module.css'

const escapeSelector = (value: string) => window.CSS.escape(value)

/**
 * A sortable list with pointer and keyboard dragging (§22: dnd-kit with its keyboard sensor).
 * Space or Enter on the handle picks an item up, the arrow keys move it, Space drops it.
 */
export function SortableList<T extends { id: string }>(props: {
  items: readonly T[]
  onReorder: (items: T[]) => void
  label: (item: T) => string
  direction?: 'vertical' | 'horizontal'
  children: (item: T, handle: ReactNode) => ReactNode
  className?: string
}) {
  const t = useT()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const name = (id: string | number) => {
    const item = props.items.find((entry) => entry.id === id)
    return item === undefined ? String(id) : props.label(item)
  }
  const position = (id: string | number | undefined) =>
    props.items.findIndex((entry) => entry.id === id) + 1
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t('sort.picked', { item: name(active.id), position: position(active.id) }),
    onDragOver: ({ active, over }) =>
      over === null
        ? undefined
        : t('sort.over', { item: name(active.id), position: position(over.id) }),
    onDragEnd: ({ active, over }) =>
      t('sort.dropped', { item: name(active.id), position: position(over?.id ?? active.id) }),
    onDragCancel: ({ active }) => t('sort.cancelled', { item: name(active.id) }),
  }
  const end = (event: DragEndEvent) => {
    const { active, over } = event
    // After the list re-renders, focus stays on the handle of the moved item, so keyboard
    // users can keep moving it; dnd-kit's own restore can land on its old neighbour.
    window.setTimeout(() => {
      document
        .querySelector<HTMLElement>(`[data-sort-handle="${escapeSelector(String(active.id))}"]`)
        ?.focus()
    }, 50)
    if (over === null || active.id === over.id) return
    const from = props.items.findIndex((entry) => entry.id === active.id)
    const to = props.items.findIndex((entry) => entry.id === over.id)
    if (from < 0 || to < 0) return
    props.onReorder(arrayMove([...props.items], from, to))
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={end}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t('sort.instructions') },
      }}
    >
      <SortableContext
        items={props.items.map((item) => item.id)}
        strategy={
          props.direction === 'horizontal'
            ? horizontalListSortingStrategy
            : verticalListSortingStrategy
        }
      >
        <div
          className={[
            props.direction === 'horizontal' ? styles.horizontal : styles.vertical,
            props.className,
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {props.items.map((item) => (
            <SortableItem key={item.id} id={item.id} label={props.label(item)}>
              {(handle) => props.children(item, handle)}
            </SortableItem>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

function SortableItem(props: {
  id: string
  label: string
  children: (handle: ReactNode) => ReactNode
}) {
  const t = useT()
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.id })
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      className={styles.handle}
      aria-label={t('sort.handle', { item: props.label })}
      data-sort-handle={props.id}
      {...attributes}
      {...listeners}
    >
      <span aria-hidden="true">⠿</span>
    </button>
  )
  return (
    <div
      ref={setNodeRef}
      className={[styles.item, isDragging && styles.dragging].filter(Boolean).join(' ')}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      {props.children(handle)}
    </div>
  )
}
