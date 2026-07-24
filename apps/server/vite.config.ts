import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import babel from '@rolldown/plugin-babel'
import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin'
import stylex from '@stylexjs/unplugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import {
  isBlockedDocsRoutePath,
  isInternalRepositoryDocsFsPath,
} from './src/routes/docs/dev-server-guard'
import { getPublicDocsRouteDecision, isDocsPath } from './public-docs'
import { injectPreloadHintsPlugin } from './vite-plugins/inject-preload-hints'
import { createSmokeQueueConfig } from './vite-plugins/smoke-queue-config'
import { stripIndexHtmlCommentsPlugin } from './vite-plugins/strip-index-html-comments'

// React SPA(client)+ Hono Worker(API),@cloudflare/vite-plugin 一个项目构建。
// lingui macro 经 @rolldown/plugin-babel + linguiTransformerBabelPreset 转换(lingui v6 for Vite 8)。
// StyleX 经 @stylexjs/unplugin 独立编译 stylex.create/defineVars/createTheme 并聚合 CSS 注入 index.css。
// stylex.vite 在 react() 前:unplugin 自带 StyleX 专用 babel transform,与 lingui macro 链互不干扰。
const internalDocsPath = fileURLToPath(new URL('../../docs/', import.meta.url))
const internalDocsFsPrefix = `/@fs${internalDocsPath}`
const smokeQueueConfig = createSmokeQueueConfig({
  persistPath: process.env.XID_SMOKE_PERSIST_PATH,
  entryConfigPath: process.env.XID_SMOKE_WRANGLER_CONFIG_PATH,
  consumerConfigPath: process.env.XID_SMOKE_QUEUE_CONSUMER_WRANGLER_CONFIG_PATH,
})

export default defineConfig({
  plugins: [
    {
      name: 'xid-block-internal-docs-fs',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const pathname = new URL(req.url ?? '/', 'http://xid.local').pathname
          if (isDocsPath(pathname)) {
            const decision = getPublicDocsRouteDecision(pathname)
            server.config.logger.info(
              `[xid:docs] ${decision.status} path=${decision.normalizedPath} slug=${decision.slug ?? 'null'} contentSource=${decision.contentSource} repoDocsMarkdownServed=false`,
            )
          }
          if (isBlockedDocsRoutePath(pathname)) {
            res.statusCode = 404
            res.setHeader('x-xid-docs-route-status', getPublicDocsRouteDecision(pathname).status)
            res.end('This path is not part of the published XID developer docs.')
            return
          }
          if (isInternalRepositoryDocsFsPath(pathname, internalDocsFsPrefix)) {
            res.statusCode = 404
            res.end('Internal repository docs are not served by the XID docs app.')
            return
          }
          next()
        })
      },
    },
    stylex.vite({
      useCSSLayers: true,
      dev: process.env.NODE_ENV === 'development',
      runtimeInjection: false,
    }),
    react(),
    cloudflare(smokeQueueConfig),
    lingui(),
    babel({ presets: [linguiTransformerBabelPreset()] }),
    stripIndexHtmlCommentsPlugin(),
    injectPreloadHintsPlugin(),
  ],
})
