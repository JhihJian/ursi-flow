// 模型清单（Vercel AI Gateway 的模型命名）。
// 见 https://vercel.com/ai-gateway/models。
export interface GatewayModel {
  id: string
  name: string
}

export const MODELS: GatewayModel[] = [
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'openai/gpt-5.6-terra', name: 'GPT 5.6 Terra' },
]

export const DEFAULT_MODEL = MODELS[0].id

export function isModelAllowed(id: string): boolean {
  return MODELS.some((model) => model.id === id)
}
