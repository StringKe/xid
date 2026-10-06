// <input type="datetime-local"> 的值是浏览器本地墙钟时间,不带时区;与 ISO 字符串互转必须经本地时区换算。

export function toLocalDateTime(value: string | Date | null): string {
  if (!value) return ''
  const date = typeof value === 'string' ? new Date(value) : value
  if (!Number.isFinite(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export function nowLocalDateTime(): string {
  return toLocalDateTime(new Date())
}

export function fromLocalDateTime(value: string): string | null {
  if (value === '') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
