// Mustache 子集渲染测试:变量插值 / HTML 转义 / raw / 条件块 / 反向块 / 数组遍历 / 点号路径。

import { describe, it, expect } from 'vitest'
import { renderTemplate } from '../mustache'

describe('renderTemplate:变量插值', () => {
  it('替换 {{ var }}', () => {
    expect(renderTemplate('Hi {{ name }}', { name: 'Ada' })).toBe('Hi Ada')
  })

  it('缺失变量渲染为空串', () => {
    expect(renderTemplate('Hi {{ name }}!', {})).toBe('Hi !')
  })

  it('数字变量转字符串', () => {
    expect(renderTemplate('code {{ code }}', { code: 123456 })).toBe('code 123456')
  })

  it('点号路径解析嵌套对象', () => {
    expect(renderTemplate('{{ brand.name }}', { brand: { name: 'XID' } })).toBe('XID')
  })
})

describe('renderTemplate:HTML 转义', () => {
  it('{{ var }} 转义 HTML 特殊字符', () => {
    expect(renderTemplate('{{ x }}', { x: '<b>&"\'' })).toBe('&lt;b&gt;&amp;&quot;&#39;')
  })

  it('{{{ var }}} 不转义(raw)', () => {
    expect(renderTemplate('{{{ x }}}', { x: '<b>' })).toBe('<b>')
  })
})

describe('renderTemplate:条件块', () => {
  it('{{#if}} truthy 渲染内容', () => {
    expect(renderTemplate('{{# verified }}OK{{/ verified }}', { verified: true })).toBe('OK')
  })

  it('{{#if}} falsy 跳过内容', () => {
    expect(renderTemplate('{{# verified }}OK{{/ verified }}', { verified: false })).toBe('')
  })

  it('块内可访问外层与内层作用域', () => {
    const out = renderTemplate('{{# user }}{{ name }}@{{ org }}{{/ user }}', {
      org: 'acme',
      user: { name: 'ada' },
    })
    expect(out).toBe('ada@acme')
  })

  it('空数组视为 falsy,块不渲染', () => {
    expect(renderTemplate('{{# items }}x{{/ items }}', { items: [] })).toBe('')
  })
})

describe('renderTemplate:反向块', () => {
  it('{{^ section }} falsy 渲染', () => {
    expect(renderTemplate('{{^ verified }}NO{{/ verified }}', { verified: false })).toBe('NO')
  })

  it('{{^ section }} truthy 跳过', () => {
    expect(renderTemplate('{{^ verified }}NO{{/ verified }}', { verified: true })).toBe('')
  })
})

describe('renderTemplate:数组遍历', () => {
  it('遍历对象数组', () => {
    const out = renderTemplate('{{# roles }}[{{ name }}]{{/ roles }}', {
      roles: [{ name: 'admin' }, { name: 'viewer' }],
    })
    expect(out).toBe('[admin][viewer]')
  })

  it('遍历标量数组用 {{ . }}', () => {
    const out = renderTemplate('{{# tags }}{{ . }} {{/ tags }}', { tags: ['a', 'b'] })
    expect(out).toBe('a b ')
  })
})

describe('renderTemplate:嵌套块', () => {
  it('块内嵌块正确配对', () => {
    const out = renderTemplate('{{# a }}A{{# b }}B{{/ b }}{{/ a }}', { a: true, b: true })
    expect(out).toBe('AB')
  })

  it('内层 falsy 只跳过内层', () => {
    const out = renderTemplate('{{# a }}A{{# b }}B{{/ b }}C{{/ a }}', { a: true, b: false })
    expect(out).toBe('AC')
  })
})
