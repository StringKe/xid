# XID Site and Nimbus contract

This package owns the complete localized developer documentation served from `https://xid.dev`.

## Runtime ownership

- The apex host is canonical. The `https://www.xid.dev` host redirects to the same apex path and preserves its query.
- The apex page is the Nimbus documentation hub. There is no separate marketing runtime.
- The authenticated Console remains a separately isolated application surface.
- Every Site Worker response carries `X-XID-Route-Owner: site`.
- Core exclusively owns `https://xid.dev/.well-known/llms.txt`.

## Nimbus content

- `@cloudflare/nimbus-docs` is the rendering, navigation, search, Markdown downlevel, metadata, and SEO framework.
- `src/content-source/docs/documents.json` is the committed locale-neutral document AST and the only source used to generate one hub plus 40 public documents for all 8 locales.
- Files under `src/content/generated/docs/` are generated output. Never edit them by hand.
- A normal build must not read the historical Core docs route source.
- Published docs use BCP 47 locale metadata and lowercase locale URL segments.
- Public pages are limited to the registered hub and document set. Internal repository docs stay outside the Astro content collection.
- Draft and noindex content must not enter agent indexes, Pagefind, or sitemaps.
- Unversioned pages must not emit a version frontmatter field.

## Registry features

- The installed Nimbus Registry feature set is `pagefind-search`, `ai-native`, `404-page`, `mermaid`, and `lint-prose-textlint`.
- Pagefind indexes all 328 localized documentation pages.
- Agent surfaces, robots, sitemaps, canonical URLs, hreflang, Open Graph metadata, and JSON-LD are build outputs derived from the same published-page registry.
- The localized 404 is a terminal Site response. It must never fall through to Core or Hosted Auth.
- Author a Mermaid diagram only as a document AST CodeBlock with `kind: "code"` and `language: "mermaid"` in `src/content-source/docs/documents.json`. Never add a Mermaid fence directly to generated MDX.
- Mermaid labels must stay protocol or technical identifiers unless a localized message descriptor is added through Lingui.
- `pnpm run lint:prose` regenerates content and runs English prose rules only against the English root entries and `sdks` subtree. Do not run English prose rules against translated documents.
- Registry availability is not installed status. Do not describe `changelog`, `new-version`, `new-collection`, or another upstream recipe as enabled unless its implementation and verification land in this package.

## Agent surfaces

- Every published page emits localized downleveled Markdown at its `index.md` URL.
- Every published page emits generated raw authored MDX at its `index.mdx` URL.
- Each Markdown twin ends with an exact `Source:` link to its MDX twin.
- The root `https://xid.dev/llms.txt` enumerates every published locale page.
- The root `https://xid.dev/llms-full.txt` contains the complete deterministic corpus without timestamps.
- `https://xid.dev/en/llms.txt` and `https://xid.dev/en/llms-full.txt` isolate the 41 English pages. Other locale section endpoints use their lowercase locale segment.
- Legacy `https://xid.dev/docs` pages, twins, and English agent endpoints return a single 308 to the root canonical tree.
- The English SCIM document uses exact routes only. `https://xid.dev/scim/v2/*` remains a Core protocol surface.
- Static Markdown, MDX, and text agent surfaces use explicit UTF-8 Content-Type rules.

## Verification

- Run `pnpm --filter @xid-kit/site typecheck`.
- Run `pnpm --filter @xid-kit/site test`.
- Run `pnpm --filter @xid-kit/site build`.
- Run `pnpm --filter @xid-kit/site exec node scripts/audit-dist-routes.mjs`.
- Run `pnpm --filter @xid-kit/site exec nimbus-docs lint`.
- Run `pnpm --filter @xid-kit/site lint:prose`.

## Dependency hygiene

- The repository root `pnpm-lock.yaml` is the only lockfile.
- Do not generate `package-lock.json`, `yarn.lock`, `bun.lock`, or another package-manager lockfile in this package.
