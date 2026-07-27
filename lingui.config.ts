import { defineConfig } from '@lingui/conf'
import { formatter } from '@lingui/format-po'

// 全仓库共用一份 catalog。config 放仓库根,各 app 的 @lingui/vite-plugin 向上搜索到此。
// catalog 产物落在 packages/i18n/locales,运行时由 @xid-kit/i18n import。见 i18n-lingui rule。
export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR'],
  // compile 产物用 ESM(export const messages),供浏览器 Vite import() 加载。
  // 默认 cjs(module.exports=)在浏览器 ESM 下 module is not defined,catalog 加载抛错,
  // 致 i18n.activate 不执行 -> "without setting a locale" 竞态。
  compileNamespace: 'es',
  catalogs: [
    {
      path: '<rootDir>/packages/i18n/locales/{locale}/messages',
      // 限定到源码,排除生成的 .d.ts(如 worker-configuration.d.ts)、产物与测试,
      // 否则 babel 解析 ambient 声明会报错并中断 extract。
      // include 必须显式 /** 递归:lingui 用 node:fs globSync,含通配符的 include(apps/*/src)
      // 不被识别为目录,不会自动补 /**/*.*,只匹配目录本身致深层 route 文件漏扫。
      include: ['apps/*/src/**', 'apps/*/worker/**', 'packages/*/src/**'],
      exclude: [
        '**/*.d.ts',
        '**/dist/**',
        '**/node_modules/**',
        '**/__tests__/**',
      ],
    },
  ],
  format: formatter({ lineNumbers: false }),
})
