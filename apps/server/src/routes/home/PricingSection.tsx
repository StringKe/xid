// PricingSection:两方案不对称登记式编排。
// 宽屏:每个方案行内 5/7 不对称分栏 -- 左侧账本索引(方案名+定价+CTA),
// 右侧规格展开(描述+条目清单)。竖向 hairline 切列,水平 hairline 分隔两方案。
// 无卡片盒子,无 shadow,层次靠中性底色阶 + 1px 边框。窄屏堆叠为单列全展开。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { lx } from './landing-theme.stylex'
import { shared } from './landing-styles'
import { CtaLink } from './landing-cta'
import { Icon } from './landing-icons'
import { Section, SectionHead } from './SectionShell'

// 与 landing-styles 的 gutter 口径一致(StyleX 静态值,内联副本)。
const GUTTER = 'clamp(1.25rem, 3vw, 4.5rem)'

const styles = stylex.create({
  // 方案列表容器:顶线横贯全宽
  planList: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
  },
  // 单个方案行:5/7 不对称双列
  planRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 5fr) minmax(0, 7fr)',
      '@media (max-width: 52rem)': 'minmax(0, 1fr)',
    },
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: lx.hairline,
  },
  // 末行交出底线,由 Section 的分节线收尾(避免双 hairline)。
  planRowLast: { borderBottomStyle: 'none' },
  // 左侧账本索引列:方案名、定价摘要、CTA
  index: {
    paddingBlock: 'clamp(2.5rem, 4vw, 4.5rem)',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    borderRightWidth: '1px',
    borderRightStyle: { default: 'solid', '@media (max-width: 52rem)': 'none' },
    borderRightColor: lx.hairline,
    // 堆叠后右缘回到页边距口径。
    paddingInlineEnd: { default: 'clamp(1.5rem, 3vw, 4rem)', '@media (max-width: 52rem)': GUTTER },
    borderBottomWidth: '1px',
    borderBottomStyle: { default: 'none', '@media (max-width: 52rem)': 'solid' },
    borderBottomColor: lx.hairline,
  },
  indexAccent: {
    backgroundColor: lx.sunken,
  },
  // 右侧规格展开列
  detail: {
    paddingBlock: 'clamp(2.5rem, 4vw, 4.5rem)',
    // 堆叠后左缘持页边距,不贴视口左边。
    paddingInlineStart: {
      default: 'clamp(1.5rem, 3vw, 4rem)',
      '@media (max-width: 52rem)': GUTTER,
    },
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: '1.25rem',
  },
  detailAccent: {
    backgroundColor: lx.sunken,
  },
  planName: {
    color: lx.secondary,
  },
  planNameAccent: {
    color: lx.ink,
  },
  price: {
    margin: 0,
    fontSize: 'clamp(2rem, 1rem + 1.5vw, 3rem)',
    fontWeight: 620,
    letterSpacing: '-0.03em',
    lineHeight: 1.04,
    color: lx.primary,
    fontVariantNumeric: 'tabular-nums',
  },
  priceSuffix: {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 460,
    letterSpacing: '0',
    fontVariantNumeric: 'normal',
    color: lx.secondary,
    marginTop: '0.375rem',
  },
  ctaWrapper: {
    paddingTop: '0.25rem',
    width: '100%',
    maxWidth: '16rem',
  },
  desc: {
    fontSize: 'clamp(0.9375rem, 0.9rem + 0.15vw, 1.0625rem)',
    lineHeight: 1.6,
    color: lx.secondary,
    margin: 0,
    maxWidth: '52ch',
    textWrap: 'pretty',
  },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  listItem: {
    display: 'grid',
    gridTemplateColumns: '1rem 1fr',
    gap: '0.625rem',
    alignItems: 'start',
    fontSize: '0.9375rem',
    color: lx.primary,
    // hairline 邻接口径:条目文本与行分隔线距离 >= 1.25rem。
    paddingBlock: '1.25rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
  },
  listIcon: {
    color: lx.ink,
    display: 'inline-flex',
    alignItems: 'center',
    marginTop: '0.1rem',
  },
})

type Plan = {
  id: string
  accent?: boolean
  name: ReactNode
  price: ReactNode
  priceSuffix: ReactNode
  desc: ReactNode
  items: readonly string[]
  ctaHref: string
  ctaLabel: ReactNode
  ctaVariant: 'primary' | 'secondary'
}

function usePlans(): readonly Plan[] {
  const { t } = useLingui()
  return [
    {
      id: 'self-hosted',
      name: <Trans>Self-hosted</Trans>,
      price: <Trans>Free</Trans>,
      priceSuffix: <Trans>· your Cloudflare account</Trans>,
      desc: (
        <Trans>
          Deploy the Worker to your own account. Full protocol surface, no seat limits, your data
          never leaves your edge.
        </Trans>
      ),
      items: [
        t`OIDC / OAuth IdP + organization RBAC`,
        t`Inbound enterprise SSO & SCIM`,
        t`Full SDK matrix: web, mobile, desktop, and server`,
      ],
      ctaHref: '/docs/self-hosting',
      ctaLabel: <Trans>Read self-hosting docs</Trans>,
      ctaVariant: 'secondary',
    },
    {
      id: 'hosted',
      accent: true,
      name: <Trans>Hosted · xid.dev</Trans>,
      price: <Trans>Usage</Trans>,
      priceSuffix: <Trans>· managed on the edge</Trans>,
      desc: (
        <Trans>
          We operate the Worker, signing keys, and JWKS rotation, with audit log retention included.
          Same full protocol surface as self-hosted, managed for you.
        </Trans>
      ),
      items: [t`Everything in self-hosted`, t`Managed key rotation + audit retention`],
      ctaHref: '/sign-up',
      ctaLabel: <Trans>Start integrating</Trans>,
      ctaVariant: 'primary',
    },
  ]
}

function PlanRow({ plan, isLast = false }: { plan: Plan; isLast?: boolean }): ReactNode {
  return (
    <div {...stylex.props(styles.planRow, isLast && styles.planRowLast)}>
      <article {...stylex.props(styles.index, plan.accent && styles.indexAccent, shared.edgeStart)}>
        <span
          {...stylex.props(
            shared.microlabel,
            styles.planName,
            plan.accent && styles.planNameAccent,
          )}
        >
          {plan.name}
        </span>
        <p {...stylex.props(styles.price)}>
          {plan.price}
          <small {...stylex.props(styles.priceSuffix)}>{plan.priceSuffix}</small>
        </p>
        <div {...stylex.props(styles.ctaWrapper)}>
          <CtaLink
            href={plan.ctaHref}
            variant={plan.ctaVariant}
            fullWidth
            analyticsId={`pricing_${plan.id}`}
            analyticsPlacement="pricing"
          >
            {plan.ctaLabel}
          </CtaLink>
        </div>
      </article>

      <div {...stylex.props(styles.detail, plan.accent && styles.detailAccent, shared.edgeEnd)}>
        <p {...stylex.props(styles.desc)}>{plan.desc}</p>
        <ul {...stylex.props(styles.list)}>
          {plan.items.map((item) => (
            <li key={item} {...stylex.props(styles.listItem)}>
              <span {...stylex.props(styles.listIcon)}>
                <Icon name="check" size={14} strokeWidth={2.5} />
              </span>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function PricingSection(): ReactNode {
  const plans = usePlans()
  return (
    <Section id="pricing" tone="sunken" bleed>
      {/* bleed 节自管节奏:head 区持节顶口径(shared.bleedHead) */}
      <div {...stylex.props(shared.measure, shared.bleedHead)}>
        <SectionHead
          kicker={<Trans>Pricing</Trans>}
          heading={<Trans>Self-host free, or let us run it.</Trans>}
          sub={
            <Trans>
              Open source under the MIT License. Read the source, run it yourself, or hand
              operations to xid.dev.
            </Trans>
          }
        />
      </div>
      <div {...stylex.props(styles.planList)}>
        {plans.map((plan, index) => (
          <PlanRow key={plan.id} plan={plan} isLast={index === plans.length - 1} />
        ))}
      </div>
    </Section>
  )
}
