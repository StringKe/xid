// OIDC 管理 stub(SSF/federation)的 instance_manager 门控。

import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { requireInstanceManager } from '../platform/shared'
import type { XidHonoEnv } from '../lib/types'
import { oauthError } from './shared'

export async function requireOidcManagementAuth(c: Context<XidHonoEnv>): Promise<Response | null> {
  try {
    await requireInstanceManager(c)
    return null
  } catch (err) {
    if (err instanceof AppError) {
      const status = err.httpStatus ?? (err.code === 'forbidden' ? 403 : 401)
      return oauthError(c, {
        status,
        error: err.code,
        description: err.longMessage ?? err.code,
      })
    }
    throw err
  }
}
