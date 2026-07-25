import type { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { registerFakeIdpRoutes } from './fake-idp'
import { registerFakeSocialRoutes } from './fake-social'
import { registerFakeLdapRoutes } from './fake-ldap'
import { registerFakeSwaRoutes } from './fake-swa'
import { registerFakeWsfedRoutes } from './fake-wsfed'
import { registerTestOtpRoutes } from './test-otp'

export function registerTestHarnessRoutes(app: Hono<XidHonoEnv>): void {
  registerFakeIdpRoutes(app)
  registerFakeSocialRoutes(app)
  registerFakeLdapRoutes(app)
  registerFakeSwaRoutes(app)
  registerFakeWsfedRoutes(app)
  registerTestOtpRoutes(app)
}

export { FAKE_IDP_FIXTURE } from './fake-idp'
export { fakeSocialProviderConfig } from './fake-social'
export {
  captureTestOtp,
  readLatestTestOtp,
  TestSmsProvider,
  TestWhatsappProvider,
} from './test-otp'
export { isDevOrTestEnvironment } from './dev-gate'
