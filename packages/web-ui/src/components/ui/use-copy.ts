import { useCallback, useEffect, useRef, useState } from 'react'

export const COPY_FEEDBACK_MS = 2000

export type CopyStatus = 'idle' | 'copied' | 'failed'

// 复制结果短暂显示后回到 idle;剪贴板被拒绝时返回 failed,由调用方提示手动选择。
export function useCopyToClipboard(): {
  status: CopyStatus
  copy: (value: string) => Promise<void>
} {
  const [status, setStatus] = useState<CopyStatus>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback(async (value: string): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    try {
      await globalThis.navigator.clipboard.writeText(value)
      setStatus('copied')
    } catch (error) {
      console.error('Clipboard write failed', error)
      setStatus('failed')
    }
    timer.current = setTimeout(() => setStatus('idle'), COPY_FEEDBACK_MS)
  }, [])

  return { status, copy }
}
