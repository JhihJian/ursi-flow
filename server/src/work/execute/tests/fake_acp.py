#!/usr/bin/python3
"""CLI contract fixture; each invocation is a separate process like ursi-sandbox-client."""
import json
import os
from pathlib import Path
import sys
import time


def emit(kind, key, value):
    print(json.dumps({'type': kind, key: value}), flush=True)


assert sys.argv[1] == 'acp'
assert 'URSI_SESSION_TOKEN' not in os.environ and 'URSI_API_TOKEN' not in os.environ
assert os.environ['URSI_ACP_URL'] == 'ws://localhost:8765/acp'
root = Path(os.environ['URSI_SESSION_TOKEN_FILE']).parent
session = '185303da-112a-4b98-b299-baed476cd247'
op = sys.argv[2]
mode = (root / 'mode').read_text()
if op == 'new':
    assert sys.argv[3:] == ['/ursi/workspace/private']
    emit('result', 'result', {'sessionId': session})
else:
    assert sys.argv[3] == session
    if op == 'prompt':
        assert sys.argv[4:] == ['/dev/stdin']
        history = json.loads((root / 'db/work.json').read_text())['items']['i']['attempts']
        a = history[-1]
        assert (a['backendRunId'], a['workspace'], a['status']) == (session, 'case-i', 'running')
        text = Path(sys.argv[4]).read_text()
        assert 'A-17' in text and '报告须有标题' in text
        with (root / 'count').open('a') as f:
            print('prompt', file=f)
        emit('update', 'params', {'sessionId': session, 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'answer:/ursi/workspace/private'}}})
        if mode == 'disconnect':
            sys.exit(1)
        if mode in ['cancel', 'wrong-status', 'ack-only']:
            deadline = time.monotonic() + 45
            while not (root / 'cancel').exists() and time.monotonic() < deadline:
                time.sleep(.01)
            assert (root / 'cancel').exists()
            if mode == 'ack-only':  # Notification succeeded, but original prompt connection was lost.
                sys.exit(1)
            emit('result', 'result', {'stopReason': 'cancelled'})
            sys.exit(2)
        emit('result', 'result', {'stopReason': 'end_turn'})
    elif op == 'cancel':
        (root / 'cancel').touch()
        emit('result', 'result', {'cancelSent': True, 'sessionId': session})
    elif op == 'status':
        emit('result', 'result', {'sessionId': 'other' if mode == 'wrong-status' else session, 'state': 'closed' if (root / 'closed').exists() else 'cancelled', 'pid': None})
    elif op == 'close':
        (root / 'closed').touch()
        emit('result', 'result', {})
    else:
        raise AssertionError(op)
