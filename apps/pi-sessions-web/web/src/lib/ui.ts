/** className 拼接：丢掉假值，避免出现多余空格。 */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
