// renderer 入口：禁止引入 Node / main 进程 API。

export { getIpcStorageAdapter, getXidBridge } from './ipc-storage'

export {
  XidClient,
  XidStore,
  XidNetworkError,
  makeXidError,
  isXidErrorShape,
  decodeTokenClaims,
  isTokenExpiring,
  SESSION_STATUS,
  CLIENT_STATUS,
} from '@xid-kit/core'

export type {
  XidUser,
  XidOrganization,
  XidOrganizationMembership,
  XidSession,
  XidApiKey,
  XidApiKeyWithSecret,
  XidPage,
  CreateApiKeyInput,
  SignInPasswordInput,
  SignInResult,
  SessionStatus,
  ClientStatus,
  XidState,
  XidStateListener,
  Unsubscribe,
  GetTokenOptions,
  XidClientOptions,
} from '@xid-kit/core'

export type { OrganizationMembershipRole } from '@xid-kit/types'

export type { SecureStorageAdapter, XidBridge, SignInOptions, IpcChannels } from '../types'

export { IPC_CHANNELS, XID_BRIDGE_KEY } from '../types'
