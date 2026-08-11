// L3 harness 仅 development/test 可用。

export function isDevOrTestEnvironment(env: Env): boolean {
  const envName = env.ENVIRONMENT?.toLowerCase() ?? 'production'
  return envName === 'development' || envName === 'test'
}
