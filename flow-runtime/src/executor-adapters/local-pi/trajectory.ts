// 节点会话轨迹：把一次 Agent 节点执行期间新增的 Pi 会话条目写成 JSONL 切片。
// 切片保留原始 id/parentId，第一行的会话头是合成值，仅供轨迹查看器解析，不能当可续接的 Pi 会话使用。
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** 会话管理器里录音需要的只读接口，便于测试注入。 */
export interface TrajectorySource {
	getEntries(): SessionEntry[];
}

export interface TrajectoryStart {
	/** 节点执行标识，同时是轨迹文件名。 */
	executionId: string;
	/** 会话所属工作目录，写进合成会话头。 */
	cwd?: string;
	/** 节点使用的模型标识，只用于显示。 */
	model?: string;
}

/** 合成头：一个节点执行对应一份会话切片。 */
export function trajectoryHeader(start: TrajectoryStart) {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: start.executionId,
		timestamp: new Date().toISOString(),
		cwd: start.cwd ?? process.cwd(),
		...(start.model ? { modelId: start.model } : {}),
	};
}

/**
 * 按节点执行切分会话：开始时记下条目偏移，之后把新增条目追加到
 * `<dir>/<executionId>.jsonl`。条目只追加不改写，重复 flush 不会重复写入。
 */
export class NodeTrajectoryRecorder {
	private readonly dir: string;
	private readonly file: string;
	private readonly source: TrajectorySource;
	private readonly header: ReturnType<typeof trajectoryHeader>;
	private written = 0;
	private queue: Promise<void> = Promise.resolve();
	private timer?: NodeJS.Timeout;

	constructor(options: {
		dir: string;
		source: TrajectorySource;
		start: TrajectoryStart;
	}) {
		this.dir = options.dir;
		this.file = join(this.dir, `${options.start.executionId}.jsonl`);
		this.source = options.source;
		this.header = trajectoryHeader(options.start);
	}

	/** 建立文件并写入会话头；此时不读取条目，节点结束前由 flush 增量补齐。 */
	async start(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		this.written = this.source.getEntries().length;
		await writeFile(this.file, `${JSON.stringify(this.header)}\n`, { mode: 0o600 });
		// 运行中的节点也能看到已完成的消息；会话条目只在内存里，不靠事件回调。
		this.timer = setInterval(() => void this.flush(), 1000);
		this.timer.unref?.();
	}

	flush(): Promise<void> {
		this.queue = this.queue
			.catch(() => undefined)
			.then(async () => {
				const entries = this.source.getEntries();
				if (entries.length <= this.written) return;
				const added = entries.slice(this.written);
				await appendFile(
					this.file,
					added.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
				);
				this.written = entries.length;
			})
			// 轨迹只是证据，写入失败不能影响节点执行。
			.catch((error) => console.error("无法写入节点会话轨迹", this.file, error));
		return this.queue;
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		await this.flush();
	}
}
