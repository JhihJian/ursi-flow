import { closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ExecutorError, type ExecutorStatus } from "ursi-executor-sdk";
import { privateFile } from "./files.ts";

export const CAPACITY = 8;
const START_WINDOW_MS = 15_000;
type Final = Exclude<ExecutorStatus, "running">;
interface Row {
	id: string; binding: string; digest: string; inputHash: string; instruction: string;
	phase: "reserved" | "running" | Final; expires: number; owner: string; pid: number; cancel: number;
}

// Linux start ticks and boot ID distinguish PID reuse, including across host restarts.
// No signal is ever sent to this PID.
function processIdentity(pid: number) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (fields[0] === "Z" || fields[0] === "X") return null;
		if (!/^\d+$/.test(fields[19])) throw new ExecutorError("unavailable");
		return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`;
	} catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

export function withLedger<T>(root: string, action: (l: Ledger) => T) {
	const path = join(root, ".pi-jobs.sqlite");
	closeSync(privateFile(path, "ledger"));
	const db = new DatabaseSync(path);
	try {
		db.exec(`PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL;
			CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, binding TEXT NOT NULL, digest TEXT NOT NULL,
			inputHash TEXT NOT NULL, instruction TEXT NOT NULL, phase TEXT NOT NULL, expires INTEGER NOT NULL,
			pid INTEGER NOT NULL DEFAULT 0, owner TEXT NOT NULL DEFAULT '', cancel INTEGER NOT NULL DEFAULT 0);
			CREATE INDEX IF NOT EXISTS jobs_phase ON jobs(phase); BEGIN IMMEDIATE;`);
		const result = action(new Ledger(db));
		db.exec("COMMIT");
		return result;
	} catch (error) {
		if ((error as { errcode?: number }).errcode === 5) throw new ExecutorError("busy");
		throw error;
	} finally { db.close(); }
}

class Ledger {
	private db: DatabaseSync;
	constructor(db: DatabaseSync) { this.db = db; }
	get(id: string) { return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as Row | undefined; }
	current(id: string, binding: string) {
		const row = this.get(id);
		if (!row) throw new ExecutorError("not_found");
		if (row.binding !== binding) throw new ExecutorError("conflict");
		return this.reconcile(row);
	}
	private reconcile(row: Row) {
		if ((row.phase === "reserved" && Date.now() >= row.expires) ||
			(row.phase === "running" && processIdentity(row.pid) !== row.owner)) {
			this.finish(row.id, "unverified");
			row.phase = "unverified";
		}
		return row;
	}
	reserve(id: string, binding: string, digest: string, inputHash: string, instruction: string) {
		const active = this.db.prepare("SELECT * FROM jobs WHERE phase IN ('reserved','running')").all() as unknown as Row[];
		if (active.map(row => this.reconcile(row)).filter(row => row.phase !== "unverified").length >= CAPACITY) throw new ExecutorError("busy");
		this.db.prepare("INSERT INTO jobs(id,binding,digest,inputHash,instruction,phase,expires) VALUES(?,?,?,?,?,'reserved',?)")
			.run(id, binding, digest, inputHash, JSON.stringify(instruction), Date.now() + START_WINDOW_MS);
	}
	claim(id: string, binding: string) {
		const row = this.current(id, binding);
		if (row.phase !== "reserved") return;
		if (row.cancel) { this.finish(id, "cancelled"); return; }
		const owner = processIdentity(process.pid);
		if (!owner) throw new ExecutorError("unavailable");
		this.db.prepare("UPDATE jobs SET phase='running',pid=?,owner=? WHERE id=?").run(process.pid, owner, id);
		// JSON preserves embedded NULs and any escaped surrogate in the original frame.
		const instruction: unknown = JSON.parse(row.instruction);
		if (typeof instruction !== "string") throw new ExecutorError("unavailable");
		return { ...row, instruction };
	}
	cancel(id: string) { this.db.prepare("UPDATE jobs SET cancel=1 WHERE id=? AND phase IN ('running','reserved')").run(id); }
	cancelRequested(id: string) { return this.db.prepare("SELECT cancel FROM jobs WHERE id=?").get(id)?.cancel === 1; }
	finish(id: string, phase: Final) {
		this.db.prepare("UPDATE jobs SET phase=?,instruction='' WHERE id=? AND phase IN ('reserved','running')").run(phase, id);
	}
}
export function status(row: Row): ExecutorStatus { return row.phase === "reserved" ? "running" : row.phase; }
