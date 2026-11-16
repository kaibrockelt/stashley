// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Names for new tables and columns (§17 step 7, E28) and the matching of CSV headers to
 * columns (§17 step 3): snake_case, transliterated, at most 64 characters, never a reserved
 * word of MySQL or MariaDB.
 */

export const maxIdentifierLength = 64

/** Reserved words of MySQL 8.4/9 and MariaDB 10.11–12, lower case. */
const reserved = new Set(
  `accessible add all alter analyze and as asc asensitive before between bigint binary blob both
  by call cascade case change char character check collate column condition constraint continue
  convert create cross cube cume_dist current_date current_role current_time current_timestamp
  current_user cursor database databases day_hour day_microsecond day_minute day_second dec
  decimal declare default delayed delete delete_domain_id dense_rank desc describe deterministic
  distinct distinctrow div do_domain_ids double drop dual each else elseif empty enclosed escaped
  except exists exit explain false fetch first_value float float4 float8 for force foreign from
  fulltext function general generated get grant group grouping groups having high_priority
  hour_microsecond hour_minute hour_second if ignore ignore_domain_ids ignore_server_ids in index
  infile inner inout insensitive insert int int1 int2 int3 int4 int8 integer intersect interval
  into io_after_gtids io_before_gtids is iterate join json_table key keys kill lag last_value
  lateral lead leading leave left like limit linear lines load localtime localtimestamp lock long
  longblob longtext loop low_priority master_bind master_heartbeat_period
  master_ssl_verify_server_cert match maxvalue mediumblob mediumint mediumtext middleint
  minute_microsecond minute_second mod modifies natural not no_write_to_binlog nth_value ntile
  null numeric of offset on optimize optimizer_costs option optionally or order out outer outfile
  over page_checksum parse_vcol_expr partition percent_rank position precision primary procedure
  purge range rank read reads read_write real recursive ref_system_id references regexp release
  rename repeat replace require resignal restrict return returning revoke right rlike row
  row_number rows schema schemas second_microsecond select sensitive separator set show signal
  slow smallint spatial specific sql sqlexception sqlstate sqlwarning sql_big_result
  sql_calc_found_rows sql_small_result ssl starting stats_auto_recalc stats_persistent
  stats_sample_pages stored straight_join system table terminated then tinyblob tinyint tinytext
  to trailing trigger true undo union unique unlock unsigned update usage use using utc_date
  utc_time utc_timestamp values varbinary varchar varcharacter varying virtual when where while
  window with write xor year_month zerofill`
    .split(/\s+/)
    .filter((word) => word !== ''),
)

export function isReservedWord(name: string): boolean {
  return reserved.has(name.toLowerCase())
}

const transliterations: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  æ: 'ae',
  ø: 'oe',
  å: 'aa',
  œ: 'oe',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  đ: 'd',
}

/**
 * Lower-case ASCII words of a text: camelCase boundaries split, transliterated, accents
 * removed, any other character a separator.
 */
function words(text: string): string[] {
  const split = text.replace(/(\p{Ll}|\d)(\p{Lu})/gu, '$1 $2').toLowerCase()
  return [...split]
    .map((char) => transliterations[char] ?? char)
    .join('')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
}

function shorten(name: string, length: number): string {
  return name.slice(0, length).replace(/_+$/, '')
}

/**
 * A snake_case identifier: transliterated (ä → ae, ß → ss), a letter first (`c_` before a
 * leading digit), at most 64 characters, reserved words with an appended `_`.
 */
export function normalizeName(text: string, fallback = 'unnamed'): string {
  let name = words(text).join('_')
  if (name === '') name = fallback
  if (/^\d/.test(name)) name = `c_${name}`
  name = shorten(name, maxIdentifierLength)
  if (isReservedWord(name)) name = `${shorten(name, maxIdentifierLength - 1)}_`
  return name
}

/** Names made unique in order: later duplicates get `_2`, `_3`, … (case-insensitive). */
export function uniqueNames(names: readonly string[], taken: readonly string[] = []): string[] {
  const used = new Set(taken.map((name) => name.toLowerCase()))
  return names.map((name) => {
    let candidate = name
    for (let index = 2; used.has(candidate.toLowerCase()); index++) {
      const suffix = `_${index}`
      candidate = `${shorten(name, maxIdentifierLength - suffix.length)}${suffix}`
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

/** The key two names match on: case, separators and accents do not count (§17 step 3). */
export function matchKey(text: string): string {
  return words(text).join('')
}

/** Whether a name can be used as a new table or column name as it is. */
export function isValidNewName(name: string): boolean {
  return (
    /^[a-z][a-z0-9_]*$/.test(name) && name.length <= maxIdentifierLength && !isReservedWord(name)
  )
}
