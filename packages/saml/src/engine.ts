// SAML 处理层 crypto/DOM engine 注入。把 Workers/Node 原生 Web Crypto 与纯 JS DOM 依赖
// 注入 xmldsigjs(经 xml-core),禁止自研 XML 签名(见 crypto-boundary rule、04 章第 7、8 节)。
//
// 两类注入:
// 1. WebCrypto engine:Application.setEngine("webcrypto", crypto) 让 xmldsigjs 走 crypto.subtle,
//    把 bundle 内 node-webcrypto-ossl external/ignore(见 04 章 8 开头),Workers 原生支持。
// 2. DOM 依赖:xml-core 的 Parse/Stringify/Select 在无浏览器全局(DOMParser/XMLSerializer/document)
//    时回落到 setNodeDependencies 注册的 @xmldom/xmldom + xpath(纯 JS 可 bundle)。
//
// Workers 注意:xml-core 在模块加载期按 `typeof self !== 'undefined'` 决定 Select 实现。
// Workers 全局 self 存在但无 document.evaluate,故必须显式注册 xpath 依赖并依赖 node 路径;
// 若该绑定在 Workers 走了 self 分支,spike 落地时需在 bundle 层 shim(见 index.ts SPIKE_RESULT 注释)。

import { Application } from 'xmldsigjs'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { setNodeDependencies } from 'xml-core'
import xpath from 'xpath'

let engineReady = false

// 一次性注入 native Web Crypto + 纯 JS DOM 依赖。重复调用幂等。
// crypto 默认取运行时全局(Workers/Node 19+ 均提供 globalThis.crypto)。
export function setSamlEngine(cryptoEngine: Crypto = globalThis.crypto): void {
  if (engineReady) {
    return
  }

  Application.setEngine('webcrypto', cryptoEngine)

  // xml-core 的 Parse/Stringify 在无全局 DOMParser/XMLSerializer 时取这里注册的实现;
  // Select(XPath)在 node 路径取 xpath.select。@xmldom/xmldom + xpath 均纯 JS 可 bundle。
  setNodeDependencies({
    DOMParser,
    XMLSerializer,
    xpath,
  })

  engineReady = true
}

// 测试 / 强制重注入用(如切换 mock crypto)。生产路径不调用。
export function resetSamlEngine(): void {
  engineReady = false
}
