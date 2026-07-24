import { spawnSync } from 'node:child_process'

const WARNING_BUDGET = 0
const result = spawnSync('pnpm', ['exec', 'vp', 'check'], {
  encoding: 'utf8',
  shell: false,
})
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
process.stdout.write(output)

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

const match = output.match(/Found \d+ errors and (\d+) warnings/u)
const warningCount = match ? Number(match[1]) : output.includes('Found no warnings') ? 0 : null
if (warningCount === null) throw new Error('lint warning summary is missing')
const summary = `[lint-warning-budget] baseline=${WARNING_BUDGET} observed=${warningCount}`
process.stdout.write(`${summary}\n`)
if (warningCount > WARNING_BUDGET) {
  throw new Error(`lint warning budget exceeded: ${warningCount} > ${WARNING_BUDGET}`)
}
