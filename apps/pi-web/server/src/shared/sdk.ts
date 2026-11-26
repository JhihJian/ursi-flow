import { HomeError } from './pi-home.ts'

/**
 * pi SDK 的按需加载。
 *
 * 配置管理功能不依赖 SDK：只有需要「真实模型目录」和「执行一次性会话」时才 import。
 * 模块本身零依赖，SDK 缺失时抛 503 而不是让整个服务起不来。
 */

export const SDK_PACKAGE = '@earendil-works/pi-coding-agent'

export type Sdk = typeof import('@earendil-works/pi-coding-agent')

let sdkPromise: Promise<Sdk> | null = null

export function loadSdk(): Promise<Sdk> {
  if (!sdkPromise) {
    sdkPromise = import(SDK_PACKAGE).catch((error: unknown) => {
      sdkPromise = null
      throw new HomeError(
        `该功能需要 pi SDK（${SDK_PACKAGE}）：${error instanceof Error ? error.message : String(error)}`,
        503,
        'sdk_unavailable',
      )
    })
  }
  return sdkPromise
}
