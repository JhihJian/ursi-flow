
export interface ChatTextPart { type: 'text'; text: string }
export interface ChatReasoningPart { type: 'reasoning'; text: string }
export interface ChatToolPart { type: 'tool'; name: string; status: 'running' | 'succeeded' | 'failed'; output?: string }
export type ChatPart = ChatTextPart | ChatReasoningPart | ChatToolPart
export interface ChatMessage { id: string; role: 'user' | 'assistant'; at: string; parts: ChatPart[] }
export interface ChatSession { id: string; title: string; createdAt: string; updatedAt: string; messages: ChatMessage[] }
