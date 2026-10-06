import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { EndpointList } from './EndpointList'
import type { SsoConnection } from './types'

function present(value: string | undefined): string[] {
  return value ? [value] : []
}

export function SsoConnectionEndpoints({ connection }: { connection: SsoConnection }): ReactNode {
  const { t } = useLingui()
  return (
    <EndpointList
      entries={[
        { label: t`SP entity ID`, values: present(connection.sp_entity_id) },
        { label: t`ACS URL`, values: present(connection.acs_url) },
        { label: t`SP metadata URL`, values: present(connection.sp_metadata_url) },
        { label: t`SLO URL`, values: present(connection.slo_url) },
        {
          label: t`OIDC redirect URIs`,
          values: connection.oidc_callback_urls ?? [],
          hint: (
            <Trans>
              Register every URL in the identity provider app. Users return to the host they started
              signing in from.
            </Trans>
          ),
        },
      ]}
    />
  )
}
