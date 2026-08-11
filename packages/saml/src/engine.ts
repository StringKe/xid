// 将 Web Crypto 与纯 JS DOM 注入 xmldsigjs;Workers 的 self 存在但无 document.evaluate,
// 必须 setNodeDependencies 注册 xpath,否则 xml-core 会误走浏览器 Select。

import { Application } from 'xmldsigjs'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { setNodeDependencies } from 'xml-core'
import xpath from 'xpath'

let engineReady = false

// 幂等:仅首次注入。crypto 默认取 globalThis.crypto。
export function setSamlEngine(cryptoEngine: Crypto = globalThis.crypto): void {
  if (engineReady) {
    return
  }

  Application.setEngine('webcrypto', cryptoEngine)

  setNodeDependencies({
    DOMParser,
    XMLSerializer,
    xpath,
  })

  engineReady = true
}

// 测试用,强制可重注入。
export function resetSamlEngine(): void {
  engineReady = false
}
