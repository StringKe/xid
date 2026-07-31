export const SDK_RELEASE_VERSION = '0.1.0-alpha.0'

export const PUBLIC_SDK_PACKAGES = [
  {
    dir: 'types',
    name: '@xid-kit/types',
    homepage: 'https://xid.dev/sdks',
    subpaths: ['cloudflare'],
    serverOnlySubpaths: ['cloudflare'],
  },
  { dir: 'crypto', name: '@xid-kit/crypto', homepage: 'https://xid.dev/sdks' },
  { dir: 'protocol', name: '@xid-kit/protocol', homepage: 'https://xid.dev/sdks' },
  { dir: 'core', name: '@xid-kit/core', homepage: 'https://xid.dev/sdks/core' },
  { dir: 'backend', name: '@xid-kit/backend', homepage: 'https://xid.dev/sdks/backend' },
  { dir: 'react', name: '@xid-kit/react', homepage: 'https://xid.dev/sdks/react' },
  { dir: 'nextjs', name: '@xid-kit/nextjs', homepage: 'https://xid.dev/sdks/nextjs' },
  { dir: 'vue', name: '@xid-kit/vue', homepage: 'https://xid.dev/sdks/vue' },
  { dir: 'nuxt', name: '@xid-kit/nuxt', homepage: 'https://xid.dev/sdks/nuxt' },
  {
    dir: 'svelte',
    name: '@xid-kit/svelte',
    homepage: 'https://xid.dev/sdks/svelte',
    subpaths: ['server'],
  },
  { dir: 'angular', name: '@xid-kit/angular', homepage: 'https://xid.dev/sdks/angular' },
  {
    dir: 'remix',
    name: '@xid-kit/remix',
    homepage: 'https://xid.dev/sdks/remix',
    subpaths: ['server'],
  },
  {
    dir: 'astro',
    name: '@xid-kit/astro',
    homepage: 'https://xid.dev/sdks/astro',
    subpaths: ['integration', 'integration-middleware', 'middleware', 'client', 'server', 'locals'],
  },
  { dir: 'solid', name: '@xid-kit/solid', homepage: 'https://xid.dev/sdks/solid' },
  {
    dir: 'react-native',
    name: '@xid-kit/react-native',
    homepage: 'https://xid.dev/sdks/react-native',
  },
  { dir: 'expo', name: '@xid-kit/expo', homepage: 'https://xid.dev/sdks/expo' },
  {
    dir: 'electron',
    name: '@xid-kit/electron',
    homepage: 'https://xid.dev/sdks/electron',
    subpaths: ['main', 'renderer', 'preload'],
  },
  { dir: 'tauri', name: '@xid-kit/tauri', homepage: 'https://xid.dev/sdks/tauri' },
]
