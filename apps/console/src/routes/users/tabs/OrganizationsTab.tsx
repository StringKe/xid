// Organizations:组织与角色(改角色、加入组织)+ 项目角色授予(Direct grant / Via project grant)。
// 经项目授权得到的角色只能在该项目授权上改,这里不给删除按钮。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { OrganizationMembershipRole } from '@xid-kit/types'
import { useAuth } from '@xid-kit/web-ui/session'
import { isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
import { useRoleLabel } from '@xid-kit/web-ui/enum-labels'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useApiMutation } from '@xid-kit/web-ui/queries'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Icon,
  Select,
  Skeleton,
  useToast,
} from '@xid-kit/web-ui/ui'
import { detail } from '../../../components/page/detail-styles'
import { list } from '../../../components/page/list-styles'
import { ChangeRoleDialog } from '../../members/ChangeRoleDialog'
import type { UserDetail, UserMembership } from '../user-api'
import { useRevokeUserGrant, useUserGrants, useUserMemberships } from '../user-api'
import { formatDate } from '../user-format'

function AddToOrganizationDialog({
  user,
  name,
  memberOf,
  onClose,
}: {
  user: UserDetail
  name: string
  memberOf: ReadonlySet<string>
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const roleLabel = useRoleLabel()
  const errorMessage = useManagementErrorMessage()
  const { organizations } = useAuth()
  const choices = organizations.filter((org) => isOrgManagerRole(org.role) && !memberOf.has(org.id))
  const [orgId, setOrgId] = useState(choices[0]?.id ?? '')
  const [role, setRole] = useState<OrganizationMembershipRole>('member')
  const add = useApiMutation<unknown, { orgId: string; role: OrganizationMembershipRole }>(
    (api, input) =>
      api.post(`/v1/organizations/${input.orgId}/memberships`, {
        user_id: user.id,
        role: input.role,
      }),
    { invalidate: [['users', user.id]] },
  )
  return (
    <Dialog
      open
      onOpenChange={(next) => (next || add.isPending ? undefined : onClose())}
      title={<Trans>Add {name} to an organization</Trans>}
      position={{ narrow: 'fullscreen', regular: 'center' }}
      footer={
        <>
          <Button variant="secondary" disabled={add.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={!orgId}
            isLoading={add.isPending}
            onClick={() =>
              add.mutate(
                { orgId, role },
                {
                  onSuccess: () => {
                    notify({ title: t`${name} was added` })
                    onClose()
                  },
                },
              )
            }
          >
            <Trans>Add to organization</Trans>
          </Button>
        </>
      }
    >
      {choices.length === 0 ? (
        <Alert tone="info">
          <Trans>{name} already belongs to every organization you manage.</Trans>
        </Alert>
      ) : (
        <>
          <Field label={<Trans>Organization</Trans>}>
            <Select value={orgId} onChange={(event) => setOrgId(event.currentTarget.value)}>
              {choices.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={<Trans>Role</Trans>}>
            <Select
              value={role}
              onChange={(event) => setRole(event.currentTarget.value as OrganizationMembershipRole)}
            >
              <option value="member">{roleLabel('member')}</option>
              <option value="admin">{roleLabel('admin')}</option>
            </Select>
          </Field>
        </>
      )}
      {add.error ? <Alert tone="error">{errorMessage(add.error)}</Alert> : null}
    </Dialog>
  )
}

export function OrganizationsTab({ user, name }: { user: UserDetail; name: string }): ReactNode {
  const { t, i18n } = useLingui()
  const roleLabel = useRoleLabel()
  const errorMessage = useManagementErrorMessage()
  const memberships = useUserMemberships(user.id)
  const grants = useUserGrants(user.id)
  const revoke = useRevokeUserGrant(user.id)
  const [adding, setAdding] = useState(false)
  const [changing, setChanging] = useState<UserMembership | null>(null)
  const active = (memberships.data?.data ?? []).filter((row) => row.status === 'active')
  const editable = user.status !== 'deleted'
  const count = active.length

  return (
    <>
      <section {...stylex.props(detail.section)}>
        <div {...stylex.props(detail.sectionHead)}>
          <div {...stylex.props(detail.sectionText)}>
            <h2 {...stylex.props(detail.sectionTitle)}>
              <Trans>Organizations and roles</Trans>
            </h2>
            <p {...stylex.props(detail.sectionLead)}>
              {count === 0 ? (
                <Trans>{name} belongs to no organization.</Trans>
              ) : (
                <Trans>
                  {name} belongs to{' '}
                  <Plural value={count} one="# organization" other="# organizations" />.
                </Trans>
              )}
            </p>
          </div>
          {editable ? (
            <Button variant="secondary" onClick={() => setAdding(true)}>
              <Trans>Add to organization…</Trans>
            </Button>
          ) : null}
        </div>
        {memberships.isError ? (
          <EmptyState
            variant="load-failure"
            title={<Trans>Organizations could not be loaded</Trans>}
          />
        ) : !memberships.data ? (
          <Skeleton width="100%" height="3rem" />
        ) : (
          <ul {...stylex.props(detail.rows)}>
            {active.map((row) => {
              const joined = formatDate(i18n, row.joinedAt)
              return (
                <li key={row.id} {...stylex.props(detail.itemRow)}>
                  <div {...stylex.props(detail.itemMain)}>
                    <span {...stylex.props(detail.itemTitle)}>{row.organizationName}</span>
                    <span {...stylex.props(detail.itemSub)}>
                      {row.parentOrgId === null ? (
                        <Trans>Top-level organization. Joined {joined}.</Trans>
                      ) : (
                        <Trans>Joined {joined}.</Trans>
                      )}
                    </span>
                  </div>
                  <span {...stylex.props(detail.itemState)}>{roleLabel(row.role)}</span>
                  <span {...stylex.props(detail.itemAction)}>
                    {editable ? (
                      <Button variant="secondary" onClick={() => setChanging(row)}>
                        <Trans>Change role…</Trans>
                      </Button>
                    ) : null}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <section {...stylex.props(detail.section)}>
        <div {...stylex.props(detail.sectionText)}>
          <h2 {...stylex.props(detail.sectionTitle)}>
            <Trans>Project role grants</Trans>
          </h2>
          <p {...stylex.props(detail.sectionLead)}>
            <Trans>
              Direct grants can be removed here. A role that comes through a project grant changes
              only when that project grant changes.
            </Trans>
          </p>
        </div>
        {revoke.error ? <Alert tone="error">{errorMessage(revoke.error)}</Alert> : null}
        {grants.isError ? (
          <EmptyState
            variant="load-failure"
            title={<Trans>Role grants could not be loaded</Trans>}
          />
        ) : !grants.data ? (
          <Skeleton width="100%" height="3rem" />
        ) : grants.data.data.length === 0 ? (
          <p {...stylex.props(detail.sectionLead)}>
            <Trans>No project roles.</Trans>
          </p>
        ) : (
          <ul {...stylex.props(detail.rows)}>
            {grants.data.data.map((grant) => (
              <li key={grant.id} {...stylex.props(detail.itemRow)}>
                <div {...stylex.props(detail.itemMain)}>
                  <span {...stylex.props(detail.itemTitle)}>
                    {grant.role_name ?? grant.role_key ?? grant.role_id}
                  </span>
                  <span {...stylex.props(detail.itemSub)}>
                    {grant.project_name ?? grant.project_id}
                  </span>
                </div>
                <span {...stylex.props(detail.itemState)}>
                  <Badge tone="neutral" variant="outline">
                    {grant.granted_via === 'direct' ? (
                      <Trans>Direct grant</Trans>
                    ) : (
                      <Trans>Via project grant</Trans>
                    )}
                  </Badge>
                </span>
                <span {...stylex.props(detail.itemAction)}>
                  {grant.granted_via === 'direct' && editable ? (
                    <button
                      type="button"
                      aria-label={t`Remove role ${grant.role_name ?? grant.role_key ?? ''}`}
                      onClick={() => revoke.mutate(grant.id)}
                      {...stylex.props(list.iconButton, iconReset.button)}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {adding ? (
        <AddToOrganizationDialog
          user={user}
          name={name}
          memberOf={new Set(active.map((row) => row.orgId))}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {changing ? (
        <ChangeRoleDialog
          orgId={changing.orgId}
          orgName={changing.organizationName ?? ''}
          membershipId={changing.id}
          memberName={name}
          currentRole={changing.role}
          isSelf={false}
          onClose={() => setChanging(null)}
          invalidateKey={['users', user.id]}
        />
      ) : null}
    </>
  )
}

const iconReset = stylex.create({
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    borderWidth: 0,
    cursor: 'pointer',
  },
})
