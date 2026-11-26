import { type SessionEntry } from "@earendil-works/pi-coding-agent";
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
export declare function trajectoryHeader(start: TrajectoryStart): {
    modelId?: string | undefined;
    type: string;
    version: number;
    id: string;
    timestamp: string;
    cwd: string;
};
/**
 * 按节点执行切分会话：开始时记下条目偏移，之后把新增条目追加到
 * `<dir>/<executionId>.jsonl`。条目只追加不改写，重复 flush 不会重复写入。
 */
export declare class NodeTrajectoryRecorder {
    private readonly dir;
    private readonly file;
    private readonly source;
    private readonly header;
    private written;
    private queue;
    private timer?;
    constructor(options: {
        dir: string;
        source: TrajectorySource;
        start: TrajectoryStart;
    });
    /** 建立文件并写入会话头；此时不读取条目，节点结束前由 flush 增量补齐。 */
    start(): Promise<void>;
    flush(): Promise<void>;
    stop(): Promise<void>;
}
//# sourceMappingURL=trajectory.d.ts.map