import type { PluginConfig } from '@cloudflare/vite-plugin'

type SmokeQueueConfigInput = {
  persistPath: string | undefined
  entryConfigPath: string | undefined
  consumerConfigPath: string | undefined
}

export function createSmokeQueueConfig(input: SmokeQueueConfigInput): PluginConfig | undefined {
  if (
    input.persistPath === undefined ||
    input.entryConfigPath === undefined ||
    input.consumerConfigPath === undefined
  ) {
    return undefined
  }
  return {
    configPath: input.entryConfigPath,
    auxiliaryWorkers: [{ configPath: input.consumerConfigPath, devOnly: true }],
    inspectorPort: false,
    persistState: { path: input.persistPath },
  }
}
