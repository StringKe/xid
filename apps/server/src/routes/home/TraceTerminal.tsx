// TraceTerminal:hero 右栏的边缘验证 trace 终端(设计稿 .lp-trace)。
// 滚入视口后逐行播放;延迟/验签耗时/节点来自 EdgeProbe 实测值,可重放。
// cmd/out 行是协议字面量不本地化;dim/ok 行与延迟标注本地化。

import { useLingui } from '@lingui/react/macro'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Icon } from './landing-icons'
import { lx } from './landing-theme.stylex'
import { panel, PanelChrome } from './CodePanel'
import { prefersReducedMotion } from './Reveal'
import { useEdgeProbeData } from './EdgeProbeProvider'
import {
  formatEdgeRtt,
  formatTlsLabel,
  formatTokenWindow,
  formatVerifyMicros,
} from './edge-probe-format'

const LINE_INTERVAL_MS = 380
const COUNT_DURATION_MS = 700

type TraceLine = {
  kind: 'cmd' | 'dim' | 'ok' | 'out'
  text: string
  lat?: string
}

function useTraceRun(ref: RefObject<HTMLElement | null>, reduce: boolean): [number, () => void] {
  const [run, setRun] = useState(0)
  useEffect(() => {
    if (reduce) return
    const el = ref.current
    if (!el || !('IntersectionObserver' in globalThis)) {
      setRun(1)
      return
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setRun((r) => r || 1)
          io.disconnect()
        }
      },
      { threshold: 0.35 },
    )
    const observe = (): void => {
      io.observe(el)
    }
    let cancel: (() => void) | undefined
    if ('requestIdleCallback' in globalThis) {
      const idleId = globalThis.requestIdleCallback(observe, { timeout: 600 })
      cancel = () => globalThis.cancelIdleCallback(idleId)
    } else {
      const rafId = globalThis.requestAnimationFrame(observe)
      cancel = () => globalThis.cancelAnimationFrame(rafId)
    }
    return () => {
      cancel?.()
      io.disconnect()
    }
  }, [ref, reduce])
  return [run, () => setRun((r) => r + 1)]
}

function useLineProgress(run: number, total: number, reduce: boolean): number {
  const [count, setCount] = useState(reduce ? total : 0)
  useEffect(() => {
    if (!run || reduce) return
    setCount(0)
    let i = 0
    let intervalId: ReturnType<typeof setInterval> | undefined
    const start = (): void => {
      intervalId = setInterval(() => {
        i += 1
        setCount(i)
        if (i >= total && intervalId) clearInterval(intervalId)
      }, LINE_INTERVAL_MS)
    }
    // 首屏 LCP 后再启动逐行动画,避免与主线程绘制争抢。
    const idleId =
      'requestIdleCallback' in globalThis
        ? globalThis.requestIdleCallback(start, { timeout: 1_200 })
        : globalThis.setTimeout(start, 200)
    return () => {
      if ('cancelIdleCallback' in globalThis && typeof idleId === 'number') {
        globalThis.cancelIdleCallback(idleId)
      } else {
        clearTimeout(idleId)
      }
      if (intervalId) clearInterval(intervalId)
    }
  }, [run, reduce, total])
  return count
}

function useMicroseconds(targetUs: number, done: boolean, reduce: boolean): number {
  const [us, setUs] = useState(reduce ? targetUs : 0)
  useEffect(() => {
    if (reduce) return
    if (!done || targetUs <= 0) {
      setUs(0)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const tick = (t: number): void => {
      const progress = Math.min(1, (t - t0) / COUNT_DURATION_MS)
      setUs(Math.round(targetUs * (1 - Math.pow(1 - progress, 3))))
      if (progress < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [done, reduce, targetUs])
  return us
}

const caretBlink = stylex.keyframes({ '50%': { opacity: 0 } })

const styles = stylex.create({
  figure: { margin: 0 },
  body: {
    paddingBlock: '1.1rem',
    paddingInline: '1.25rem',
    minHeight: '9.75rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.3rem',
  },
  line: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '1.25rem',
    fontFamily: lx.mono,
    fontSize: '0.78rem',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
  },
  lineCmd: { color: lx.onCode, fontWeight: 560 },
  lineDim: { color: lx.onCodeDim },
  lineOk: { color: lx.onCodeOk },
  lineOut: { color: lx.onCodeOut },
  lat: { color: lx.onCodeDim, flexShrink: 0, fontSize: '0.75rem' },
  latOk: { color: lx.onCodeOk },
  caret: {
    width: '0.55rem',
    height: '1.05rem',
    backgroundColor: lx.onCodeDim,
    animationName: caretBlink,
    animationDuration: '1s',
    animationTimingFunction: 'steps(2)',
    animationIterationCount: 'infinite',
  },
  foot: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    paddingBlock: '0.8rem',
    paddingInline: '1.25rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.onCodeLine,
    backgroundColor: lx.codeRaised,
    margin: 0,
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    fontFamily: lx.mono,
    fontSize: '0.72rem',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: lx.onCodeDim,
    transitionProperty: 'color',
    transitionDuration: '0.3s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  badgeOn: { color: lx.onCodeOk },
  badgeDot: {
    width: '0.5rem',
    height: '0.5rem',
    borderRadius: '50%',
    backgroundColor: lx.onCodeDim,
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: '0.3s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  badgeDotOn: {
    backgroundColor: lx.onCodeOk,
    boxShadow: `0 0 0 3px color-mix(in oklch, ${lx.onCodeOk} 25%, transparent)`,
  },
  spec: {
    marginLeft: 'auto',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    fontFamily: lx.mono,
    fontSize: '0.72rem',
    color: lx.onCodeDim,
    fontVariantNumeric: 'tabular-nums',
    display: { default: 'inline', '@media (max-width: 36rem)': 'none' },
  },
  replay: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
    appearance: 'none',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: lx.onCodeLine, ':hover': lx.onCodeLineStrong },
    backgroundColor: {
      default: 'transparent',
      ':active': `color-mix(in oklch, ${lx.onCode} 10%, transparent)`,
    },
    color: { default: lx.onCodeDim, ':hover': lx.onCode },
    fontFamily: lx.mono,
    fontSize: '0.72rem',
    paddingBlock: '0.25rem',
    paddingInline: '0.55rem',
    borderRadius: '0.25rem',
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.4 },
    transitionProperty: 'color, border-color, background-color',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
})

const LINE_STYLE = {
  cmd: styles.lineCmd,
  dim: styles.lineDim,
  ok: styles.lineOk,
  out: styles.lineOut,
} as const

export function TraceTerminal(): ReactNode {
  const { t } = useLingui()
  const reduce = useMemo(prefersReducedMotion, [])
  const ref = useRef<HTMLElement | null>(null)
  const probe = useEdgeProbeData()

  const edgeNode = probe?.coloCode ?? t`edge`
  const tlsLabel = formatTlsLabel(probe?.tlsVersion ?? null) ?? t`TLS`
  const edgeRtt = probe ? formatEdgeRtt(probe.edgeRttMs) : '—'
  const verifyUs = probe ? formatVerifyMicros(probe.verifyUs) : '—'
  const tokenWindow = probe ? formatTokenWindow(probe.accessTokenTtlSec) : '—'
  const signingAlg = probe?.signingAlg ?? 'ES256'
  const roundTrips = probe ? String(probe.jwksRoundTrips) : '—'

  const lines: readonly TraceLine[] = [
    { kind: 'cmd', text: '$ curl https://api.acme.dev/v1/me' },
    {
      kind: 'dim',
      text: t`→ edge · ${edgeNode} · ${tlsLabel} resumed`,
      lat: edgeRtt,
    },
    {
      kind: 'dim',
      text: t`→ verifyToken() · JWKS cache hit`,
      lat: t`${roundTrips} RTT`,
    },
    {
      kind: 'ok',
      text: t`✓ sig ${signingAlg} · exp ${tokenWindow} window · org_id claim`,
      lat: verifyUs,
    },
    { kind: 'out', text: '← 200 OK · { "sub": "usr_8f24" }' },
  ]

  const [run, replay] = useTraceRun(ref, reduce)
  const shown = useLineProgress(run, lines.length, reduce)
  const done = shown >= lines.length
  const targetUs = probe?.verifyUs ?? 0
  const us = useMicroseconds(targetUs, done, reduce)

  return (
    <figure
      ref={ref as never}
      {...stylex.props(panel.frame, styles.figure)}
      aria-label={t`Edge verification trace`}
    >
      <PanelChrome file="trace · GET api.acme.dev/v1/me" />
      <div {...stylex.props(styles.body)}>
        {lines.slice(0, shown).map((line, index) => (
          <div
            key={`${run}-${line.kind}-${index}`}
            {...stylex.props(styles.line, LINE_STYLE[line.kind], panel.lineStagger)}
          >
            <span>{line.text}</span>
            {line.lat ? (
              <span {...stylex.props(styles.lat, line.kind === 'ok' && styles.latOk)}>
                {line.lat}
              </span>
            ) : null}
          </div>
        ))}
        {!done && <div aria-hidden {...stylex.props(styles.caret)} />}
      </div>
      <figcaption {...stylex.props(styles.foot)}>
        <span {...stylex.props(styles.badge, done && styles.badgeOn)}>
          <i aria-hidden {...stylex.props(styles.badgeDot, done && styles.badgeDotOn)} />
          {t`Verified at edge`}
        </span>
        <span {...stylex.props(styles.spec)}>
          {probe ? `${signingAlg} · ${roundTrips} RTT · ${us}µs` : t`Measuring edge verify…`}
        </span>
        {!reduce && (
          <button type="button" {...stylex.props(styles.replay)} onClick={replay} disabled={!done}>
            <Icon name="replay" size={13} /> {t`Replay`}
          </button>
        )}
      </figcaption>
    </figure>
  )
}
