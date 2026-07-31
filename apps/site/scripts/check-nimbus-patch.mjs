import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const siteRoot = fileURLToPath(new URL('../', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))

function invariant(condition, message) {
  if (!condition) throw new Error(`[nimbus-patch] ${message}`)
}

const workspaceSource = await readFile(
  new URL('../../../pnpm-workspace.yaml', import.meta.url),
  'utf8',
)
const rootPackage = JSON.parse(
  await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
)
const installedPackage = JSON.parse(
  await readFile(
    new URL('../node_modules/@cloudflare/nimbus-docs/package.json', import.meta.url),
    'utf8',
  ),
)

const catalogMatch = /^\s*'@cloudflare\/nimbus-docs':\s*([^\s#]+)\s*$/mu.exec(workspaceSource)
invariant(catalogMatch, 'pnpm catalog has no exact Nimbus version')
const catalogVersion = catalogMatch[1]
invariant(
  /^\d+\.\d+\.\d+$/u.test(catalogVersion),
  'Nimbus must stay exactly pinned while a local patch is required',
)
invariant(
  installedPackage.version === catalogVersion,
  `installed ${installedPackage.version} does not match catalog ${catalogVersion}`,
)

const patchKey = `@cloudflare/nimbus-docs@${catalogVersion}`
const patchRelativePath = rootPackage.pnpm?.patchedDependencies?.[patchKey]
invariant(patchRelativePath, `${patchKey} is absent from pnpm.patchedDependencies`)
const patchUrl = new URL(`../../../${patchRelativePath}`, import.meta.url)
const patchSource = await readFile(patchUrl, 'utf8')
const installedHead = await readFile(
  new URL(
    '../node_modules/@cloudflare/nimbus-docs/src/components/NimbusHead.astro',
    import.meta.url,
  ),
  'utf8',
)

for (const marker of [
  'locale?: string;',
  'openGraphLocale?: string;',
  'socialImageAlt?: string;',
  'llmsIndexUrl?: string;',
]) {
  invariant(patchSource.includes(marker), `patch is missing ${marker}`)
  invariant(installedHead.includes(marker), `installed Nimbus is missing ${marker}`)
}

console.log(
  `[nimbus-patch] PASS version=${catalogVersion} patch=${patchRelativePath} site=${siteRoot} repo=${repositoryRoot}`,
)
