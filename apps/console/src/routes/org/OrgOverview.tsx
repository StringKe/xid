// 组织 Overview:先列需要处理的事,再看登录走势。新组织在三步引导完成或出现第一次登录之前显示引导。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { Alert } from '@xid-kit/web-ui/ui'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { useAuth } from '@xid-kit/web-ui/session'
import { PageFrame } from '../../components/page/PageFrame'
import { AttentionList } from './AttentionList'
import {
  SignInActivityPending,
  SignInActivitySection,
  hasSignInActivity,
} from './OrgOverviewMetrics'
import { useOrgAttention, useSetupProgress, useSignInActivity } from './overview-queries'
import { SetupChecklist, isSetupComplete } from './SetupChecklist'
import { useCanManageOrg, useOrgTarget } from './useOrgTarget'

export default function OrgOverview(): ReactNode {
  const { user } = useAuth()
  const { orgId, activeOrg } = useOrgTarget()
  const canManage = useCanManageOrg(orgId)
  const attention = useOrgAttention(orgId, { enabled: canManage })
  const activity = useSignInActivity(orgId, { enabled: canManage })
  const setup = useSetupProgress(orgId, { enabled: canManage })
  const orgName = activeOrg ? organizationDisplayName(activeOrg) : ''

  if (!orgId) {
    return (
      <PageFrame title={<Trans>Overview</Trans>}>
        <Alert tone="info">
          <Trans>
            No organization selected. Choose one from the organization switcher to see its overview.
          </Trans>
        </Alert>
      </PageFrame>
    )
  }

  if (!canManage) {
    return (
      <PageFrame title={<Trans>Overview</Trans>}>
        <Alert tone="info">
          <Trans>Only owners and admins of {orgName} can see this overview.</Trans>
        </Alert>
      </PageFrame>
    )
  }

  const setupMode =
    setup.data !== undefined &&
    activity.data !== undefined &&
    !isSetupComplete(setup.data) &&
    !hasSignInActivity(activity.data)

  if (setupMode && setup.data) {
    return (
      <PageFrame
        title={<Trans>Set up {orgName}</Trans>}
        lead={
          <Trans>
            Three steps before you invite your team. Each one takes a few minutes, and you can come
            back to this page at any time.
          </Trans>
        }
      >
        <SetupChecklist progress={setup.data} orgId={orgId} />
        <SignInActivityPending orgName={orgName} />
      </PageFrame>
    )
  }

  return (
    <PageFrame
      title={<Trans>Overview</Trans>}
      lead={<Trans>What needs your attention in {orgName}, then how sign-ins are trending.</Trans>}
    >
      <AttentionList
        orgId={orgId}
        attention={attention.data}
        isLoading={attention.isLoading}
        isError={attention.isError}
        onRetry={() => void attention.refetch()}
      />
      <SignInActivitySection
        orgName={orgName}
        activity={activity.data}
        isLoading={activity.isLoading}
        isError={activity.isError}
        onRetry={() => void activity.refetch()}
        showUsageLink={user?.instanceManager === true}
      />
    </PageFrame>
  )
}
