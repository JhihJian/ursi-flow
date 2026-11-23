import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acpEnvironment } from '../src/pi-executor/files.ts';

const config = { systemPrompt: 'fixed', modelProfile: 'managed', skills: [{ id: 's', revision: 1, content: 'context' }], tools: [] };

async function fixture(attemptId: string = randomUUID()) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'pi-acp-files-'));
  const root = join(dir, 'root');
  const attempt = join(root, attemptId);
  const cwd = join(attempt, 'workspace');
  const job = join(attempt, 'job.json');
  const snapshot = join(attempt, 'agent-config.json');
  const policy = join(dir, 'policy.json');
  const inputs = join(cwd, 'inputs');
  const env = { URSI_EXECUTOR_ROOT: root, URSI_PI_POLICY: policy, URSI_ACP_JOB: job };

  async function writeConfig(data: unknown, extraJob: Record<string, unknown> = {}) {
    const text = JSON.stringify(data);
    await rm(snapshot, { force: true });
    await rm(job, { force: true });
    await writeFile(snapshot, text, { mode: 0o400 });
    const configDigest = createHash('sha256').update(text).digest('hex');
    await writeFile(job, JSON.stringify({ cwd, configDigest, ...extraJob }), { mode: 0o400 });
  }

  await mkdir(inputs, { recursive: true, mode: 0o700 });
  await mkdir(join(cwd, 'artifacts'), { mode: 0o700 });
  await writeFile(policy, '{}', { mode: 0o600 });
  await writeConfig({ ...config, extra: 'private metadata' });
  return { dir, attemptId, snapshot, policy, inputs, env, writeConfig };
}

describe('Pi ACP job files', () => {
  it('validates the frozen config and binds the job to its workspace', async () => {
    const f = await fixture();
    try {
      const { job } = acpEnvironment(f.env);
      expect(job?.attemptId).toBe(f.attemptId);
      expect(job?.config).toEqual(config);
      await f.writeConfig({ ...config, skills: [config.skills[0], config.skills[0]] });
      expect(() => acpEnvironment(f.env)).toThrow();
      await f.writeConfig({ ...config, tools: [{ id: 't', schemaDigest: 'bad' }] });
      expect(() => acpEnvironment(f.env)).toThrow();
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });

  it('rejects a job with a non-UUID attempt directory', async () => {
    const f = await fixture('not-an-attempt');
    try {
      expect(() => acpEnvironment(f.env)).toThrow();
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });

  it('rejects nonprivate or linked snapshots, nonprivate policy files and linked inputs', async () => {
    const f = await fixture();
    try {
      await chmod(f.snapshot, 0o644);
      expect(() => acpEnvironment(f.env)).toThrow();
      await chmod(f.snapshot, 0o400);
      const alias = join(f.dir, 'alias.json');
      await link(f.snapshot, alias);
      expect(() => acpEnvironment(f.env)).toThrow();
      await rm(f.snapshot);
      await symlink(alias, f.snapshot);
      expect(() => acpEnvironment(f.env)).toThrow();
      await f.writeConfig(config);
      expect(() => acpEnvironment({ ...f.env, URSI_PI_POLICY: 'relative' })).toThrow();
      await chmod(f.policy, 0o644);
      expect(() => acpEnvironment(f.env)).toThrow();
      await chmod(f.policy, 0o600);
      await rm(f.inputs, { recursive: true });
      await symlink(f.dir, f.inputs);
      expect(() => acpEnvironment(f.env)).toThrow();
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });

  it('reads the optional node contract directly from the job', async () => {
    const f = await fixture();
    try {
      const nodeContract = { outcomes: ['accept', 'reject'], variables: ['summary'] };
      await f.writeConfig(config, { nodeContract });
      expect(acpEnvironment(f.env).job?.nodeContract).toEqual(nodeContract);
      for (const invalid of [null, {}, { outcomes: [], variables: [] },
        { ...nodeContract, outcomes: [' '] }, { ...nodeContract, outcomes: [1] },
        { ...nodeContract, variables: ['a', 'a'] }, { ...nodeContract, variables: ['bad name'] },
        { ...nodeContract, extra: 1 }]) {
        await f.writeConfig(config, { nodeContract: invalid });
        expect(() => acpEnvironment(f.env)).toThrow();
      }
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
});
