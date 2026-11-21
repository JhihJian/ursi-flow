import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并条件类名并消解 Tailwind 冲突，供共享控件透传 className。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
