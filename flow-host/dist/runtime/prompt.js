/**
 * Agent 提示词 = Flow 正文 + 可选结果与变量提示 + 固定提交指令。
 * 引擎只传渲染好的正文，结果说明来自 Flow 定义。
 */
export function renderAgentPrompt(instruct) {
    const outcomes = instruct.outcomes
        .map((option) => {
        const variables = Object.keys(option.variables);
        const hint = variables.length
            ? `；variables 顶层允许：${variables.join(", ")}，复杂结果放在对应对象中`
            : "";
        return `- ${option.name}: ${option.description}${hint}`;
    })
        .join("\n");
    const rejected = instruct.rejection
        ? `\n\n上一次提交被拒绝：${instruct.rejection}`
        : "";
    return `${instruct.text}\n\n本节点只允许提交以下一个结果：\n${outcomes}${rejected}\n\n完成工作后必须调用 submit_flow_outcome，并提供 outcome，可选提供 variables。`;
}
//# sourceMappingURL=prompt.js.map