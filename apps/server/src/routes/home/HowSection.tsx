// HowSection:三步协议步进器全宽 ledger 重排。宽屏 4/8 不对称:
// 左 4 列步骤 tablist(hairline 顶线分隔,每步贴边),右 8 列深色代码面板。
// 进度刻度移入左栏底部。窄屏堆叠:步骤在上,代码面板在下。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { lx } from './landing-theme.stylex'
import { shared } from './landing-styles'
import { CodeLines, panel, PanelChrome } from './CodePanel'
import { HOW_PANELS } from './code-samples'
import { Reveal } from './Reveal'
import { Section, SectionHead } from './SectionShell'
import { useEdgeProbeData } from './EdgeProbeProvider'
import { formatTokenWindow, formatVerifyMicros } from './edge-probe-format'

const STEP_COUNT = 3

// 与 landing-styles 的 gutter 口径一致(StyleX 静态值,内联副本)。
const GUTTER = 'clamp(1.25rem, 3vw, 4.5rem)'

const styles = stylex.create({
  // 全宽贴边 4/8 ledger 行(bleed 模式)
  ledger: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 4fr) minmax(0, 8fr)',
      '@media (max-width: 56rem)': 'minmax(0, 1fr)',
    },
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
  },
  stepsCol: {
    borderRightWidth: '1px',
    borderRightStyle: { default: 'solid', '@media (max-width: 56rem)': 'none' },
    borderRightColor: lx.hairline,
    borderBottomWidth: '1px',
    borderBottomStyle: { default: 'none', '@media (max-width: 56rem)': 'solid' },
    borderBottomColor: lx.hairline,
    display: 'flex',
    flexDirection: 'column',
    paddingBlock: 'clamp(2rem, 3.5vw, 4rem)',
  },
  panelCol: {
    paddingBlock: 'clamp(2rem, 3.5vw, 4rem)',
    // 堆叠后面板左缘持页边距,不贴视口左边。
    paddingInlineStart: {
      default: 'clamp(1.5rem, 2.5vw, 3.5rem)',
      '@media (max-width: 56rem)': GUTTER,
    },
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    minWidth: 0,
  },
  stepsNav: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
  },
  step: {
    appearance: 'none',
    backgroundColor: {
      default: 'transparent',
      ':hover': lx.sunken,
      ':active': `color-mix(in oklch, ${lx.sunken} 90%, black)`,
    },
    borderWidth: 0,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
    textAlign: 'left',
    cursor: 'pointer',
    // hairline 邻接口径:step 文本与 borderTop 1px 线距离 >= 1.25rem。
    paddingBlock: '1.25rem',
    paddingInlineEnd: { default: 'clamp(1rem, 2vw, 2rem)', '@media (max-width: 56rem)': GUTTER },
    display: 'flex',
    flexDirection: 'column',
    gap: '0.3rem',
    fontFamily: tokens['--xid-font'],
    color: 'inherit',
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
    outline: { default: 'none', ':focus-visible': `2px solid ${tokens['--xid-accent']}` },
    outlineOffset: '2px',
    // inset strip 作选中指示,避免 border-left 切换引发布局位移。
    boxShadow: {
      default: `inset 2px 0 0 transparent`,
      ':hover': `inset 2px 0 0 ${lx.hairline}`,
    },
  },
  stepOn: {
    boxShadow: `inset 2px 0 0 ${lx.ink}`,
    backgroundColor: lx.sunken,
  },
  stepKicker: { color: lx.secondary },
  stepKickerOn: { color: lx.ink },
  stepTitle: {
    fontSize: '1rem',
    fontWeight: 620,
    letterSpacing: '-0.014em',
    color: lx.primary,
  },
  // 仅 active 步骤渲染正文,避免 grid-template-rows/height 类布局属性过渡。
  stepBody: {
    display: 'block',
    marginTop: '0.45rem',
    fontSize: '0.875rem',
    lineHeight: 1.55,
    color: lx.secondary,
  },
  meter: {
    display: 'flex',
    gap: '0.375rem',
    paddingTop: '1.25rem',
    paddingInlineEnd: { default: 'clamp(1rem, 2vw, 2rem)', '@media (max-width: 56rem)': GUTTER },
    marginTop: 'auto',
  },
  tick: {
    height: '2px',
    flexGrow: 1,
    backgroundColor: lx.hairline,
    borderRadius: '1px',
    transitionProperty: 'background-color',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  tickOn: { backgroundColor: lx.ink },
})

type Step = { id: string; kicker: string; title: string; body: string; file: string }

function useSteps(): readonly Step[] {
  const { t } = useLingui()
  const probe = useEdgeProbeData()
  const signingAlg = probe?.signingAlg ?? 'ES256'
  const tokenWindow = probe ? formatTokenWindow(probe.accessTokenTtlSec) : '60s'
  const verifyBody =
    probe !== null
      ? t`The backend SDK validates signature and expiry against cached JWKS. ${probe.jwksRoundTrips} round trips, ${formatVerifyMicros(probe.verifyUs)} authorize.`
      : t`The backend SDK validates signature and expiry against cached JWKS. Networkless verify with cached JWKS.`
  return [
    {
      id: 'request',
      kicker: t`Request`,
      title: t`Sign in at the nearest node`,
      body: t`Hosted auth renders per-organization branding with passkey conditional UI. The login surface stays on the nearest edge node.`,
      file: t`authorize · edge node`,
    },
    {
      id: 'issue',
      kicker: t`Issue`,
      title: t`Tokens signed at the edge`,
      body: t`${signingAlg} access token with a ${tokenWindow} window. Refresh tokens rotate on every use; reuse revokes the whole family.`,
      file: t`access_token · payload`,
    },
    {
      id: 'verify',
      kicker: t`Verify`,
      title: t`Your Worker verifies networkless`,
      body: verifyBody,
      file: 'worker/index.ts',
    },
  ]
}

export function HowSection(): ReactNode {
  const { t } = useLingui()
  const steps = useSteps()
  const [step, setStep] = useState(0)
  const activeStep = steps[step]
  const activePanel = HOW_PANELS[step] ?? []

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const nextByKey: Record<string, number> = {
      ArrowDown: (step + 1) % STEP_COUNT,
      ArrowRight: (step + 1) % STEP_COUNT,
      ArrowUp: (step + STEP_COUNT - 1) % STEP_COUNT,
      ArrowLeft: (step + STEP_COUNT - 1) % STEP_COUNT,
    }
    const next = nextByKey[event.key]
    if (next === undefined) return
    event.preventDefault()
    setStep(next)
    // automatic activation:焦点跟随选中的 tab,否则方向键后焦点留在 aria-selected=false 的旧 tab 上。
    const nextId = steps[next]?.id
    requestAnimationFrame(() => {
      if (nextId) document.getElementById(`how-tab-${nextId}`)?.focus()
    })
  }

  return (
    <Section id="how" tone="sunken" bleed>
      {/* bleed 节自管节奏:head 区持节顶口径(shared.bleedHead) */}
      <div {...stylex.props(shared.measure, shared.bleedHead)}>
        <SectionHead
          kicker={<Trans>How it works</Trans>}
          heading={<Trans>Request to verified claims, in three moves.</Trans>}
          sub={
            <Trans>
              Every step runs in one Worker at the edge. Token verification needs no network round
              trip.
            </Trans>
          }
        />
      </div>
      <Reveal sx={styles.ledger}>
        {/* 左 4 列:步骤 tablist + 进度刻度;节内最后贴边行,内容经 sectionFoot 离节底线 */}
        <div {...stylex.props(shared.edgeStart, styles.stepsCol, shared.sectionFoot)}>
          <div
            role="tablist"
            aria-label={t`How it works`}
            aria-orientation="vertical"
            onKeyDown={onKeyDown}
            {...stylex.props(styles.stepsNav)}
          >
            {steps.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`how-tab-${item.id}`}
                aria-controls="how-panel"
                aria-selected={step === index}
                tabIndex={step === index ? 0 : -1}
                onClick={() => setStep(index)}
                {...stylex.props(styles.step, step === index && styles.stepOn)}
              >
                <span
                  {...stylex.props(
                    shared.microlabel,
                    styles.stepKicker,
                    step === index && styles.stepKickerOn,
                  )}
                >
                  {item.kicker}
                </span>
                <span {...stylex.props(styles.stepTitle)}>{item.title}</span>
                {step === index ? (
                  <span {...stylex.props(styles.stepBody)}>{item.body}</span>
                ) : null}
              </button>
            ))}
          </div>
          <div aria-hidden {...stylex.props(styles.meter)}>
            {steps.map((item, index) => (
              <i key={item.id} {...stylex.props(styles.tick, index === step && styles.tickOn)} />
            ))}
          </div>
        </div>
        {/* 右 8 列:代码面板;同行底,面板经 sectionFoot 离节底线 */}
        <div {...stylex.props(shared.edgeEnd, styles.panelCol, shared.sectionFoot)}>
          <div {...stylex.props(panel.frame)}>
            <PanelChrome file={activeStep?.file ?? ''} />
            <div
              key={step}
              role="tabpanel"
              id="how-panel"
              aria-labelledby={`how-tab-${activeStep?.id ?? ''}`}
            >
              <CodeLines lines={activePanel} stagger height="mid" />
            </div>
          </div>
        </div>
      </Reveal>
    </Section>
  )
}
