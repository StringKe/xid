// MDX 全局组件表：由 [...slug].astro 的 Content components 注入，无需在 MDX 内 import。

import { Aside } from './components/ui/aside'
import Render from './components/Render.astro'
import { Card } from './components/ui/card'
import { CardGrid } from './components/ui/card-grid'
import { PackageManagers } from './components/ui/package-managers'
import { Step, Steps } from './components/ui/steps'
import { Tabs, TabItem } from './components/ui/tabs'

export const components = {
  Aside,
  Card,
  CardGrid,
  PackageManagers,
  Render,
  Step,
  Steps,
  TabItem,
  Tabs,
}
