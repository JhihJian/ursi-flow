// Independent backend used by the stdio contract test. SQLite survives stdio EOF.
import { DatabaseSync } from 'node:sqlite';
import { serveExecutor, ExecutorError } from 'ursi-executor-sdk';
const db = new DatabaseSync(process.env.REPORT_DB);
db.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, instruction TEXT, format TEXT, status TEXT)');
function inspect({attemptId}) {
  const job = db.prepare('SELECT status FROM jobs WHERE id=?').get(attemptId);
  if (!job) throw new ExecutorError('not_found');
  return { attemptId, artifactDirectoryRef: `artifacts:${attemptId}`, status: job.status };
}
await serveExecutor({
  name: 'report', version: '1.2.3',
  runConfigSchema: { type: 'object', additionalProperties: false, properties: { format: { enum: ['text', 'markdown'] } } },
  start(req) {
    const format = req.runConfig?.format ?? 'text';
    db.prepare("INSERT OR IGNORE INTO jobs VALUES (?, ?, ?, 'running')").run(req.attemptId, req.workInstruction, format);
    const saved = db.prepare('SELECT instruction, format FROM jobs WHERE id=?').get(req.attemptId);
    if (saved.instruction !== req.workInstruction || saved.format !== format) throw new ExecutorError('conflict');
    return inspect(req);
  },
  inspect,
  cancel(req) {
    db.prepare("UPDATE jobs SET status='cancelled' WHERE id=? AND status='running'").run(req.attemptId);
    return inspect(req);
  },
});
