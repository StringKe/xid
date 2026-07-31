// /account/sessions:活跃会话列表 + 单条撤销 + 全部撤销。
// 全宽版式:display 标题区(含操作按钮) + 列表节(自持 gutter + hairline);
// 表格行式:零卡片横贯,hairline 行线 + tabular-nums,首尾列对齐 gutter。
// 数据层 TanStack Query(useSessionsQuery/useRevokeSession/useRevokeAllSessions)。
// 设计真相源:docs/design/05-users-sessions.md 第 8 节会话管理。

import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { account, consoleShell } from '../../styles/product-surface.stylex'
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Section,
  SectionRow,
  Skeleton,
} from '../../components/ui'
import { ConfirmDialog } from './ConfirmDialog'
import { useRevokeAllSessions, useRevokeSession, useSessionsQuery } from './queries'
import type { ActiveSession } from './hooks'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'

const styles = stylex.create({
  titleBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    minWidth: 0,
  },
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1rem',
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  nameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  deviceName: {
    margin: 0,
    fontWeight: 550,
    fontSize: '0.875rem',
    lineHeight: 1.4,
    color: tokens['--xid-fg'],
  },
  metaText: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.4,
    color: tokens['--xid-muted-foreground'],
    fontVariantNumeric: 'tabular-nums',
  },
  // 窄屏可见的副文本(IP + 时间,在主列下方);宽屏由 SectionRow split 元信息列承载
  metaInline: {
    margin: '0.1875rem 0 0',
    fontSize: '0.8125rem',
    lineHeight: 1.4,
    color: tokens['--xid-muted-foreground'],
    fontVariantNumeric: 'tabular-nums',
    display: {
      default: 'block',
      '@media (min-width: 40rem)': 'none',
    },
  },
  errorText: {
    margin: '0.1875rem 0 0',
    fontSize: '0.8125rem',
    color: tokens['--xid-danger'],
    lineHeight: 1.4,
  },
  dangerButton: {
    color: tokens['--xid-danger'],
    fontSize: '0.8125rem',
  },
})

export default function SessionsPage(): ReactNode {
  const { t } = useLingui()
  const { data: sessions, isPending, error } = useSessionsQuery()
  const revokeSession = useRevokeSession()
  const revokeAll = useRevokeAllSessions()

  const [showRevokeAll, setShowRevokeAll] = useState(false)
  const [revokeAllError, setRevokeAllError] = useState<string | null>(null)

  const handleRevokeAll = async (): Promise<void> => {
    try {
      await revokeAll.mutateAsync()
      setShowRevokeAll(false)
      setRevokeAllError(null)
    } catch (err) {
      const xidErr = err as { message?: string; longMessage?: string }
      setRevokeAllError(xidErr.longMessage || xidErr.message || t`Failed to sign out sessions.`)
      setShowRevokeAll(false)
    }
  }

  const sessionList = sessions ?? []
  const sessionCount = sessionList.length

  return (
    <div {...stylex.props(account.root)}>
      <div {...stylex.props(consoleShell.headerZone, consoleShell.headerRow)}>
        <div {...stylex.props(styles.titleBlock)}>
          <h1 {...stylex.props(consoleShell.displayTitle)}>
            <Trans>Active sessions</Trans>
          </h1>
        </div>
        {sessionCount > 1 ? (
          <Button variant="danger" onClick={() => setShowRevokeAll(true)} disabled={isPending}>
            <Trans>Sign out all other sessions</Trans>
          </Button>
        ) : null}
      </div>

      {revokeAllError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error" title={<Trans>Failed to sign out sessions</Trans>}>
            {revokeAllError}
          </Alert>
        </div>
      ) : null}

      {error ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error" title={<Trans>Failed to load sessions</Trans>}>
            {error.longMessage || error.message || t`Failed to load sessions`}
          </Alert>
        </div>
      ) : null}

      <div {...stylex.props(consoleShell.section)}>
        <Section
          label={
            isPending ? (
              <Trans>Sessions</Trans>
            ) : (
              plural(sessionCount, {
                one: '# session',
                other: '# sessions',
              })
            )
          }
        >
          {isPending ? (
            <ul {...stylex.props(styles.list)} aria-busy="true">
              {[0, 1, 2].map((i) => (
                <li key={i} aria-hidden="true">
                  <SectionRow
                    variant="split"
                    label={
                      <Skeleton width="10rem" height="0.875rem" style={{ opacity: 1 - i * 0.2 }} />
                    }
                  >
                    <Skeleton width="8rem" height="0.75rem" style={{ opacity: 1 - i * 0.2 }} />
                  </SectionRow>
                </li>
              ))}
            </ul>
          ) : sessionList.length === 0 && !error ? (
            <EmptyState title={<Trans>No active sessions found</Trans>} />
          ) : (
            <ul {...stylex.props(styles.list)}>
              {sessionList.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  revokeMutate={revokeSession.mutateAsync}
                />
              ))}
            </ul>
          )}
        </Section>
      </div>

      {showRevokeAll ? (
        <ConfirmDialog
          title={<Trans>Sign out all other sessions?</Trans>}
          description={
            <Trans>
              All sessions except your current one will be signed out immediately. Devices using
              those sessions will need to sign in again.
            </Trans>
          }
          confirmLabel={<Trans>Sign out all others</Trans>}
          isLoading={revokeAll.isPending}
          onConfirm={() => void handleRevokeAll()}
          onCancel={() => setShowRevokeAll(false)}
        />
      ) : null}
    </div>
  )
}

type SessionRowProps = {
  session: ActiveSession
  revokeMutate: (id: string) => Promise<unknown>
}

function SessionRow({ session, revokeMutate }: SessionRowProps): ReactNode {
  const { t } = useLingui()
  const [showConfirm, setShowConfirm] = useState(false)
  const [isRevoking, setIsRevoking] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)

  const handleRevoke = async (): Promise<void> => {
    setIsRevoking(true)
    try {
      await revokeMutate(session.id)
      setShowConfirm(false)
    } catch (err) {
      const xidErr = err as { message?: string; longMessage?: string }
      setRowError(xidErr.longMessage || xidErr.message || t`Failed to sign out session.`)
      setShowConfirm(false)
    } finally {
      setIsRevoking(false)
    }
  }

  const lastActive = new Date(session.lastActiveAt).toLocaleString()
  const deviceLabel = session.deviceName ?? t`Unknown device`

  return (
    <li>
      <SectionRow
        variant="split"
        label={
          // 主块:设备名 + Current badge;窄屏下含 IP 和时间
          <>
            <div {...stylex.props(styles.nameRow)}>
              <p {...stylex.props(styles.deviceName)}>{deviceLabel}</p>
              {session.isCurrent ? (
                <Badge tone="info">
                  <Trans>Current</Trans>
                </Badge>
              ) : null}
            </div>
            {session.ipAddress ? (
              <p {...stylex.props(styles.metaInline)}>{session.ipAddress}</p>
            ) : null}
            <p {...stylex.props(styles.metaInline)}>
              <Trans>Last active: {lastActive}</Trans>
            </p>
            {rowError ? (
              <p role="alert" {...stylex.props(styles.errorText)}>
                {rowError}
              </p>
            ) : null}
          </>
        }
        action={
          !session.isCurrent ? (
            <Button
              variant="ghost"
              onClick={() => setShowConfirm(true)}
              aria-label={t`Sign out ${deviceLabel}`}
              disabled={isRevoking}
              {...stylex.props(styles.dangerButton)}
            >
              <Trans>Sign out</Trans>
            </Button>
          ) : null
        }
      >
        {session.ipAddress ? <p {...stylex.props(styles.metaText)}>{session.ipAddress}</p> : null}
        <p {...stylex.props(styles.metaText)}>
          <Trans>Last active: {lastActive}</Trans>
        </p>
      </SectionRow>

      {showConfirm ? (
        <ConfirmDialog
          title={<Trans>Sign out this session?</Trans>}
          description={
            <Trans>
              "{deviceLabel}" will be signed out. The device will need to sign in again.
            </Trans>
          }
          confirmLabel={<Trans>Sign out</Trans>}
          isLoading={isRevoking}
          onConfirm={() => void handleRevoke()}
          onCancel={() => setShowConfirm(false)}
        />
      ) : null}
    </li>
  )
}
