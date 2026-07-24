// constant-time 计时采样 helper(见 anti-abuse rule:账户枚举防护,响应时间归一化)。
// 用于测试认证接口的 timing 一致性:比较"用户存在"与"用户不存在"的响应时间分布。
// 原则:采样 N 次,计算均值/P95,断言两路径的均值差在阈值内(如 20ms)。

export type TimingSample = {
  durationMs: number
}

// 计时单次调用。
export async function measureMs(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now()
  await fn()
  return performance.now() - start
}

// 采样 N 次,返回 durationMs 数组。
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

// 计算均值。
export function mean(samples: TimingSample[]): number {
  if (samples.length === 0) return 0
  const sum = samples.reduce((acc, s) => acc + s.durationMs, 0)
  return sum / samples.length
}

// 计算 P95(第 95 百分位)。
export function p95(samples: TimingSample[]): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a.durationMs - b.durationMs)
  const idx = Math.floor(sorted.length * 0.95)
  const picked = sorted[idx] ?? sorted[sorted.length - 1]
  return picked?.durationMs ?? 0
}

// 断言两条路径的均值差在 thresholdMs 内。
// 失败时返回诊断信息字符串;通过返回 null。
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

// 采样两条路径并断言 constant-time。
// 适合在 it('timing is uniform') 中直接调用。
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
