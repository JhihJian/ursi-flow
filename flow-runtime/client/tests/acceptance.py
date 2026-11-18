"""From flow-runtime/: npm run build && cargo build --manifest-path client/Cargo.toml && python3 client/tests/acceptance.py"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / 'client/target/debug/ursi-flow'
FLOW = '''---
name: 测试
 description: 占位
---
```mermaid
flowchart TD
  start((开始)) --> work[工作]
  work -->|已执行| finish((结束))
```
## 工作
```执行自定义命令
{"command":"node","args":["scripts/task.mjs"]}
```
### 已执行
完成工作。
'''.replace(' description:', 'description:')

def request(home, op, args):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(5)
        sock.connect(str(home / 'runtime.sock'))
        sock.sendall(json.dumps({'v': 1, 'op': op, 'args': args}).encode())
        sock.shutdown(socket.SHUT_WR)
        with sock.makefile() as reply:
            return json.load(reply)


class Acceptance(unittest.TestCase):
    def assert_code(self, home, op, args, code):
        reply = request(home, op, args)
        self.assertEqual(reply['v'], 1)
        self.assertIsInstance(reply['error'], str)
        self.assertEqual(reply.get('code'), code, reply)

    def test_independent_processes(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            env = dict(os.environ, URSI_FLOW_HOME=temp)
            def cli(*args, ok=True):
                p = subprocess.run([CLI,*args], cwd=temp, env=env, text=True,capture_output=True,timeout=10)
                if not ok:
                    self.assertNotEqual(p.returncode,0); return
                self.assertEqual(p.returncode,0,p.stderr); return json.loads(p.stdout)
            def wait(fn):
                for _ in range(200):
                    if fn(): return
                    time.sleep(.02)
                self.fail('等待超时')
            def daemon():
                p=subprocess.Popen(['node',ROOT/'dist/machine/daemon.js'],env=env)
                self.addCleanup(lambda: p.poll() is None and (p.terminate(),p.wait(timeout=8)))
                wait(lambda:(home/'runtime.sock').exists()); return p
            p=daemon()
            for op in ('flow.get', 'flow.update', 'flow.delete', 'run.get', 'run.stop', 'run.history'):
                self.assert_code(home, op, {'id': 'missing'}, 'not_found')
            for bad in ([], {'model': None}, {'maxConcurrent': 0}, {'unknown': True}):
                self.assert_code(home, 'config.update', bad, 'invalid_input')
            self.assert_code(home, 'flow.get', {'id': '../invalid'}, 'invalid_input')
            cli('config','set','{"maxConcurrent":1}');cli('config','set','{"maxConcurrent":0}',ok=False)
            self.assertEqual(cli('config','get')['maxConcurrent'],1)
            pkg=home/'source'; (pkg/'scripts').mkdir(parents=True)
            (pkg/'FLOW.md').write_text(FLOW)
            script=pkg/'scripts/task.mjs'
            script.write_text("import fs from 'node:fs'; fs.writeFileSync('pid',String(process.pid)); setInterval(()=>{},1000)")
            self.assertTrue(cli('flow','validate','work',str(pkg))['valid']);self.assertEqual(cli('flow','list'),[])
            cli('flow','create','work',str(pkg)); self.assertEqual(cli('flow','list'),['work'])
            files = {'FLOW.md': FLOW, 'scripts/task.mjs': script.read_text()}
            args = {'id': 'work', 'files': files}
            rev = cli('flow', 'get', 'work')['revision']
            self.assert_code(home, 'flow.create', args, 'conflict')
            for bad in ({'FLOW.md': 'invalid'}, {'FLOW.md': FLOW},
                        {**files, 'scripts/task.mjs/child': ''}):
                self.assert_code(home, 'flow.validate', {**args, 'files': bad}, 'invalid_input')
            args['expectedRevision'] = rev
            updated = request(home, 'flow.update', args)['data']['revision']
            self.assertNotEqual(rev, updated)
            self.assert_code(home, 'flow.update', args, 'conflict')
            self.assertEqual(cli('flow', 'get', 'work')['revision'], updated)
            start = {'id': 'first', 'flow': 'work', 'cwd': temp, 'variables': {}}
            for patch in ({'variables': None}, {'variables': []}, {'cwd': str(home/'absent')}):
                self.assert_code(home, 'run.start', {**start, **patch}, 'invalid_input')
            self.assert_code(home, 'run.start', {**start, 'flow': 'absent'}, 'not_found')
            a=cli('run','start','work','{}','first'); wait(lambda:(home/'pid').exists())
            self.assertEqual(a['id'],cli('run','start','work','{}','first')['id'])
            self.assert_code(home, 'run.start', {**start, 'variables': {'x': 1}}, 'conflict')
            self.assert_code(home, 'run.start', {**start, 'id': 'second'}, 'busy')
            cli('run','start','work','{}','second',ok=False)
            pid=int((home/'pid').read_text()); self.assertEqual(cli('run','history','first')['nodeRuns'][0]['nodeRef'],'work')
            (pkg/'FLOW.md').write_text('invalid'); cli('flow','update','work',str(pkg),ok=False)
            self.assertEqual(cli('flow','get','work')['files']['FLOW.md'],FLOW)
            (pkg/'FLOW.md').write_text(FLOW);script.write_text("console.log('新版')")
            cli('flow','update','work',str(pkg))
            self.assertEqual(cli('run','stop','first')['status'],'stopped')
            def ended():
                stat=Path(f'/proc/{pid}/stat');return not stat.exists() or stat.read_text().split(') ')[1].startswith('Z')
            self.assertTrue(ended())
            b=cli('run','start','work','{}','second');self.assertNotEqual(a['revision'],b['revision'])
            wait(lambda:cli('run','get','second')['status']=='completed')
            cli('flow','delete','work'); self.assertEqual(cli('flow','list'),[])
            self.assertEqual(len(cli('run','list')),2)
            p.terminate();p.wait(timeout=8); daemon()
            fact=cli('run','history','second')['nodeRuns'][0]
            self.assertEqual(fact['outcome']['result'],'已执行'); self.assertEqual(fact['commandResult']['stdout'].strip(),'新版')
            # Broken persisted data is neither missing business data nor bad caller input.
            (home/'config.json').write_text('{"maxConcurrent":0}')
            self.assert_code(home, 'config.update', {'model': 'x'}, None)
            (home/'catalog.json').write_text('"missing-generation"')
            self.assert_code(home, 'flow.get', {'id': 'work'}, None)
            (home/'runs/second/job.json').unlink()
            self.assert_code(home, 'run.get', {'id': 'second'}, None)

if __name__=='__main__':unittest.main()
