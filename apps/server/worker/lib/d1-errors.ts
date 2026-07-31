// D1 wraps SQLite errors through a short cause chain. Callers map only the stable constraint class;
// provider detail remains server-side and is never returned to clients.
export function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (!(current instanceof Error)) return false
    if (/unique constraint/iu.test(current.message)) return true
    current = current.cause
  }
  return false
}
