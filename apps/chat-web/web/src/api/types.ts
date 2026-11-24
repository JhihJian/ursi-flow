import type { UIDataTypes, UIMessage } from 'ai'

// 与 server/src/tools 对齐的 UI 工具类型（消息 part 的 input/output 形状）。
// 客户端只关心渲染形状，不需要服务端的执行实现。

export interface GithubRepoStats {
  repo: string
  description: string
  stars: number
  forks: number
  openIssues: number
  language: string
  url: string
}

export interface GithubRepoError {
  error: string
}

export interface AskUserQuestion {
  question: string
  choices: string[]
}

export interface AskUserAnswer {
  question: string
  answer: string
}

export type ChatTools = {
  github_repo: {
    input: { repo?: string }
    output: GithubRepoError | GithubRepoStats
  }
  ask_user: {
    input: { questions: AskUserQuestion[] }
    output: AskUserAnswer[]
  }
  web_search: {
    input: { query?: string }
    output: unknown
  }
}

export type ChatUIMessage = UIMessage<
  { reasoningDurations?: Record<number, number> },
  UIDataTypes,
  ChatTools
>

export type ChatMessagePart = ChatUIMessage['parts'][number]

export type TextMessagePart = Extract<ChatMessagePart, { type: 'text' }>

export type ReasoningMessagePart = Extract<ChatMessagePart, { type: 'reasoning' }>

export type SourceUrlPart = Extract<ChatMessagePart, { type: 'source-url' }>

export type GithubRepoToolPart = Extract<ChatMessagePart, { type: 'tool-github_repo' }>

export type AskUserToolPart = Extract<ChatMessagePart, { type: 'tool-ask_user' }>

export type WebSearchToolPart = Extract<ChatMessagePart, { type: 'tool-web_search' }>
