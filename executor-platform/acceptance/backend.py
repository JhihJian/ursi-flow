#!/usr/bin/python3
"""可控 stdio MCP 后端。所有输出均来自此次尝试收到的快照和输入。"""
import json
import os
from pathlib import Path
import re
import sys
from uuid import UUID

TOOLS = ['executor_start', 'executor_inspect', 'executor_cancel']


def call(name, args):
    attempt = str(UUID(args['attemptId']))
    root = Path(os.environ['URSI_EXECUTOR_ROOT']) / attempt
    output = root / 'workspace/artifacts'
    report = output / 'receipt.json'
    if name == 'executor_start':
        assert args['workspaceRef'] == 'workspace:' + attempt
        assert args['artifactDirectoryRef'] == 'artifacts:' + attempt
        prompt = json.loads((root / 'agent-config.json').read_text())['systemPrompt']
        instruction = args['workInstruction']
        contract = args.get('runConfig', {}).get('nodeContract')
        if contract is None:
            marker = (root / 'workspace/inputs/material.txt').read_text()
        else:
            marker = re.search(r'e2e-flow-[0-9a-f]{32}', instruction)[0]
            assert set(contract['outcomes']) == {'通过', '退回'}
            assert '回执' in contract['variables']
            outcome = {'outcome': '退回', 'variables': {'回执': marker}}
            (output / 'flow-outcome.json').write_text(json.dumps(outcome))
        report.write_text(json.dumps(dict(marker=marker, prompt=prompt, attempt=attempt)))
    # A new stdio process handles each inspect. Never synthesize a missing start.
    status = 'succeeded' if report.is_file() else 'unverified'
    return {'content': [], 'structuredContent': {'attemptId': attempt, 'status': status,
            'artifactDirectoryRef': 'artifacts:' + attempt, 'backendRunRef': 'fixture:' + attempt}}


for line in sys.stdin:
    req = json.loads(line)
    method = req['method']
    if method == 'notifications/initialized':
        continue
    if method == 'initialize':
        result = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}},
                  'serverInfo': {'name': 'acceptance', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': t, 'inputSchema': {'type': 'object'}} for t in TOOLS]}
    else:
        assert method == 'tools/call' and req['params']['name'] in TOOLS
        result = call(req['params']['name'], req['params']['arguments'])
    print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': result}), flush=True)
