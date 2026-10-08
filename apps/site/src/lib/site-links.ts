import rootPackage from '../../../../package.json'

const REPOSITORY = 'https://github.com/StringKe/xid'

export const SITE_REPOSITORY_URL = REPOSITORY
export const SITE_LICENSE_URL = `${REPOSITORY}/blob/main/LICENSE`
export const SITE_CHANGELOG_URL = `${REPOSITORY}/blob/main/CHANGELOG.md`
export const SITE_SUPPORT_STATUS_URL = `${REPOSITORY}/blob/main/docs/protocols/README.md`
export const SITE_SOURCE_MAP_URL = `${REPOSITORY}/blob/main/docs/protocols/source-map.md`
export const SITE_API_CONTRACTS_URL = `${REPOSITORY}/blob/main/docs/api-contracts.md`
export const SITE_SECURITY_URL = `${REPOSITORY}/blob/main/SECURITY.md`
// 文档页由 documents.json 生成，编辑入口指向这份源文件。
export const SITE_DOCS_SOURCE_URL = `${REPOSITORY}/blob/main/apps/site/src/content-source/docs/documents.json`

export const SITE_RELEASE_VERSION: string = rootPackage.version
// 版权声明是法律署名，各语言一致，不进翻译目录。
export const SITE_COPYRIGHT = '© 2026 StringKe'
