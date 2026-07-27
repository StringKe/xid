import icon from 'astro-icon'
import nimbus, { defineConfig as defineNimbusConfig } from '@cloudflare/nimbus-docs'
import { tableScroll } from '@cloudflare/nimbus-docs/markdown'
import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'
import { mermaidCodeBlock } from './src/markdown/mermaid-code-block'

const nimbusConfig = defineNimbusConfig({
  site: 'https://xid.dev',
  title: 'XID',
  description: 'Edge-native identity infrastructure on Cloudflare.',
  locale: 'en',
  github: 'https://github.com/StringKe/xid',
  socialImageAlt: 'XID identity platform documentation',
})

export default defineConfig({
  output: 'static',
  trailingSlash: 'never',
  vite: {
    plugins: [tailwindcss(), lingui(), babel({ presets: [linguiTransformerBabelPreset()] })],
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  integrations: [
    icon(),
    nimbus(nimbusConfig, {
      sitemap: {
        serialize(item) {
          const pathname = new URL(item.url).pathname
          return pathname === '/404' || pathname.endsWith('/404') ? undefined : item
        },
      },
      rules: {
        'nimbus/frontmatter-shape': 'error',
        'nimbus/internal-link': 'error',
      },
      markdown: {
        hastPlugins: [tableScroll(), mermaidCodeBlock()],
      },
    }),
  ],
})
