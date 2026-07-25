// sdk-docs 对外入口:聚合三个组为 SDK_DETAIL_DOCS(routes/docs/index.tsx 消费,顺序即侧栏顺序)。

import { NATIVE_CLIENT_DOCS } from './native-client'
import { NATIVE_SERVER_DOCS } from './native-server'
import type { SdkDocEntry } from './shared'
import { TS_FRAMEWORK_DOCS } from './ts-frameworks'

export { defineSdkDoc } from './shared'
export type { SdkDocEntry, SdkDocInput, SdkDocSection } from './shared'
export { NATIVE_CLIENT_DOCS } from './native-client'
export { NATIVE_SERVER_DOCS } from './native-server'
export { TS_FRAMEWORK_DOCS } from './ts-frameworks'

export const SDK_DETAIL_DOCS: readonly SdkDocEntry[] = [
  ...TS_FRAMEWORK_DOCS,
  ...NATIVE_SERVER_DOCS,
  ...NATIVE_CLIENT_DOCS,
]
