import { type InferUITools, type UIDataTypes, type UIMessage } from 'ai'

import { askUser } from './ask_user.ts'
import { githubRepo } from './github_repo.ts'
import { getWebSearch } from './web_search.ts'

const baseTools = {
  github_repo: githubRepo,
  ask_user: askUser,
}

export function getTools(modelId: string) {
  const webSearch = getWebSearch(modelId)
  return webSearch ? { ...baseTools, web_search: webSearch } : baseTools
}

export type ChatUIMessage = UIMessage<
  {
    // 每个 reasoning part 的耗时（毫秒），以它在消息里的序号为键。
    reasoningDurations?: Record<number, number>
  },
  UIDataTypes,
  InferUITools<typeof baseTools> & {
    web_search: {
      input: { query?: string }
      output: unknown
    }
  }
>

export type ChatMessagePart = ChatUIMessage['parts'][number]

export type TextMessagePart = Extract<ChatMessagePart, { type: 'text' }>

export type ReasoningMessagePart = Extract<ChatMessagePart, { type: 'reasoning' }>

export type SourceUrlPart = Extract<ChatMessagePart, { type: 'source-url' }>

export type GithubRepoToolPart = Extract<ChatMessagePart, { type: 'tool-github_repo' }>

export type AskUserToolPart = Extract<ChatMessagePart, { type: 'tool-ask_user' }>

export type WebSearchToolPart = Extract<ChatMessagePart, { type: 'tool-web_search' }>
