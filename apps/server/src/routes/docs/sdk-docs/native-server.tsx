// 原生服务端 SDK 组(sdk/*,状态固定 "Implemented · verified locally",
// 正文必须注明 real IdP round-trip 验证待人工完成)。
// 每包一个独立文件(<300 行)导出 <NAME>_DOC,再 import 进本数组。

import { DOTNET_DOC } from './native-server-dotnet'
import { GO_DOC } from './native-server-go'
import { JAVA_DOC } from './native-server-java'
import { PHP_DOC } from './native-server-php'
import { PYTHON_DOC } from './native-server-python'
import { RUBY_DOC } from './native-server-ruby'
import { RUST_DOC } from './native-server-rust'
import type { SdkDocEntry } from './shared'

export const NATIVE_SERVER_DOCS: readonly SdkDocEntry[] = [
  GO_DOC,
  RUST_DOC,
  PYTHON_DOC,
  RUBY_DOC,
  PHP_DOC,
  JAVA_DOC,
  DOTNET_DOC,
]
