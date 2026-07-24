// TS 包组(packages/*,状态固定 "Current package")。
// 包含 10 个新增框架页:vue / nuxt / svelte / solid / angular / astro / remix /
// expo / electron / tauri,以及迁移自原 ts-frameworks 的 5 个既有页。

import { ANGULAR_DOC } from './angular'
import { ASTRO_DOC } from './astro'
import { BACKEND_DOC } from './backend'
import { CORE_DOC } from './core'
import { ELECTRON_DOC } from './electron'
import { EXPO_DOC } from './expo'
import { NEXTJS_DOC } from './nextjs'
import { NUXT_DOC } from './nuxt'
import { REACT_DOC } from './react'
import { REACT_NATIVE_DOC } from './react-native'
import { REMIX_DOC } from './remix'
import type { SdkDocEntry } from './shared'
import { SOLID_DOC } from './solid'
import { SVELTE_DOC } from './svelte'
import { TAURI_DOC } from './tauri'
import { VUE_DOC } from './vue'

export const TS_FRAMEWORK_DOCS: readonly SdkDocEntry[] = [
  CORE_DOC,
  BACKEND_DOC,
  REACT_DOC,
  NEXTJS_DOC,
  REACT_NATIVE_DOC,
  VUE_DOC,
  NUXT_DOC,
  SVELTE_DOC,
  SOLID_DOC,
  ANGULAR_DOC,
  ASTRO_DOC,
  REMIX_DOC,
  EXPO_DOC,
  ELECTRON_DOC,
  TAURI_DOC,
]
