const OUTPUT_SUMMARY_LENGTH = 200

function outputSummary(stdout) {
  return String(stdout)
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, OUTPUT_SUMMARY_LENGTH)
}

function arrayEnd(stdout, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < stdout.length; index++) {
    const char = stdout[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '[') depth++
    if (char === ']') {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

export function parseD1Json(stdout, operation) {
  const arrays = []
  for (let start = 0; start < stdout.length; start++) {
    if (stdout[start] !== '[') continue
    const end = arrayEnd(stdout, start)
    if (end === -1) continue
    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1))
      if (Array.isArray(parsed)) {
        arrays.push(parsed)
        start = end
      }
    } catch {
      // Wrangler 前置通知可能含方括号；继续寻找真正的 JSON array。
    }
  }
  if (arrays.length === 1) return arrays[0]
  const reason = arrays.length === 0 ? 'no JSON array found' : 'multiple JSON arrays found'
  throw new Error(`${operation} failed: ${reason}; stdout=${outputSummary(stdout)}`)
}
