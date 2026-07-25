export function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1
  }
  return value.slice(0, end)
}

export function trimLeadingSlashes(value: string): string {
  let start = 0
  while (start < value.length && value.charCodeAt(start) === 47) {
    start += 1
  }
  return value.slice(start)
}
