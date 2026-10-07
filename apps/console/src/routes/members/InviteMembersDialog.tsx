// 批量邀请:粘贴逗号或换行分隔的邮箱(最多 50 个),先在本地标出格式错误与重复,
// 发送后逐条显示结果(已发送、已是成员、已有邀请、发送失败)。

import { Plural, Trans } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { OrganizationMembershipRole } from '@xid-kit/types'
import { useRoleLabel } from '@xid-kit/web-ui/enum-labels'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { Alert, Badge, Button, Dialog, Field, Select, Textarea } from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import type { BulkInvitationResult } from './member-api'
import { useInviteMembers } from './member-api'

export const MAX_BULK_INVITATIONS = 50
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type ParsedInvitees = { valid: string[]; invalid: string[]; duplicates: string[] }

export function parseInvitees(raw: string): ParsedInvitees {
  const seen = new Set<string>()
  const result: ParsedInvitees = { valid: [], invalid: [], duplicates: [] }
  for (const token of raw.split(/[\s,;]+/)) {
    const email = token.trim().toLowerCase()
    if (!email) continue
    if (!EMAIL.test(email)) result.invalid.push(token.trim())
    else if (seen.has(email)) result.duplicates.push(email)
    else {
      seen.add(email)
      result.valid.push(email)
    }
  }
  return result
}

const styles = stylex.create({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  panelHead: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.5rem',
    paddingBlock: '0.625rem',
    paddingInline: '0.75rem',
    fontSize: text.sm,
    fontWeight: 600,
  },
  panelCount: {
    fontWeight: 400,
    color: tokens['--xid-muted-foreground'],
    fontVariantNumeric: 'tabular-nums',
  },
  issue: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    paddingBlock: '0.5rem',
    paddingInline: '0.75rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    fontSize: text.sm,
    overflowWrap: 'anywhere',
  },
})

const RESULT_TONE: Record<BulkInvitationResult['result'], BadgeTone> = {
  created: 'success',
  already_member: 'neutral',
  already_invited: 'neutral',
  failed: 'danger',
}

function ResultLabel({ result }: { result: BulkInvitationResult['result'] }): ReactNode {
  if (result === 'created') return <Trans>Invited</Trans>
  if (result === 'already_member') return <Trans>Already a member</Trans>
  if (result === 'already_invited') return <Trans>Already invited</Trans>
  return <Trans>Not sent</Trans>
}

export function InviteMembersDialog({
  orgId,
  orgName,
  canInviteOwners,
  onClose,
}: {
  orgId: string
  orgName: string
  canInviteOwners: boolean
  onClose: () => void
}): ReactNode {
  const roleLabel = useRoleLabel()
  const errorMessage = useManagementErrorMessage()
  const invite = useInviteMembers(orgId)
  const [raw, setRaw] = useState('')
  const [role, setRole] = useState<OrganizationMembershipRole>('member')
  const parsed = parseInvitees(raw)
  const tooMany = parsed.valid.length > MAX_BULK_INVITATIONS
  const results = invite.data?.data
  const sent = results?.filter((row) => row.result === 'created').length ?? 0
  const count = parsed.valid.length

  return (
    <Dialog
      open
      onOpenChange={(next) => (next || invite.isPending ? undefined : onClose())}
      title={<Trans>Invite members to {orgName}</Trans>}
      description={<Trans>Each person gets an email link that works for 7 days.</Trans>}
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="lg"
      footer={
        results ? (
          <Button onClick={onClose}>
            <Trans>Done</Trans>
          </Button>
        ) : (
          <>
            <Button variant="secondary" disabled={invite.isPending} onClick={onClose}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              disabled={count === 0 || tooMany}
              isLoading={invite.isPending}
              onClick={() => invite.mutate({ emails: parsed.valid, role })}
            >
              <Plural value={count} one="Send # invitation" other="Send # invitations" />
            </Button>
          </>
        )
      }
    >
      {results ? (
        <div {...stylex.props(styles.panel)}>
          <div {...stylex.props(styles.panelHead)}>
            <Plural value={sent} one="# invitation sent" other="# invitations sent" />
          </div>
          {results.map((row) => (
            <div key={row.email} {...stylex.props(styles.issue)}>
              <Badge tone={RESULT_TONE[row.result]}>
                <ResultLabel result={row.result} />
              </Badge>
              <span>{row.email}</span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <Field
            label={<Trans>Email addresses</Trans>}
            hint={
              <Trans>
                Separate with commas or new lines, or paste a column from a spreadsheet. Up to 50 at
                a time.
              </Trans>
            }
          >
            <Textarea
              rows={5}
              value={raw}
              onChange={(event) => setRaw(event.currentTarget.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          {raw.trim() ? (
            <div {...stylex.props(styles.panel)}>
              <div {...stylex.props(styles.panelHead)}>
                <span>
                  <Plural value={count} one="# will be invited" other="# will be invited" />
                </span>
                {tooMany ? (
                  <span {...stylex.props(styles.panelCount)}>
                    <Trans>Remove some addresses; the limit is 50.</Trans>
                  </span>
                ) : null}
              </div>
              {parsed.invalid.map((value) => (
                <div key={`invalid-${value}`} {...stylex.props(styles.issue)}>
                  <Badge tone="danger">
                    <Trans>Not an email</Trans>
                  </Badge>
                  <span>
                    <Trans>{value} is skipped</Trans>
                  </span>
                </div>
              ))}
              {parsed.duplicates.map((value) => (
                <div key={`duplicate-${value}`} {...stylex.props(styles.issue)}>
                  <Badge tone="neutral">
                    <Trans>Listed twice</Trans>
                  </Badge>
                  <span>
                    <Trans>{value} is invited once</Trans>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <Field label={<Trans>Role</Trans>}>
            <Select
              value={role}
              onChange={(event) => setRole(event.currentTarget.value as OrganizationMembershipRole)}
            >
              <option value="member">{roleLabel('member')}</option>
              <option value="admin">{roleLabel('admin')}</option>
              {canInviteOwners ? <option value="owner">{roleLabel('owner')}</option> : null}
            </Select>
          </Field>
          {invite.error ? (
            <Alert tone="error">
              {invite.error.code === 'rate_limited' ? (
                <Trans>You reached the limit of 50 invitations an hour. Try again later.</Trans>
              ) : (
                errorMessage(invite.error)
              )}
            </Alert>
          ) : null}
        </>
      )}
    </Dialog>
  )
}
