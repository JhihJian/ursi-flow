// Explicitly loaded into one Pi process per node visit.
export default function register(pi) {
  const { name, description, inputSchema } = JSON.parse(process.env.URSI_PI_TOOL);
  let submitted = false;
  pi.registerTool({ name, label: name, description, parameters: inputSchema,
    executionMode: 'sequential',
    async execute(_id, args) {
      if (submitted) throw new Error('当前节点已提交结果');
      submitted = true;
      return { content: [{ type: 'text', text: '已提交' }], details: { submission: args }, terminate: true };
    }
  });
}
