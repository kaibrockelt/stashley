// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Date expressions of generated fields (§11 step 3): `now`, `today`, optionally with one
 * offset such as `now + 1d`, `now - 2h` or `today + 7d`. They are evaluated in the instance
 * time zone (`APP_TIMEZONE`): offsets in minutes and hours add exact time, days, weeks, months
 * and years move the wall date and keep the wall time, like Temporal's `ZonedDateTime.add`.
 *
 * The client uses the same code to show a suggestion, so it relies on `Intl` instead of
 * Temporal, which not every browser has yet.
 */

export const dateUnits = ['min', 'h', 'd', 'w', 'mo', 'y'] as const
export type DateUnit = (typeof dateUnits)[number]

export interface DateExpression {
  base: 'now' | 'today'
  offset: { amount: number; unit: DateUnit } | null
}

const pattern = /^\s*(now|today)\s*(?:([+-])\s*(\d{1,4})\s*(min|mo|h|d|w|y)\s*)?$/

export function parseDateExpression(text: string): DateExpression | undefined {
  const match = pattern.exec(text)
  if (match === null) return undefined
  const base = match[1] as DateExpression['base']
  if (match[2] === undefined) return { base, offset: null }
  const amount = Number(match[3]) * (match[2] === '-' ? -1 : 1)
  return { base, offset: { amount, unit: match[4] as DateUnit } }
}

export function formatDateExpression(expression: DateExpression): string {
  if (expression.offset === null) return expression.base
  const { amount, unit } = expression.offset
  return `${expression.base} ${amount < 0 ? '-' : '+'} ${Math.abs(amount)}${unit}`
}

/** A wall time: calendar fields without a time zone. */
export interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      era: 'short',
    })
    formatters.set(timeZone, format)
  }
  return format
}

/** The wall time of an instant (whole seconds) in a time zone. */
export function wallTimeOf(instant: number, timeZone: string): WallTime {
  const parts: Record<string, string> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    parts[part.type] = part.value
  }
  const year = Number(parts.year)
  return {
    year: parts.era === 'BC' || parts.era === 'B' ? 1 - year : year,
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

function wallAsUtc(wall: WallTime): number {
  const date = new Date(0)
  date.setUTCFullYear(wall.year, wall.month - 1, wall.day)
  date.setUTCHours(wall.hour, wall.minute, wall.second, 0)
  return date.getTime()
}

/** Milliseconds a time zone is ahead of UTC at an instant. */
function offsetAt(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000
  return wallAsUtc(wallTimeOf(whole, timeZone)) - whole
}

const day = 86_400_000

/**
 * The instant of a wall time, with Temporal's `compatible` disambiguation: in a gap the wall
 * time moves forward by the gap's length, in an overlap the earlier instant wins.
 */
export function instantOf(wall: WallTime, timeZone: string): number {
  const local = wallAsUtc(wall)
  const before = offsetAt(local - day, timeZone)
  const after = offsetAt(local + day, timeZone)
  const candidates = [local - before, local - after].filter(
    (instant) => offsetAt(instant, timeZone) === local - instant,
  )
  if (candidates.length > 0) return Math.min(...candidates)
  return local - before
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month, 0)
  return date.getUTCDate()
}

function addCalendar(wall: WallTime, unit: 'd' | 'w' | 'mo' | 'y', amount: number): WallTime {
  if (unit === 'd' || unit === 'w') {
    const date = new Date(0)
    date.setUTCFullYear(wall.year, wall.month - 1, wall.day + amount * (unit === 'w' ? 7 : 1))
    return {
      ...wall,
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    }
  }
  const months = wall.year * 12 + (wall.month - 1) + amount * (unit === 'y' ? 12 : 1)
  const year = Math.floor(months / 12)
  const month = months - year * 12 + 1
  // Like Temporal's `overflow: 'constrain'`: 31 January + 1 month is 28 or 29 February.
  return { ...wall, year, month, day: Math.min(wall.day, daysInMonth(year, month)) }
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0')

export function formatWallDate(wall: Pick<WallTime, 'year' | 'month' | 'day'>): string {
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`
}

/**
 * Evaluates an expression at `now` (milliseconds) in `timeZone`. Date columns get the wall
 * date (`YYYY-MM-DD`), date-time columns a UTC instant in whole seconds (`…Z`).
 */
export function evaluateDateExpression(
  expression: DateExpression,
  now: number,
  timeZone: string,
  kind: 'date' | 'datetime' | 'timestamp',
): string {
  let instant = Math.floor(now / 1000) * 1000
  if (expression.base === 'today') {
    const wall = wallTimeOf(instant, timeZone)
    instant = instantOf({ ...wall, hour: 0, minute: 0, second: 0 }, timeZone)
  }
  const offset = expression.offset
  if (offset !== null) {
    if (offset.unit === 'min' || offset.unit === 'h') {
      instant += offset.amount * (offset.unit === 'h' ? 3_600_000 : 60_000)
    } else {
      instant = instantOf(
        addCalendar(wallTimeOf(instant, timeZone), offset.unit, offset.amount),
        timeZone,
      )
    }
  }
  if (kind === 'date') return formatWallDate(wallTimeOf(instant, timeZone))
  return new Date(instant).toISOString().replace('.000Z', 'Z')
}
