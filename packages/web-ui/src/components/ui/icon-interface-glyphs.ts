// 控件内部用的通用图标(关闭、复制、显示、提示),与导航图标同一规格。

import type { IconShape } from './icon-glyphs'

export const INTERFACE_ICON_NAMES = [
  'chevrons-up-down',
  'chevron-left',
  'chevron-right',
  'x',
  'plus',
  'copy',
  'eye',
  'eye-off',
  'search',
  'menu',
  'more-horizontal',
  'info-circle',
  'check-circle',
  'alert-circle',
  'alert-triangle',
  'sun',
  'moon',
  'maximize',
] as const

export type InterfaceIconName = (typeof INTERFACE_ICON_NAMES)[number]

export const interfaceGlyphs: Record<InterfaceIconName, readonly IconShape[]> = {
  'chevrons-up-down': [['path', { d: 'M8 10l4-4 4 4M8 14l4 4 4-4' }]],
  'chevron-left': [['path', { d: 'm14.5 6-6 6 6 6' }]],
  'chevron-right': [['path', { d: 'm9.5 6 6 6-6 6' }]],
  x: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  copy: [
    ['rect', { x: '8.5', y: '8.5', width: '11', height: '11', rx: '2' }],
    ['path', { d: 'M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2' }],
  ],
  eye: [
    ['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z' }],
    ['circle', { cx: '12', cy: '12', r: '3' }],
  ],
  'eye-off': [
    ['path', { d: 'M9.9 5.75A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4' }],
    ['path', { d: 'M6.3 7.3A16.6 16.6 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9.3 9.3 0 0 0 4.9-1.4' }],
    ['path', { d: 'M9.9 9.9a3 3 0 0 0 4.2 4.2' }],
    ['path', { d: 'M3.5 3.5l17 17' }],
  ],
  search: [
    ['circle', { cx: '11', cy: '11', r: '6.5' }],
    ['path', { d: 'm16 16 4 4' }],
  ],
  menu: [['path', { d: 'M4 7h16M4 12h16M4 17h16' }]],
  'more-horizontal': [
    ['circle', { cx: '5', cy: '12', r: '0.9' }],
    ['circle', { cx: '12', cy: '12', r: '0.9' }],
    ['circle', { cx: '19', cy: '12', r: '0.9' }],
  ],
  'info-circle': [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['path', { d: 'M12 11v5.5' }],
    ['path', { d: 'M12 7.8h.01' }],
  ],
  'check-circle': [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['path', { d: 'm8.5 12.2 2.4 2.4 4.6-4.8' }],
  ],
  'alert-circle': [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['path', { d: 'M12 7.5V13' }],
    ['path', { d: 'M12 16.3h.01' }],
  ],
  'alert-triangle': [
    ['path', { d: 'M12 4 21 19.5H3Z' }],
    ['path', { d: 'M12 10v4' }],
    ['path', { d: 'M12 16.8h.01' }],
  ],
  sun: [
    ['circle', { cx: '12', cy: '12', r: '4' }],
    [
      'path',
      {
        d: 'M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4',
      },
    ],
  ],
  moon: [['path', { d: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z' }]],
  maximize: [['path', { d: 'M14.5 3.5h6v6M9.5 20.5h-6v-6M20.5 3.5l-7 7M3.5 20.5l7-7' }]],
}
