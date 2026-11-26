import type { Instruct } from "ursi-flow-runtime";
/**
 * Agent 提示词 = Flow 正文 + 可选结果与变量提示 + 固定提交指令。
 * 引擎只传渲染好的正文，结果说明来自 Flow 定义。
 */
export declare function renderAgentPrompt(instruct: Instruct): string;
//# sourceMappingURL=prompt.d.ts.map