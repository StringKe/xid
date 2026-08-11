// 严格按 XML Schema dateTime 解析。不用 Date.parse:它接受非 dateTime 形态并会归一非法日历日。

const SAML_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/

export function parseSamlInstant(value: string | null): number | null {
  if (!value) return null
  const match = SAML_DATE_TIME.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const fraction = match[7] ?? ''
  const zone = match[8]
  const offsetSign = match[9]
  const offsetHour = Number(match[10] ?? 0)
  const offsetMinute = Number(match[11] ?? 0)

  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null
  }

  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  calendar.setUTCHours(hour, minute, second, Number(`${fraction}000`.slice(0, 3)))
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) {
    return null
  }

  const offsetMs =
    zone === 'Z' ? 0 : (offsetHour * 60 + offsetMinute) * 60 * 1000 * (offsetSign === '+' ? 1 : -1)
  const instant = calendar.getTime() - offsetMs
  return Number.isFinite(instant) ? instant : null
}
