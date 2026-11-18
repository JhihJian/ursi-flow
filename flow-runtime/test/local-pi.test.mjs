import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('Pi CLI 新建和复用会话，由真实工具提交两个结果', { skip: !process.env.TEST_REAL_PI }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ursi-pi-'));
  t.after(() => rm(dir, {recursive: true, force:true}));
  let turns = 0;
  const requests = [];
  const server = createServer(async (req,res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    const first = ++turns === 1;
    const args = first ? {outcome:'已分析',variables:{分析结论:'本地验收'}} : {outcome:'已完成'};
    const delta = {role:'assistant', tool_calls:[{index:0,id:`call_${turns}`,type:'function',function:{name:'submit_flow_outcome',arguments:JSON.stringify(args)}}]};
    res.writeHead(200, {'content-type':'text/event-stream'});
    for(const [d, stop] of [[delta,null],[{},'tool_calls']]) res.write('data: '+JSON.stringify({id:`completion_${turns}`,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:d,finish_reason:stop}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0,'0.0.0.0',done));
  t.after(() => server.close());
  const agentDir = join(dir,'agent'); await mkdir(agentDir);
  await writeFile(join(agentDir,'models.json'), JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture',models:[{id:'fixture',name:'Fixture',contextWindow:32000,maxTokens:1024}]}}}));
  const history = join(dir,'history.json');
  const result = await exec(process.execPath, [resolve('dist/cli.js'),'run',resolve('examples/ordinary'),'--cwd',dir,'--history',history,'--model','fixture/fixture'],{env:{PATH:process.env.PATH, HOME:dir, PI_CODING_AGENT_DIR:agentDir, PI_OFFLINE:'1'},timeout:50000}).catch(err => {throw new Error(err.stdout+' '+err.stderr);});
  assert.equal(JSON.parse(result.stdout).status,'completed');
  assert.equal(turns,2);
  assert.deepEqual(requests[0].tools.map(x=>x.function.name),['submit_flow_outcome']);
  assert.ok(requests[1].messages.some(x=>x.role==='tool'));
  const log=JSON.parse(await readFile(history,'utf8'));
  assert.deepEqual(log.nodeRuns.map(n=>n.outcome.result),['已分析','已完成']);
});
