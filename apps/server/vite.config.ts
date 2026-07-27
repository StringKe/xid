import { cloudflare } from '@cloudflare/vite-plugin'
import babel from '@rolldown/plugin-babel'
import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin'
import stylex from '@stylexjs/unplugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { injectPreloadHintsPlugin } from './vite-plugins/inject-preload-hints'
import { createSmokeConsoleStaticPlugin } from './vite-plugins/smoke-console-static'
import { createSmokeQueueConfig } from './vite-plugins/smoke-queue-config'

// React SPA(client)+ Hono Worker(API),@cloudflare/vite-plugin 一个项目构建。
// lingui macro 经 @rolldown/plugin-babel + linguiTransformerBabelPreset 转换(lingui v6 for Vite 8)。
// StyleX 经 @stylexjs/unplugin 独立编译 stylex.create/defineVars/createTheme 并聚合 CSS 注入 index.css。
// stylex.vite 在 react() 前:unplugin 自带 StyleX 专用 babel transform,与 lingui macro 链互不干扰。
const smokeQueueConfig = createSmokeQueueConfig({
  persistPath: process.env.XID_SMOKE_PERSIST_PATH,
  entryConfigPath: process.env.XID_SMOKE_WRANGLER_CONFIG_PATH,
  consumerConfigPath: process.env.XID_SMOKE_QUEUE_CONSUMER_WRANGLER_CONFIG_PATH,
})
const smokeConsoleStaticPlugin = createSmokeConsoleStaticPlugin(
  process.env.XID_SMOKE_CONSOLE_DIST_PATH,
)

export default defineConfig({
  build: {
    // Site owns public asset namespaces; Core UI chunks use a dedicated immutable prefix.
    assetsDir: '_core',
  },
  plugins: [
    smokeConsoleStaticPlugin,
    stylex.vite({
      useCSSLayers: true,
      dev: process.env.NODE_ENV === 'development',
      runtimeInjection: false,
    }),
    react(),
    cloudflare(smokeQueueConfig),
    lingui(),
    babel({ presets: [linguiTransformerBabelPreset()] }),
    injectPreloadHintsPlugin(),
  ],
})
