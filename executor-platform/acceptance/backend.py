#!/usr/bin/python3
"""Deterministic, single-session ACP v2 stdio backend for platform acceptance."""
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
from uuid import UUID, uuid4

CANCEL_INSTRUCTION = 'acceptance: wait for cancellation'
DELAYED_ACK = 'acceptance: ACK after terminal'
LOST_ACK = 'acceptance: no insertion evidence'
ECHO_ONLY = 'acceptance: insertion echo without ACK'
STALE_IDLE = 'acceptance: stale idle before running'
INVALID_FLOW = 'acceptance: invalid Flow outcome'
RECEIPT_TOOL = 'acceptance_receipt'
REPLY_TEXT = 'acceptance: receipt written'
EARLY_TOOL = 'acceptance_early_setup'
EARLY_MESSAGE = 'acceptance: early session update'
FOREIGN_MESSAGE = 'acceptance: unrelated session update'
STALE_MESSAGE = 'acceptance: stale idle sent'


def send(**frame):
    print(json.dumps({'jsonrpc': '2.0', **frame}), flush=True)


def reply(req, **result):
    send(id=req['id'], result=result)


def update(session, kind, **fields):
    send(method='session/update', params={
        'sessionId': session, 'update': {'sessionUpdate': kind, **fields},
    })


def text(blocks):
    assert blocks and all(block['type'] == 'text' for block in blocks)
    return ''.join(block['text'] for block in blocks)


def agent_message(session, content):
    update(session, 'agent_message', messageId=str(uuid4()),
           content=[{'type': 'text', 'text': content}])


def write_receipt(cwd, prompt, instruction, contract):
    output = cwd / 'artifacts'
    if contract is None:
        marker = (cwd / 'inputs/material.txt').read_text(encoding='utf-8')
    elif instruction == INVALID_FLOW:
        marker = instruction
        (output / 'flow-outcome.json').write_text(
            json.dumps({'outcome': 'undeclared', 'variables': {}}), encoding='utf-8')
    else:
        marker = re.search(r'e2e-flow-[0-9a-f]{32}', instruction)[0]
        assert set(contract['outcomes']) == {'通过', '退回'}
        assert '回执' in contract['variables']
        outcome = {'outcome': '退回', 'variables': {'回执': marker}}
        with (output / 'flow-outcome.json').open('x', encoding='utf-8') as file:
            json.dump(outcome, file)
    with (output / 'receipt.json').open('x', encoding='utf-8') as file:
        json.dump(dict(marker=marker, prompt=prompt, attempt=str(UUID(cwd.parent.name))), file)


def main():
    job_file = os.environ.get('URSI_ACP_JOB')
    job = None
    if job_file:
        path = Path(job_file)
        assert path.is_file() and path.stat().st_mode & 0o077 == 0
        job = json.loads(path.read_text(encoding='utf-8'))
        (path.parent / 'fixture-pids').write_text(f'{os.getppid()} {os.getpid()}', encoding='ascii')
        # Do not leave an indefinitely blocked fixture if a test aborts.
        signal.alarm(60)
    initialized = prompted = waiting = closed = False
    session = None
    for line in sys.stdin:
        req = json.loads(line)
        assert req['jsonrpc'] == '2.0' and not closed
        method, params = req['method'], req['params']
        if job is not None:
            with (path.parent / 'fixture-methods').open('a', encoding='utf-8') as calls:
                print(method, file=calls)
        if method == 'initialize':
            assert not initialized and params['protocolVersion'] == 2
            assert params['info']['name'] and params['info']['version']
            assert isinstance(params['capabilities'], dict)
            reply(req, protocolVersion=2, info={'name': 'acceptance', 'version': '2'},
                  capabilities={'session': {'systemPrompt': {'mode': {'override': {}}}}})
            initialized = True
        elif method == 'session/new':
            assert initialized and session is None
            cwd = Path(params['cwd'])
            assert cwd.is_absolute() and cwd.is_dir()
            if job is not None:
                assert cwd == Path(job['cwd']) and job['configDigest']
            system_prompt = params.get('systemPrompt')
            if system_prompt is not None:
                assert system_prompt['mode'] in ('append', 'override')
                prompt = text(system_prompt['content'])
            session = str(uuid4())
            if job is not None:
                update(session, 'state_update', state='idle', stopReason='error')
                update(session, 'tool_call_update', toolCallId=str(uuid4()), name=EARLY_TOOL, status='completed')
                agent_message(str(uuid4()), FOREIGN_MESSAGE)
                agent_message(session, EARLY_MESSAGE)
            reply(req, sessionId=session)
        else:
            assert session is not None and params['sessionId'] == session
            if method == 'session/prompt':
                assert job is not None and cwd.name == 'workspace', 'preflight must not send a prompt'
                assert system_prompt is not None and system_prompt['mode'] == 'override'
                assert not prompted, 'one prompt per attempt'
                assert isinstance(params['idempotencyKey'], str) and params['idempotencyKey']
                prompted = True
                instruction = text(params['prompt'])
                message_id = str(uuid4())
                if instruction != LOST_ACK:
                    update(session, 'user_message', messageId=message_id, content=params['prompt'])
                if instruction not in (DELAYED_ACK, LOST_ACK, ECHO_ONLY):
                    reply(req, messageId=message_id)
                if instruction == STALE_IDLE:
                    update(session, 'state_update', state='idle', stopReason='error')
                    agent_message(session, STALE_MESSAGE)
                    deadline = time.monotonic() + 15
                    while not (path.parent / 'fixture-release').exists():
                        assert time.monotonic() < deadline, 'test did not release the stale-idle fixture'
                        time.sleep(.02)
                update(session, 'state_update', state='running')
                if instruction == STALE_IDLE:
                    update(str(uuid4()), 'state_update', state='idle', stopReason='error')
                contract = job.get('nodeContract')
                tool = 'submit_flow_outcome' if contract is not None else RECEIPT_TOOL
                tool_id = str(uuid4())
                update(session, 'tool_call_update', toolCallId=tool_id, name=tool, title=tool, status='in_progress')
                if instruction == CANCEL_INSTRUCTION:
                    # Stay active until the client cancels. No timer can win the race.
                    waiting = True
                    continue
                write_receipt(cwd, prompt, instruction, contract)
                update(session, 'tool_call_update', toolCallId=tool_id, status='completed')
                agent_message(session, REPLY_TEXT)
                update(session, 'state_update', state='idle', stopReason='end_turn')
                if instruction == DELAYED_ACK:
                    # A round trip forces terminal to be consumed before sending the ACK.
                    send(id='acceptance-barrier', method='session/request_permission', params={
                        'sessionId': session, 'toolCall': {'toolCallId': tool_id, 'title': tool},
                        'options': [{'optionId': 'allow', 'name': 'Allow once', 'kind': 'allow_once'}],
                    })
                    assert json.loads(sys.stdin.readline()) == {
                        'jsonrpc': '2.0', 'id': 'acceptance-barrier',
                        'result': {'outcome': {'outcome': 'cancelled'}},
                    }
                    reply(req, messageId=message_id)
            elif method == 'session/cancel':
                assert 'id' not in req
                if waiting:
                    waiting = False
                    update(session, 'state_update', state='idle', stopReason='cancelled')
            else:
                assert method == 'session/close', method
                waiting = False
                reply(req)
                closed = True
    assert closed, 'client disconnected without closing the session'


if __name__ == '__main__':
    main()
