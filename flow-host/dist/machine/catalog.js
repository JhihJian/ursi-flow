import { cp, lstat, chmod, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile, } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseFlow } from "ursi-flow-core/runtime";
import { FlowSyntaxError } from "ursi-flow-core/runtime";
import { BusinessError, invalid } from "./errors.js";
function validId(value) {
    return typeof value === "string" && /^[A-Za-z0-9][\w-]{0,95}$/.test(value);
}
export function id(value) {
    if (!validId(value))
        throw invalid("非法标识");
    return value;
}
export async function readJson(file) {
    return JSON.parse(await readFile(file, "utf8"));
}
export async function save(file, value) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
        await rename(tmp, file);
    }
    finally {
        await rm(tmp, { force: true });
    }
}
export async function optional(op, fallback) {
    try {
        return await op;
    }
    catch (e) {
        if (e.code === "ENOENT")
            return fallback;
        throw e;
    }
}
export function checkFiles(files) {
    if (!files ||
        typeof files !== "object" ||
        Array.isArray(files) ||
        !Object.hasOwn(files, "FLOW.md"))
        throw invalid("需要包含 FLOW.md 的文件集合");
    for (const [path, text] of Object.entries(files)) {
        if (/^[A-Za-z]:|[\\\0]/.test(path) ||
            path.split("/").some((s) => !s || s === "." || s === "..") ||
            typeof text !== "string")
            throw invalid("非法包内文件");
        for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
            if (Object.hasOwn(files, path.slice(0, i)))
                throw invalid("包内文件与目录重名");
        }
    }
}
async function filesAt(dir, prefix = "") {
    const files = Object.create(null);
    for (const item of await readdir(join(dir, prefix), {
        withFileTypes: true,
    })) {
        const path = prefix + item.name;
        if (item.isDirectory())
            Object.assign(files, await filesAt(dir, path + "/"));
        else if (item.isFile())
            files[path] = await readFile(join(dir, path), "utf8");
        else
            throw Error("不接受非普通文件");
    }
    return files;
}
const FLOW_FORMAT_VERSION = "v1";
export class Catalog {
    home;
    constructor(home) {
        this.home = home;
    }
    published() {
        return join(this.home, "versions", FLOW_FORMAT_VERSION);
    }
    async current() {
        const target = await optional(readlink(this.published()), null);
        if (target === null) {
            if (await optional(lstat(join(this.home, "catalog.json")), null))
                throw Error("Flow 目录需要迁移到 versions/v1");
            return null;
        }
        const revision = target.split("/").at(-1);
        if (!validId(revision) || target !== `../.revisions/${revision}` ||
            !(await lstat(this.root(revision))).isDirectory())
            throw Error("已发布的 Flow 目录修订无效");
        return revision;
    }
    root(revision) {
        if (!validId(revision))
            throw Error("目录修订无效");
        return join(this.home, ".revisions", revision);
    }
    async publish(revision) {
        const versions = join(this.home, "versions");
        await mkdir(versions, { recursive: true });
        const pending = join(versions, `.${revision}.tmp`);
        await symlink(`../.revisions/${revision}`, pending);
        try {
            await rename(pending, this.published());
        }
        catch (e) {
            await rm(pending, { force: true });
            throw e;
        }
    }
    async list() {
        const v = await this.current();
        return v ? (await readdir(this.root(v))).sort() : [];
    }
    async get(name, expectedRevision) {
        id(name);
        const revision = await this.current();
        if (expectedRevision !== undefined && revision !== expectedRevision)
            throw new BusinessError("conflict", "目录修订冲突");
        if (!revision || !(await readdir(this.root(revision))).includes(name))
            throw new BusinessError("not_found", "Flow 不存在");
        return {
            id: name,
            revision,
            files: await filesAt(join(this.root(revision), name)),
        };
    }
    // Only the daemon's serialized request handler publishes catalog generations.
    async change(op, name, files, expected) {
        id(name);
        if (expected !== undefined && typeof expected !== "string")
            throw invalid("expectedRevision 必须是字符串");
        const prev = await this.current();
        if (expected !== undefined && expected !== prev)
            throw new BusinessError("conflict", "版本冲突");
        const next = randomUUID(), root = this.root(next), dir = join(root, name);
        try {
            await mkdir(join(this.home, ".revisions"), { recursive: true });
            if (prev)
                await cp(this.root(prev), root, { recursive: true });
            else
                await mkdir(root, { recursive: true });
            const exists = await optional(lstat(dir).then(() => true), false);
            if (op === "create" && exists)
                throw new BusinessError("conflict", "Flow 已存在");
            if ((op === "update" || op === "delete") && !exists)
                throw new BusinessError("not_found", "Flow 不存在");
            // flow-manifest 安装的包是只读的（目录 555、文件 444），重写前先整树恢复可写。
            await chmodTreeWritable(dir);
            await rm(dir, { recursive: true, force: true });
            if (op !== "delete") {
                checkFiles(files);
                for (const [path, text] of Object.entries(files)) {
                    const target = join(dir, path);
                    try {
                        await mkdir(join(target, ".."), { recursive: true });
                        await writeFile(target, text);
                    }
                    catch (e) {
                        if (e.code === "ENAMETOOLONG")
                            throw invalid("包内路径过长");
                        throw e;
                    }
                }
            }
            for (const entry of await readdir(root)) {
                try {
                    parseFlow(await readFile(join(root, entry, "FLOW.md"), "utf8"), entry);
                }
                catch (e) {
                    // Only package validation in the staged generation is caller input.
                    if (!(e instanceof Error) || "errno" in e ||
                        (e.constructor !== Error && !(e instanceof FlowSyntaxError)))
                        throw e;
                    if (entry !== name) {
                        // 预存在的坏包（例如其他宿主以版本化布局安装的包）不阻塞本次修改，
                        // 只在日志里说明；运行到它时自然报错。
                        console.error(`忽略无法解析的既有包 ${entry}: ${e.message}`);
                        continue;
                    }
                    throw invalid(e.message);
                }
            }
            if (op === "validate") {
                await rm(root, { recursive: true, force: true });
                return { id: name, valid: true };
            }
            await this.publish(next);
            return { id: name, revision: next };
        }
        catch (e) {
            // 失败清理同样要恢复可写，否则只读包会让暂存目录删不掉。
            await chmodTreeWritable(root).catch(() => { });
            await rm(root, { recursive: true, force: true });
            throw e;
        }
    }
}
/** 把目录树整体恢复为属主可写：只读安装包（555/444）也要能被后续修订覆盖。 */
async function chmodTreeWritable(dir) {
    const entries = await readdir(dir).catch(() => []);
    for (const entry of entries) {
        const target = join(dir, entry);
        const st = await lstat(target);
        if (st.isDirectory())
            await chmodTreeWritable(target);
    }
    await chmod(dir, 0o700).catch(() => { });
    for (const entry of entries) {
        const target = join(dir, entry);
        const st = await lstat(target).catch(() => null);
        if (st?.isFile())
            await chmod(target, 0o600).catch(() => { });
    }
}
//# sourceMappingURL=catalog.js.map