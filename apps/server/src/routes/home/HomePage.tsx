// HomePage:xid.dev landing 根路由 ('/')。设计稿 v2:edge-native hero(trace 终端 +
// 节点带)、平台 bento、协议步进器、集成代码标签、联合证据矩阵、定价、深色 CTA 横幅。
// 色彩并入产品 --xid-* token,跟随 light/dark 与品牌覆盖;仅代码面板保持深色高亮。

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { lx } from './landing-theme.stylex'
import { CtaBandSection } from './CtaBandSection'
import { FederationSection } from './FederationSection'
import { HeroSection } from './HeroSection'
import { HowSection } from './HowSection'
import { IntegrateSection } from './IntegrateSection'
import { PlatformSection } from './PlatformSection'
import { PricingSection } from './PricingSection'
import { SiteFooter } from './SiteFooter'
import { SiteHeader } from './SiteHeader'
import { EdgeProbeProvider } from './EdgeProbeProvider'

const styles = stylex.create({
  root: {
    minHeight: '100dvh',
    color: lx.primary,
    backgroundColor: lx.page,
    fontFamily: lx.sans,
  },
})

export default function HomePage(): ReactNode {
  // LCP 后 idle 再挂载 fold 以下节,避免首帧批量 IO/Reveal 触发强制重排。
  const [belowFold, setBelowFold] = useState(false)

  useEffect(() => {
    if ('requestIdleCallback' in globalThis) {
      const idleId = globalThis.requestIdleCallback(() => setBelowFold(true), { timeout: 1_500 })
      return () => globalThis.cancelIdleCallback(idleId)
    }
    const timeoutId = globalThis.setTimeout(() => setBelowFold(true), 200)
    return () => globalThis.clearTimeout(timeoutId)
  }, [])

  return (
    <EdgeProbeProvider>
      <div {...stylex.props(styles.root)}>
        <SiteHeader trackSections={belowFold} />
        <main>
          <HeroSection />
          {belowFold ? (
            <>
              <PlatformSection />
              <HowSection />
              <IntegrateSection />
              <FederationSection />
              <PricingSection />
              <CtaBandSection />
            </>
          ) : null}
        </main>
        {belowFold ? <SiteFooter /> : null}
      </div>
    </EdgeProbeProvider>
  )
}
