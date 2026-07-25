export const POLL_INTERVAL_MS = 250
export const POLL_TIMEOUT_MS = 15_000

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function pollUntil(action, options) {
  const isReady = options.isReady
  const clock = options.clock ?? Date
  const sleep = options.sleep ?? delay
  const startedAt = clock.now()

  while (true) {
    const value = await action()
    if (isReady(value)) return value

    if (clock.now() - startedAt >= POLL_TIMEOUT_MS) {
      throw new Error(`${options.label} timed out after ${POLL_TIMEOUT_MS}ms`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
}
