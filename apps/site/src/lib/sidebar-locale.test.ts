import { describe, expect, it } from 'vitest'
import type { SidebarItem, SidebarSection } from '@cloudflare/nimbus-docs/types'
import { scopeSidebarSectionsToSiteLocale, scopeSidebarToSiteLocale } from './sidebar-locale'

const deDocsLink: SidebarItem = {
  type: 'link',
  label: 'Dokumentation',
  href: '/de/docs/',
  order: 0,
}

const deGettingStarted: SidebarItem = {
  type: 'link',
  label: 'Erste Schritte',
  href: '/de/getting-started/',
  order: 1,
}

const deLocaleGroup: SidebarItem = {
  type: 'group',
  label: 'De',
  order: 0,
  children: [deDocsLink, deGettingStarted],
}

const englishGettingStarted: SidebarItem = {
  type: 'link',
  label: 'Getting started',
  href: '/getting-started/',
  order: 0,
}

const englishSdks: SidebarItem = {
  type: 'group',
  label: 'SDKs',
  order: 1,
  indexHref: '/sdks/',
  children: [],
}

const tree: SidebarItem[] = [
  englishGettingStarted,
  englishSdks,
  deLocaleGroup,
  {
    type: 'group',
    label: 'Zh hans',
    order: 2,
    children: [
      {
        type: 'link',
        label: '文档',
        href: '/zh-hans/docs/',
        order: 0,
      },
    ],
  },
]

const sections: SidebarSection[] = [
  {
    label: 'Deutsch',
    href: '/de/docs/',
    isActive: false,
  },
  {
    label: 'Components',
    href: '/components/',
    isActive: false,
  },
  {
    label: '简体中文',
    href: '/zh-hans/docs/',
    isActive: false,
  },
]

describe('localized sidebar', () => {
  it('keeps only the current locale tree', () => {
    expect(scopeSidebarToSiteLocale(tree, '/getting-started/')).toEqual([
      englishGettingStarted,
      englishSdks,
    ])
    expect(scopeSidebarToSiteLocale(tree, '/zh-hans/getting-started/')).toEqual([
      {
        type: 'link',
        label: '文档',
        href: '/zh-hans/docs/',
        order: 0,
      },
    ])
    expect(scopeSidebarToSiteLocale(tree, '/de/docs/')).toEqual([deDocsLink, deGettingStarted])
  })

  it('keeps only the current locale header section', () => {
    expect(scopeSidebarSectionsToSiteLocale(sections, '/de/getting-started/')).toEqual([
      sections[0],
    ])
    expect(scopeSidebarSectionsToSiteLocale(sections, '/getting-started/')).toEqual([sections[1]])
  })

  it('fails when the locale boundary is missing', () => {
    expect(() => scopeSidebarToSiteLocale(tree, '/fr/getting-started/')).toThrow(
      'expected one sidebar group for /fr/docs, received 0',
    )
  })
})
