// Access:谁能登录项目里的应用(Open / Restricted)、共享给其他组织(项目授权)、直接授予本组织成员的角色。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useAuth } from '@xid-kit/web-ui/session'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import {
  Alert,
  Button,
  Dialog,
  Field,
  Icon,
  Input,
  RadioGroup,
  Select,
  useToast,
} from '@xid-kit/web-ui/ui'
import { detail } from '../../components/page/detail-styles'
import { list } from '../../components/page/list-styles'
import {
  useCreateProjectGrant,
  useProjectGrantsQuery,
  useProjectRolesQuery,
  useRevokeProjectGrant,
} from '../org/queries'
import { formatDate } from '../../lib/date-format'
import type { ProjectRecord } from './project-api'
import {
  useGiveRole,
  useProjectUserGrants,
  useTakeRole,
  useUpdateProjectRecord,
} from './project-api'

function SignInRule({ project }: { project: ProjectRecord }): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const errorMessage = useManagementErrorMessage()
  const update = useUpdateProjectRecord(project.id)
  const [policy, setPolicy] = useState(
    project.access_policy === 'restricted' ? 'restricted' : 'open',
  )
  const name = project.name
  return (
    <section {...stylex.props(detail.section)}>
      <div {...stylex.props(detail.sectionText)}>
        <h2 {...stylex.props(detail.sectionTitle)}>
          <Trans>Who can sign in to {name} apps</Trans>
        </h2>
        <p {...stylex.props(detail.sectionLead)}>
          <Trans>Checked at sign-in for every application in {name}.</Trans>
        </p>
      </div>
      <RadioGroup
        label={t`Sign-in rule`}
        value={policy}
        onValueChange={setPolicy}
        options={[
          {
            value: 'open',
            label: <Trans>Any member of the organization</Trans>,
            description: (
              <Trans>
                People without a {name} role can still sign in. Their token has an empty roles
                claim.
              </Trans>
            ),
          },
          {
            value: 'restricted',
            label: <Trans>Only people with a {name} role</Trans>,
            description: <Trans>Everyone else is turned away with access denied.</Trans>,
          },
        ]}
      />
      {update.error ? <Alert tone="error">{errorMessage(update.error)}</Alert> : null}
      <div>
        <Button
          isLoading={update.isPending}
          onClick={() =>
            update.mutate(
              { access_policy: policy === 'restricted' ? 'restricted' : 'open' },
              { onSuccess: () => notify({ title: t`Sign-in rule saved` }) },
            )
          }
        >
          <Trans>Save sign-in rule</Trans>
        </Button>
      </div>
    </section>
  )
}

function ShareDialog({
  project,
  onClose,
}: {
  project: ProjectRecord
  onClose: () => void
}): ReactNode {
  const { organizations } = useAuth()
  const errorMessage = useManagementErrorMessage()
  const create = useCreateProjectGrant(project.id, project.org_id)
  const choices = organizations.filter((org) => org.id !== project.org_id)
  const [target, setTarget] = useState(choices[0]?.id ?? '')
  const [manual, setManual] = useState('')
  const orgId = manual.trim() || target
  return (
    <Dialog
      open
      onOpenChange={(next) => (next || create.isPending ? undefined : onClose())}
      title={<Trans>Share {project.name} with an organization</Trans>}
      description={
        <Trans>
          Admins of that organization can give {project.name} roles to their own members. They
          cannot change roles or apps.
        </Trans>
      }
      footer={
        <>
          <Button variant="secondary" disabled={create.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={!orgId}
            isLoading={create.isPending}
            onClick={() => create.mutate({ granted_to_org_id: orgId }, { onSuccess: onClose })}
          >
            <Trans>Share project</Trans>
          </Button>
        </>
      }
    >
      {choices.length > 0 ? (
        <Field label={<Trans>Organization</Trans>}>
          <Select value={target} onChange={(event) => setTarget(event.currentTarget.value)}>
            {choices.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label={<Trans>Or enter an organization ID</Trans>}>
        <Input
          value={manual}
          onChange={(event) => setManual(event.currentTarget.value)}
          spellCheck={false}
        />
      </Field>
      {create.error ? <Alert tone="error">{errorMessage(create.error)}</Alert> : null}
    </Dialog>
  )
}

function GiveRoleDialog({
  project,
  onClose,
}: {
  project: ProjectRecord
  onClose: () => void
}): ReactNode {
  const errorMessage = useManagementErrorMessage()
  const roles = useProjectRolesQuery(project.id, 'active')
  const give = useGiveRole(project.id)
  const [userId, setUserId] = useState('')
  const [roleId, setRoleId] = useState('')
  const options = roles.data?.data ?? []
  return (
    <Dialog
      open
      onOpenChange={(next) => (next || give.isPending ? undefined : onClose())}
      title={<Trans>Give a {project.name} role</Trans>}
      description={
        <Trans>
          The person must be an active member of the organization that owns {project.name}.
        </Trans>
      }
      footer={
        <>
          <Button variant="secondary" disabled={give.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={!userId.trim() || !roleId}
            isLoading={give.isPending}
            onClick={() =>
              give.mutate({ user_id: userId.trim(), role_id: roleId }, { onSuccess: onClose })
            }
          >
            <Trans>Give role</Trans>
          </Button>
        </>
      }
    >
      <Field label={<Trans>User ID</Trans>}>
        <Input
          value={userId}
          onChange={(event) => setUserId(event.currentTarget.value)}
          spellCheck={false}
        />
      </Field>
      <Field label={<Trans>Role</Trans>}>
        <Select value={roleId} onChange={(event) => setRoleId(event.currentTarget.value)}>
          <option value="" disabled>
            {'-'}
          </option>
          {options.map((role) => (
            <option key={role.id} value={role.id}>
              {role.display_name} ({role.key})
            </option>
          ))}
        </Select>
      </Field>
      {give.error ? <Alert tone="error">{errorMessage(give.error)}</Alert> : null}
    </Dialog>
  )
}

export function ProjectAccessTab({
  project,
  canManage,
}: {
  project: ProjectRecord
  canManage: boolean
}): ReactNode {
  const { t, i18n } = useLingui()
  const { organizations } = useAuth()
  const errorMessage = useManagementErrorMessage()
  const grants = useProjectGrantsQuery(project.id)
  const revoke = useRevokeProjectGrant(project.id)
  const userGrants = useProjectUserGrants(project.id)
  const take = useTakeRole(project.id)
  const [sharing, setSharing] = useState(false)
  const [giving, setGiving] = useState(false)
  const orgName = (id: string) => organizations.find((org) => org.id === id)?.name ?? id
  const direct = (userGrants.data?.data ?? []).filter((grant) => grant.granted_via === 'direct')
  const name = project.name

  return (
    <>
      {canManage ? <SignInRule project={project} /> : null}
      <section {...stylex.props(detail.section)}>
        <div {...stylex.props(detail.sectionHead)}>
          <div {...stylex.props(detail.sectionText)}>
            <h2 {...stylex.props(detail.sectionTitle)}>
              <Trans>Shared with other organizations</Trans>
            </h2>
            <p {...stylex.props(detail.sectionLead)}>
              <Trans>Revoking a share removes every {name} role that came through it.</Trans>
            </p>
          </div>
          {canManage ? (
            <Button variant="secondary" onClick={() => setSharing(true)}>
              <Trans>Share with an organization…</Trans>
            </Button>
          ) : null}
        </div>
        {revoke.error ? <Alert tone="error">{errorMessage(revoke.error)}</Alert> : null}
        <ul {...stylex.props(detail.rows)}>
          {(grants.data?.data ?? []).map((grant) => {
            const shared = formatDate(i18n, grant.created_at)
            return (
              <li key={grant.id} {...stylex.props(detail.itemRow)}>
                <div {...stylex.props(detail.itemMain)}>
                  <span {...stylex.props(detail.itemTitle)}>
                    {orgName(grant.granted_to_org_id)}
                  </span>
                  <span {...stylex.props(detail.itemSub)}>
                    <Trans>Shared {shared}</Trans>
                  </span>
                </div>
                <span {...stylex.props(detail.itemAction)}>
                  {canManage ? (
                    <Button
                      variant="danger"
                      isLoading={revoke.isPending && revoke.variables === grant.id}
                      onClick={() => revoke.mutate(grant.id)}
                    >
                      <Trans>Revoke</Trans>
                    </Button>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
        {grants.data && grants.data.data.length === 0 ? (
          <p {...stylex.props(detail.sectionLead)}>
            <Trans>Not shared with any organization.</Trans>
          </p>
        ) : null}
      </section>
      <section {...stylex.props(detail.section)}>
        <div {...stylex.props(detail.sectionHead)}>
          <div {...stylex.props(detail.sectionText)}>
            <h2 {...stylex.props(detail.sectionTitle)}>
              <Trans>Roles given directly</Trans>
            </h2>
            <p {...stylex.props(detail.sectionLead)}>
              <Trans>
                Roles given through a shared organization are a project grant and are listed on that
                organization.
              </Trans>
            </p>
          </div>
          {canManage ? (
            <Button onClick={() => setGiving(true)}>
              <Icon name="plus" size={16} />
              <Trans>Give a role…</Trans>
            </Button>
          ) : null}
        </div>
        {take.error ? <Alert tone="error">{errorMessage(take.error)}</Alert> : null}
        <ul {...stylex.props(detail.rows)}>
          {direct.map((grant) => {
            const role = grant.role_name ?? grant.role_key ?? grant.role_id
            return (
              <li key={grant.id} {...stylex.props(detail.itemRow)}>
                <div {...stylex.props(detail.itemMain)}>
                  <span {...stylex.props(list.mono)}>{grant.user_id}</span>
                </div>
                <span {...stylex.props(detail.itemState)}>{role}</span>
                <span {...stylex.props(detail.itemAction)}>
                  {canManage ? (
                    <button
                      type="button"
                      aria-label={t`Remove role ${role} from ${grant.user_id}`}
                      onClick={() => take.mutate(grant.id)}
                      {...stylex.props(list.iconButton, buttonReset.base)}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
        {userGrants.data && direct.length === 0 ? (
          <p {...stylex.props(detail.sectionLead)}>
            <Trans>Nobody has a direct {name} role yet.</Trans>
          </p>
        ) : null}
      </section>
      {sharing ? <ShareDialog project={project} onClose={() => setSharing(false)} /> : null}
      {giving ? <GiveRoleDialog project={project} onClose={() => setGiving(false)} /> : null}
    </>
  )
}

const buttonReset = stylex.create({
  base: { display: 'inline-flex', alignItems: 'center', borderWidth: 0, cursor: 'pointer' },
})
