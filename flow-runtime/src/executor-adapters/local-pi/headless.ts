import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AgentOpenRequest, AgentHarnessExtensions } from '../../core/contracts/extensions.ts';
import type { AgentHandle, FlowAgentHarness, RuntimeToolBridge } from '../../core/contracts/types.ts';

const extension = fileURLToPath(new URL('./outcome.mjs', import.meta.url));
/** 可执行文件按 参数 > URSI_FLOW_PI > PATH 里的 pi 依次确定，便于守护进程部署。 */
function piExecutable(configured?: string): string {
  return configured ?? process.env.URSI_FLOW_PI ?? 'pi';
}
/** 取 stderr 末尾几行作为失败原因，警告行不进入摘要。 */
function stderrTail(stderr: string): string {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Warning:'))
    .slice(-3)
    .join(' ')
    .slice(0, 400);
}
export class HeadlessPi implements FlowAgentHarness {
  private readonly sessions = new Map<string, { bridge: RuntimeToolBridge; cwd?: string; started: boolean }>();
  constructor(privateOptions: { executable?: string; model?: string } = {}) { this.options = privateOptions; }
  private readonly options: { executable?: string; model?: string };
  private session(agent: AgentHandle) {
    const session = this.sessions.get(agent.id);
    if (!session) throw new Error('Pi 会话未绑定');
    return session;
  }
  readonly extensions: AgentHarnessExtensions = { continuity: {
    rebind: async (agent, bridge) => { this.session(agent).bridge = bridge; },
    restore: async () => { throw new Error('暂不支持跨进程接管 Pi 会话'); },
    preflight: () => { throw new Error('暂不支持接管已有 Pi 会话'); },
  } };
  async open(request: AgentOpenRequest) {
    const id = randomUUID();
    this.sessions.set(id, { bridge: request.runtimeTools, cwd: request.cwd, started: false });
    return { id, platformReference: id, sessionReference: id };
  }
  async run(agent: AgentHandle, request: { executionId: string; prompt: string }) {
    const state = this.session(agent);
    const args = ['--mode', 'json', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files',
      '--no-prompt-templates', '--extension', extension, '--tools', 'submit_flow_outcome',
      state.started ? '--session' : '--session-id', agent.id];
    if (this.options.model) args.push('--model', this.options.model);
    const executable = piExecutable(this.options.executable);
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = execFile(executable, args, { cwd: state.cwd, encoding: 'utf8',
        timeout: 180000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, URSI_PI_TOOL: JSON.stringify(state.bridge.definitions[0]) },
      }, (err, out, stderr) => {
        if (!err) return resolve(out);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          return reject(new Error(`找不到 Pi 可执行文件 ${executable}：把 pi 加入 PATH，或用 URSI_FLOW_PI 指定完整路径`));
        // Pi 的失败原因只在 stderr 里，例如模型没有凭据，必须带回给调用方。
        const reason = stderrTail(stderr);
        reject(new Error(`Pi 未正常退出 (${err.code ?? err.signal})${reason ? `：${reason}` : ''}`));
      });
      proc.stdin?.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') reject(err); });
      proc.stdin?.end(request.prompt);
    });
    let session = false, settled = false;
    for (const line of stdout.trimEnd().split('\n')) {
      if (!line.trim()) continue;
      let event: Record<string, any>;
      try {
        event = JSON.parse(line);
      } catch {
        // 非 JSON 行只能来自 Pi 的附带输出，不影响事件流解析。
        continue;
      }
      if (event.type === 'session') {
        if (session || event.id !== agent.id) throw new Error('Pi 会话标识不匹配');
        session = true;
      }
      if (event.type === 'agent_settled') settled = event.aborted === false;
      if (event.type === 'tool_execution_end' && event.toolName === 'submit_flow_outcome' && event.isError === false) {
        if (!session || settled) throw new Error('Pi 结果不属于当前执行');
        await state.bridge.invoke({ toolName: event.toolName, arguments: event.result?.details?.submission });
      }
    }
    if (!session || !settled) throw new Error('Pi 未确认本次执行结束');
    state.started = true;
    return { status: 'completed' as const, session: { id: request.executionId, sessionReference: agent.id } };
  }
  async close(agent: AgentHandle) { this.sessions.delete(agent.id); }
}
