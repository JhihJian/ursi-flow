# AI Elements 来源

本目录改编自 [Vercel AI Elements](https://github.com/vercel/ai-elements) 的注册表快照。授权条款见 [Apache-2.0](./LICENSE)，上游版权声明见 [NOTICE](./NOTICE)。

| 注册表快照 | JSON SHA-256 | 提取的 TSX SHA-256 |
| --- | --- | --- |
| [conversation.json](https://registry.ai-sdk.dev/conversation.json) | `fcc21c5eb607834ea4e41dc96f9ea7ae1bec71b141a77c1d08e8712c072ac045` | `ea2d55826343fda8a5c2e8f0bff71bf3a07fa2e2f60b5d14a475503bf978ac22` |
| [message.json](https://registry.ai-sdk.dev/message.json) | `c6841b8ec7dd7971398d2302be91c9d2581e274460e6772e2fb738fcab7742ba` | `5c9d51ebeb1e63682efd44cef10c45f45dace89620d31335226d392690b50d65` |
| [prompt-input.json](https://registry.ai-sdk.dev/prompt-input.json) | `bf6784d304a1be96d16baed22e3c259441363c0a5dd51fd03f948d8161e111d1` | `b8ff0d6e154aac8300efc0ef88ffa2efb07235ab217138344b69baa93b347da4` |

TSX 快照来自 JSON 的 `files[0].content`，末尾补一个换行。[上游 LICENSE](https://github.com/vercel/ai-elements/blob/main/LICENSE) 的 SHA-256 为 `b4f9adb7c568904834d0dd6cc98d16c390d21ca32fc17ae7a267715269bd5529`，原文保留于 `NOTICE`。

## 本地改编

- `conversation.tsx` 保留 `use-stick-to-bottom` 的滚动行为，用共享主题实现对话区和空状态。
- `message.tsx` 保留提问与回复的布局。`MessageResponse` 用白名单渲染 CommonMark，链接仅显示文字，图片和原始 HTML 不进入 DOM。
- `prompt-input.tsx` 使用原生表单、文本域和共享按钮。Enter 通过 `requestSubmit` 提交，Shift+Enter 换行，输入法组字不触发提交。
