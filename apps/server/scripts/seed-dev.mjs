// 本地 dev seed:对运行中的 dev server(默认 http://localhost:5173)POST /admin/bootstrap,
// 从空 D1 初始化第一个租户(single_tenant + primaryDomain=localhost),让 tenant 解析成功、
// /v1/* 与 /auth/* 不再因无 instance 而 404/500。幂等:已初始化返回 409,脚本视为成功。
//
// 前置:先 `pnpm db:migrate:local` 把迁移应用到本地 miniflare D1,再 `pnpm dev` 起服务,最后跑本脚本。
// 用法:node scripts/seed-dev.mjs [baseUrl]

const baseUrl = process.argv[2] ?? process.env.XID_DEV_URL ?? 'http://localhost:5173'

const body = {
  instanceName: 'XID Dev',
  primaryDomain: 'localhost',
  mode: 'single_tenant',
  adminEmail: 'admin@localhost',
}

const res = await fetch(`${baseUrl}/admin/bootstrap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const text = await res.text()

if (res.status === 201) {
  process.stdout.write(`seeded: ${text}\n`)
} else if (res.status === 409) {
  process.stdout.write(`already initialized (idempotent): ${text}\n`)
} else {
  console.error(`bootstrap failed status=${res.status}:`, text)
  console.error('hint: run `pnpm db:migrate:local` then `pnpm dev` before seeding.')
  process.exit(1)
}
