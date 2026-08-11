// constant-time 计时采样:比较两路径均值差是否在阈值内(账户枚举防护)。

export type TimingSample = {
  durationMs: number
}

export async function measureMs(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now()
  await fn()
  return performance.now() - start
}

export async function collectSamples(
  fn: () => Promise<unknown>,
  n: number,
): Promise<TimingSample[]> {
  const results: TimingSample[] = []
  for (let i = 0; i < n; i++) {
    const durationMs = await measureMs(fn)
    results.push({ durationMs })
  }
  return results
}

export function mean(samples: TimingSample[]): number {
  if (samples.length === 0) return 0
  const sum = samples.reduce((acc, s) => acc + s.durationMs, 0)
  return sum / samples.length
}

export function p95(samples: TimingSample[]): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a.durationMs - b.durationMs)
  const idx = Math.floor(sorted.length * 0.95)
  const picked = sorted[idx] ?? sorted[sorted.length - 1]
  return picked?.durationMs ?? 0
}

export function assertConstantTime(
  pathA: TimingSample[],
  pathB: TimingSample[],
  thresholdMs: number,
): string | null {
  const meanA = mean(pathA)
  const meanB = mean(pathB)
  const diff = Math.abs(meanA - meanB)
  if (diff > thresholdMs) {
    return `timing diff ${diff.toFixed(2)}ms exceeds threshold ${thresholdMs}ms (pathA mean=${meanA.toFixed(2)}ms, pathB mean=${meanB.toFixed(2)}ms)`
  }
  return null
}

export async function assertPathsConstantTime(
  pathA: () => Promise<unknown>,
  pathB: () => Promise<unknown>,
  options: { samples?: number; thresholdMs?: number } = {},
): Promise<string | null> {
  const { samples = 30, thresholdMs = 50 } = options
  const [samplesA, samplesB] = await Promise.all([
    collectSamples(pathA, samples),
    collectSamples(pathB, samples),
  ])
  return assertConstantTime(samplesA, samplesB, thresholdMs)
}
