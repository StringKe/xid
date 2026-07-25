// Local L3 harness routes are only available in development/test environments.

export function isDevOrTestEnvironment(env: Env): boolean {
  const envName = env.ENVIRONMENT?.toLowerCase() ?? 'production'
  return envName === 'development' || envName === 'test'
}
