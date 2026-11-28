/** 拼类名：跳过假值。与各应用自己的 cx 同义，包内不依赖应用代码。 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
