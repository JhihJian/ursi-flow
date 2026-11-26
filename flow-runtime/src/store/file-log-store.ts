import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	LogEvent,
	LogStore,
	RunHeader,
	RunSnapshot,
	StoredRun,
} from "../logs/index.ts";

const RUN_ID = /^[A-Za-z0-9][\w-]{0,95}$/;

/**
 * 每条运行一个目录：
 *   runs/<runId>/run.json      运行头，写一次
 *   runs/<runId>/snapshot.json 可恢复快照，原子替换
 *   runs/<runId>/events.jsonl  过程事件，追加写
 */
export class FileLogStore implements LogStore {
	readonly root: string;
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(root: string) {
		this.root = join(root, "runs");
	}

	private dir(runId: string) {
		if (!RUN_ID.test(runId)) throw new Error(`非法 Run ID: ${runId}`);
		return join(this.root, runId);
	}

	/** 同一运行的写操作串行执行，避免同名临时文件互相覆盖。 */
	private serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(runId) ?? Promise.resolve();
		const next = previous.then(operation, operation);
		this.queues.set(
			runId,
			next.catch(() => undefined),
		);
		return next;
	}

	async create(header: RunHeader): Promise<void> {
		const dir = this.dir(header.runId);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(join(dir, "run.json"), JSON.stringify(header), {
			flag: "wx",
			mode: 0o600,
		});
	}

	append(runId: string, event: LogEvent): Promise<void> {
		const file = join(this.dir(runId), "events.jsonl");
		return this.serialize(runId, () =>
			appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 }),
		);
	}

	saveSnapshot(runId: string, snapshot: RunSnapshot): Promise<void> {
		const file = join(this.dir(runId), "snapshot.json");
		return this.serialize(runId, async () => {
			const temporary = `${file}.${process.pid}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
				await rename(temporary, file);
			} finally {
				await rm(temporary, { force: true }).catch(() => undefined);
			}
		});
	}

	async load(runId: string): Promise<StoredRun | undefined> {
		const dir = this.dir(runId);
		const header = await this.read<RunHeader>(join(dir, "run.json"));
		if (!header) return undefined;
		const snapshot = await this.read<RunSnapshot>(join(dir, "snapshot.json"));
		if (!snapshot) throw new Error(`运行缺少快照: ${runId}`);
		const raw = (await this.readText(join(dir, "events.jsonl"))) ?? "";
		const events = raw
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as LogEvent);
		return { header, snapshot, events };
	}

	private async read<T>(file: string): Promise<T | undefined> {
		const text = await this.readText(file);
		return text === undefined ? undefined : (JSON.parse(text) as T);
	}

	private async readText(file: string): Promise<string | undefined> {
		try {
			return await readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
}
