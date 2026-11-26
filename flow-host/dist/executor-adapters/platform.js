import { isRecord } from "ursi-flow-core/runtime";
export function parseExecutorRef(value) {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() || value.id !== value.id.trim() ||
        typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
        Object.keys(value).some(k => k !== "id" && k !== "revision"))
        throw Error("executorRef 需要 id 和正整数 revision");
    return { id: value.id, revision: value.revision };
}
export function platformConfig(env = process.env) {
    const raw = env.URSI_EXECUTOR_PLATFORM_URL;
    const url = raw && URL.canParse(raw) ? new URL(raw) : undefined;
    if (!url || !["https:", "http:"].includes(url.protocol) || url.href !== `${url.origin}/`)
        throw Error("URSI_EXECUTOR_PLATFORM_URL 必须是 HTTP(S) origin");
    const token = env.URSI_EXECUTOR_PLATFORM_TOKEN?.trim();
    if (!token || /\s/.test(token))
        throw Error("需要有效的 URSI_EXECUTOR_PLATFORM_TOKEN");
    return { origin: url.origin, token };
}
class HttpError extends Error {
    status;
    constructor(status) {
        super(`执行平台 HTTP ${status}`);
        this.status = status;
    }
}
export class PlatformClient {
    config;
    constructor(config) { this.config = config; }
    async request(path, method, body) {
        const response = await fetch(`${this.config.origin}/api/v2/${path}`, {
            method, redirect: "error", signal: AbortSignal.timeout(15_000),
            headers: { Authorization: `Bearer ${this.config.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new HttpError(response.status);
        }
        return response;
    }
    async checkNodeExecutor(ref) {
        if (ref.id === "." || ref.id === "..")
            throw Error("无效的执行器 ID");
        const value = await (await this.request(`node-executors/${encodeURIComponent(ref.id)}/${ref.revision}`, "GET")).json();
        if (!isRecord(value) || value.id !== ref.id || value.revision !== ref.revision)
            throw Error("平台未确认所选执行器修订");
    }
    /** 按执行器 id 解析当前最新发布修订并校验能力；名称不存在或修订缺 flowOutcome 能力时抛错。 */
    async resolveExecutor(id) {
        if (id === "." || id === "..")
            throw Error(`无效的执行器名称: ${id}`);
        let value;
        try {
            value = await (await this.request(`executors/${encodeURIComponent(id)}`, "GET")).json();
        }
        catch (e) {
            if (e instanceof HttpError && e.status === 404)
                throw Error(`平台没有执行器 ${id} 的任何发布修订`);
            throw e;
        }
        if (!isRecord(value) || value.id !== id || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1)
            throw Error(`平台未返回执行器 ${id} 的有效修订`);
        const ref = { id, revision: value.revision };
        await this.checkNodeExecutor(ref);
        return ref;
    }
    path(id) {
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))
            throw Error("无效的 attemptId");
        return `executor-attempts/${id}`;
    }
    async start(id, body) {
        try {
            await (await this.request(this.path(id), "PUT", body)).body?.cancel();
        }
        catch (e) {
            // 启动回执可能丢失。只用 GET 核对原 ID，不重发 PUT。
            if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408)
                throw e;
        }
    }
    async inspect(id) {
        try {
            const record = await (await this.request(this.path(id), "GET")).json();
            if (!isRecord(record) || record.attemptId !== id || typeof record.status !== "string" ||
                !["starting", "running", "unverified", "succeeded", "failed", "cancelled"].includes(record.status))
                throw Error();
            return { status: record.status, artifactDirectoryId: record.artifactDirectoryId };
        }
        catch (e) {
            throw new Error(`尝试 ${id} 状态待核实${e instanceof HttpError ? `：${e.message}` : ""}`);
        }
    }
    async cancel(id) {
        // 即使取消回执丢失，也以原尝试的查询状态为准。
        try {
            await (await this.request(`${this.path(id)}/cancel`, "POST")).body?.cancel();
        }
        catch { /* inspect below */ }
        return ["cancelled", "failed", "succeeded"].includes((await this.inspect(id)).status);
    }
    async outcome(directory) {
        if (typeof directory !== "string" || !directory || directory === "." || directory === "..")
            throw Error("成功尝试缺少有效的 artifactDirectoryId");
        const response = await this.request(`directories/${encodeURIComponent(directory)}/file?path=flow-outcome.json`, "GET");
        return await response.json();
    }
}
//# sourceMappingURL=platform.js.map