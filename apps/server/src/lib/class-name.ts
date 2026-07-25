export function mergeClassNames(
  ...values: Array<string | null | undefined | false>
): string | undefined {
  const className = values.filter((value): value is string => typeof value === 'string').join(' ')
  return className || undefined
}
