"""From flow-runtime/: npm run build && cargo build --manifest-path client/Cargo.toml && python3 client/tests/acceptance.py"""
import json
import os
from pathlib import Path
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

class Acceptance(unittest.TestCase):
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
            cli('config','set','{"maxConcurrent":1}');cli('config','set','{"maxConcurrent":0}',ok=False)
            self.assertEqual(cli('config','get')['maxConcurrent'],1)
            pkg=home/'source'; (pkg/'scripts').mkdir(parents=True)
            (pkg/'FLOW.md').write_text(FLOW)
            script=pkg/'scripts/task.mjs'
            script.write_text("import fs from 'node:fs'; fs.writeFileSync('pid',String(process.pid)); setInterval(()=>{},1000)")
            self.assertTrue(cli('flow','validate','work',str(pkg))['valid']);self.assertEqual(cli('flow','list'),[])
            cli('flow','create','work',str(pkg)); self.assertEqual(cli('flow','list'),['work'])
            a=cli('run','start','work','{}','first'); wait(lambda:(home/'pid').exists())
            self.assertEqual(a['id'],cli('run','start','work','{}','first')['id'])
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

if __name__=='__main__':unittest.main()
