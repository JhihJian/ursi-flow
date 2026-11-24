// 模型清单（与服务端 models.ts 保持一致），用于模型选择器。
export interface GatewayModel {
  id: string
  name: string
}

export const MODELS: GatewayModel[] = [
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'openai/gpt-5.6-terra', name: 'GPT 5.6 Terra' },
]
