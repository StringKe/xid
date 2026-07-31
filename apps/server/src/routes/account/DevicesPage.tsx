// /account/devices:信任设备列表 + 撤销信任。
// 全宽版式:display 标题区(含 lead 说明) + 列表节(自持 gutter + hairline)。
// 数据层 TanStack Query(useTrustedDevicesQuery/useRevokeTrustedDevice)。
// 设计真相源:docs/design/01-authentication.md 第 7 节设备信任。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { account, consoleShell } from '../../styles/product-surface.stylex'
import { Alert, Button, EmptyState, Section, SectionRow, Skeleton } from '../../components/ui'
import { ConfirmDialog } from './ConfirmDialog'
import { useRevokeTrustedDevice, useTrustedDevicesQuery } from './queries'
import type { TrustedDevice } from './hooks'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'

const styles = stylex.create({
  lead: {
    margin: '0.5rem 0 0',
    fontSize: '0.875rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    maxWidth: '65ch',
    textWrap: 'pretty',
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
  // 窄屏可见的副文本(日期,在主列下方);宽屏由 SectionRow split 元信息列承载
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

export default function DevicesPage(): ReactNode {
  const { t } = useLingui()
  const { data: devices, isPending, error } = useTrustedDevicesQuery()

  const deviceList = devices ?? []

  return (
    <div {...stylex.props(account.root)}>
      <div {...stylex.props(consoleShell.headerZone)}>
        <h1 {...stylex.props(consoleShell.displayTitle)}>
          <Trans>Trusted devices</Trans>
        </h1>
        <p {...stylex.props(styles.lead)}>
          <Trans>
            Trusted devices can skip or reduce MFA checks. Remove a device if you no longer trust it
            or if it was lost.
          </Trans>
        </p>
      </div>

      {error ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error" title={<Trans>Failed to load trusted devices</Trans>}>
            {error.longMessage || error.message || t`Failed to load trusted devices`}
          </Alert>
        </div>
      ) : null}

      <div {...stylex.props(consoleShell.section)}>
        <Section label={<Trans>Devices</Trans>}>
          {isPending ? (
            <ul {...stylex.props(styles.list)} aria-busy="true">
              {[0, 1, 2].map((i) => (
                <li key={i} aria-hidden="true">
                  <SectionRow
                    variant="split"
                    label={
                      <Skeleton width="12rem" height="0.875rem" style={{ opacity: 1 - i * 0.2 }} />
                    }
                  >
                    <Skeleton width="8rem" height="0.75rem" style={{ opacity: 1 - i * 0.2 }} />
                  </SectionRow>
                </li>
              ))}
            </ul>
          ) : deviceList.length === 0 && !error ? (
            <EmptyState
              title={<Trans>No trusted devices</Trans>}
              description={
                <Trans>Devices are added when you choose "Trust this device" during sign-in.</Trans>
              }
            />
          ) : (
            <ul {...stylex.props(styles.list)}>
              {deviceList.map((device) => (
                <DeviceRow key={device.id} device={device} />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  )
}

type DeviceRowProps = {
  device: TrustedDevice
}

function DeviceRow({ device }: DeviceRowProps): ReactNode {
  const { t } = useLingui()
  const revokeDevice = useRevokeTrustedDevice()
  const [showConfirm, setShowConfirm] = useState(false)
  const [isRevoking, setIsRevoking] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)

  const handleRevoke = async (): Promise<void> => {
    setIsRevoking(true)
    try {
      await revokeDevice.mutateAsync(device.id)
      setShowConfirm(false)
    } catch (err) {
      const xidErr = err as { message?: string; longMessage?: string }
      setRowError(xidErr.longMessage || xidErr.message || t`Failed to remove trusted device.`)
      setShowConfirm(false)
    } finally {
      setIsRevoking(false)
    }
  }

  const displayName = device.deviceName ?? t`Unknown device`
  const trustedDate = new Date(device.trustedAt).toLocaleDateString()
  const lastSeenDate = new Date(device.lastSeenAt).toLocaleDateString()

  return (
    <li>
      <SectionRow
        variant="split"
        label={
          // 主块:设备名;窄屏下含日期
          <>
            <p {...stylex.props(styles.deviceName)}>{displayName}</p>
            <p {...stylex.props(styles.metaInline)}>
              <Trans>
                Trusted {trustedDate} &middot; Last seen {lastSeenDate}
              </Trans>
            </p>
            {rowError ? (
              <p role="alert" {...stylex.props(styles.errorText)}>
                {rowError}
              </p>
            ) : null}
          </>
        }
        action={
          <Button
            variant="ghost"
            onClick={() => setShowConfirm(true)}
            aria-label={t`Remove trust for ${displayName}`}
            disabled={isRevoking}
            {...stylex.props(styles.dangerButton)}
          >
            <Trans>Remove</Trans>
          </Button>
        }
      >
        <p {...stylex.props(styles.metaText)}>
          <Trans>Trusted {trustedDate}</Trans>
        </p>
        <p {...stylex.props(styles.metaText)}>
          <Trans>Last seen {lastSeenDate}</Trans>
        </p>
      </SectionRow>

      {showConfirm ? (
        <ConfirmDialog
          title={<Trans>Remove trusted device?</Trans>}
          description={
            <Trans>
              "{displayName}" will no longer be trusted. Future sign-ins from this device will
              require full MFA verification.
            </Trans>
          }
          confirmLabel={<Trans>Remove</Trans>}
          isLoading={isRevoking}
          onConfirm={() => void handleRevoke()}
          onCancel={() => setShowConfirm(false)}
        />
      ) : null}
    </li>
  )
}
