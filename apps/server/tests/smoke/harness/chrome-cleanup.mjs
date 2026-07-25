import { rm } from 'node:fs/promises'

const TERM_TIMEOUT_MS = 5000
const KILL_TIMEOUT_MS = 5000
const PROFILE_REMOVE_MAX_RETRIES = 20
const PROFILE_REMOVE_RETRY_DELAY_MS = 250

function waitForExit(chrome, timeoutMs) {
  if (chrome.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let complete = false
    const finish = (exited) => {
      if (complete) return
      complete = true
      clearTimeout(timeout)
      resolve(exited)
    }
    const timeout = setTimeout(() => finish(false), timeoutMs)
    chrome.once('exit', () => finish(true))
    if (chrome.exitCode !== null) finish(true)
  })
}

// Chrome 会 fork renderer / GPU / crashpad 子进程,它们各自持有 profile 目录的写句柄。
// 只对主进程发信号会留下这些孤儿继续写 Default/,随后 rm 撞 ENOTEMPTY 把已通过的用例判红。
// 调用方用 detached spawn 让主进程成为进程组 leader,这里按负 pid 对整个进程组发信号。
function killChromeTree(chrome, signal) {
  if (chrome.pid === undefined) {
    chrome.kill(signal)
    return
  }
  try {
    process.kill(-chrome.pid, signal)
  } catch (error) {
    // ESRCH:整组已退出,无需再杀。其余(Windows 无进程组语义 / EPERM)退回单进程 kill。
    if (error.code === 'ESRCH') return
    chrome.kill(signal)
  }
}

async function stopChrome(chrome) {
  if (chrome.exitCode !== null) return
  const exitedAfterTerm = waitForExit(chrome, TERM_TIMEOUT_MS)
  killChromeTree(chrome, 'SIGTERM')
  if (await exitedAfterTerm) return
  if (chrome.exitCode !== null) return
  const exitedAfterKill = waitForExit(chrome, KILL_TIMEOUT_MS)
  killChromeTree(chrome, 'SIGKILL')
  await exitedAfterKill
}

export async function closeChromeAndRemoveProfile(chrome, profileDir) {
  await stopChrome(chrome)
  try {
    await rm(profileDir, {
      recursive: true,
      force: true,
      maxRetries: PROFILE_REMOVE_MAX_RETRIES,
      retryDelay: PROFILE_REMOVE_RETRY_DELAY_MS,
    })
  } catch (error) {
    // profileDir 在 os.tmpdir() 下,泄漏几十 MB 临时文件的代价远小于让清理失败把通过的用例判红。
    // 这里是 withChrome 的 finally,throw 会覆盖掉真正的测试结果。
    process.stderr.write(`warn: chrome profile cleanup failed (${profileDir}): ${error.message}\n`)
  }
}
