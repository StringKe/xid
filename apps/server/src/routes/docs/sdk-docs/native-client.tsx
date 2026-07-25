// 原生客户端 SDK 组(sdk/*,状态固定 "Implemented · verified locally",
// 正文必须注明 real IdP round-trip 验证待人工完成)。
// 每包一个独立文件(<300 行)导出 <NAME>_DOC,再 import 进本数组。
// slug 已在 apps/server/public-docs.ts 注册。

import { ANDROID_DOC } from './native-client-android'
import { FLUTTER_DOC } from './native-client-flutter'
import { IOS_DOC } from './native-client-ios'
import { LINUX_DOC } from './native-client-linux'
import { MACOS_DOC } from './native-client-macos'
import { WINDOWS_DOC } from './native-client-windows'
import type { SdkDocEntry } from './shared'

export const NATIVE_CLIENT_DOCS: readonly SdkDocEntry[] = [
  IOS_DOC,
  ANDROID_DOC,
  FLUTTER_DOC,
  MACOS_DOC,
  WINDOWS_DOC,
  LINUX_DOC,
]
