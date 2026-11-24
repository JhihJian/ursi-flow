import * as React from 'react'
import { useChat } from '@ai-sdk/react'
import { lastAssistantMessageIsCompleteWithToolCalls } from 'ai'

import { type AskUserToolPart, type ChatUIMessage } from '@/api/types'
import { type GatewayModel } from '@/lib/models'
import { ChatMessage } from '@/components/chat-message'
import { PromptForm } from '@/components/prompt-form'
import { QuestionCard } from '@/components/question-card'
import { StatusIcon } from '@/components/status-icon'
import { Suggestions } from '@/components/suggestions'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import { Message, MessageContent } from '@/components/ui/message'
import { Trace, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'

export function Chat({ models }: { models: GatewayModel[] }) {
  const [model, setModel] = React.useState(models[0]?.id ?? '')
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const {
    messages,
    sendMessage,
    regenerate,
    status,
    stop,
    error,
    addToolOutput,
  } = useChat<ChatUIMessage>({
    // 用户回答 ask_user 问卷后自动续跑。
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  })

  const resolvedModel = models.some((m) => m.id === model)
    ? model
    : (models[0]?.id ?? '')

  const isBusy = status === 'submitted' || status === 'streaming'

  const lastMessage = messages.at(-1)
  const pendingQuestion =
    lastMessage?.role === 'assistant'
      ? lastMessage.parts.find(
          (part): part is AskUserToolPart =>
            part.type === 'tool-ask_user' &&
            (part.state === 'input-streaming' ||
              part.state === 'input-available'),
        )
      : undefined

  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight })
  }, [messages, status])

  return (
    <div className="chat">
      {messages.length === 0 ? (
        <div className="chat-empty">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>What can I help with?</EmptyTitle>
              <EmptyDescription>
                Pick a model and start chatting. Responses stream through the
                Vercel AI Gateway.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Suggestions
                onSelect={(prompt) =>
                  sendMessage(
                    { text: prompt },
                    { body: { model: resolvedModel } },
                  )
                }
              />
            </EmptyContent>
          </Empty>
        </div>
      ) : (
        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-messages">
            {messages.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                isStreaming={isBusy && message.id === lastMessage?.id}
                onRetry={
                  !isBusy && message.id === lastMessage?.id
                    ? () =>
                        regenerate({
                          messageId: message.id,
                          body: { model: resolvedModel },
                        })
                    : undefined
                }
              />
            ))}
            {status === 'submitted' && (
              <Message align="start">
                <MessageContent>
                  <Trace>
                    <TraceLine status="running">
                      <TraceIcon>
                        <StatusIcon status="running" />
                      </TraceIcon>
                      <TraceTitle>Thinking</TraceTitle>
                    </TraceLine>
                  </Trace>
                </MessageContent>
              </Message>
            )}
          </div>
        </div>
      )}

      <div className="chat-composer">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Request failed</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        <PromptForm
          models={models}
          model={resolvedModel}
          onModelChange={setModel}
          isBusy={isBusy}
          onSubmit={(text) =>
            sendMessage({ text }, { body: { model: resolvedModel } })
          }
          onStop={() => stop()}
        />
      </div>

      {pendingQuestion && (
        <QuestionCard
          part={pendingQuestion}
          onAnswer={(toolCallId, answer) =>
            addToolOutput({
              tool: 'ask_user',
              toolCallId,
              output: answer,
              options: { body: { model: resolvedModel } },
            })
          }
        />
      )}
    </div>
  )
}
