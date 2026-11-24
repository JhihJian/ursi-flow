import * as React from 'react'

import { type AskUserToolPart } from '@/api/types'

export function QuestionCard({
  part,
  onAnswer,
}: {
  part: AskUserToolPart
  onAnswer: (
    toolCallId: string,
    answers: { question: string; answer: string }[],
  ) => void
}) {
  const questions = part.state === 'input-available' ? part.input.questions : []
  // 每个问题：选择的选项 + 自定义输入，提交时自定义优先。
  const [selected, setSelected] = React.useState<Record<string, string>>({})
  const [custom, setCustom] = React.useState<Record<string, string>>({})

  const keyFor = (index: number) => `q${index}`

  return (
    <div className="question-card">
      <div className="question-card-inner">
        {questions.length === 0 ? (
          <div className="question-card-loading">Preparing a question…</div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              onAnswer(
                part.toolCallId,
                questions.map((question, index) => {
                  const key = keyFor(index)
                  const answer = custom[key]?.trim()
                    ? custom[key]
                    : (selected[key] ?? '')
                  return { question: question.question, answer }
                }),
              )
            }}
          >
            {questions.map((question, index) => {
              const key = keyFor(index)
              const hasCustom = Boolean(custom[key]?.trim())
              return (
                <div key={index} className="question-item">
                  <div className="question-title">{question.question}</div>
                  <div className="question-choices">
                    {question.choices.map((choice) => (
                      <label
                        key={choice}
                        className={`question-choice${
                          !hasCustom && selected[key] === choice
                            ? ' is-selected'
                            : ''
                        }`}
                      >
                        <input
                          type="radio"
                          name={key}
                          value={choice}
                          checked={!hasCustom && selected[key] === choice}
                          onChange={() =>
                            setSelected((prev) => ({
                              ...prev,
                              [key]: choice,
                            }))
                          }
                        />
                        {choice}
                      </label>
                    ))}
                    <input
                      className="question-input"
                      aria-label="Another answer"
                      placeholder="Type another answer…"
                      value={custom[key] ?? ''}
                      onChange={(event) =>
                        setCustom((prev) => ({
                          ...prev,
                          [key]: event.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
              )
            })}
            <div className="question-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={questions.some((_, index) => {
                  const key = keyFor(index)
                  return !custom[key]?.trim() && !selected[key]
                })}
              >
                Answer
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
