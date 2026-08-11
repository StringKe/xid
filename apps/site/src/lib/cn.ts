import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** twMerge 合并 Tailwind 冲突类；后者（调用方）优先。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
