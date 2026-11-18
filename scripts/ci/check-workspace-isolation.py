#!/usr/bin/env python3
"""Check the locked, all-features graph and literal Rust source inclusions."""
import json
from pathlib import Path
import re
import subprocess
import sys


# Also inspect literal inclusions behind inactive cfgs (which rustc won't open).
LITERAL = r'r?\#*"([^"\n]*)"\#*'
INCLUDE = re.compile(r'(?:\binclude(?:_str|_bytes)?!\s*[(\[{]\s*|'
                     r'#\s*\[\s*(?:cfg_attr\([^\n]*?,\s*)?path\s*=\s*)' + LITERAL)
MANIFEST_INCLUDE = re.compile(r'\binclude(?:_str|_bytes)?!\s*\(\s*concat!\s*\(\s*'
                              r'env!\s*\(\s*"CARGO_MANIFEST_DIR"\s*\)\s*,\s*' + LITERAL)


def require(condition, message):
    if not condition:
        sys.exit(f'isolation: {message}')


def check(side):
    root = Path.cwd()
    ws = root if side == 'server' else root / 'ursi-sandbox'
    server = root / 'server'
    sdk = root / 'flow-runtime/client'
    if side == 'server':
        allowed = [server, sdk]
        for p in ['flow-core', 'sandbox-access', 'ursi-sandbox', 'contracts']:
            require(not (root / p).exists() and not (root / p).is_symlink(), f'{p} must be absent')
        for directory, entries in [(sdk.parent, {'client'}),
                                   (sdk, {'Cargo.toml', 'Cargo.lock', 'src'})]:
            require({p.name for p in directory.iterdir()} == entries,
                    f'{directory}: expected only {sorted(entries)}')
    else:
        allowed = [ws]
        for p in ['server', 'flow-core', 'sandbox-access', 'flow-runtime', 'Cargo.toml', 'Cargo.lock']:
            require(not (root / p).exists() and not (root / p).is_symlink(), f'{p} must be absent')

    data = json.loads(subprocess.check_output([
        'cargo', 'metadata', '--format-version=1', '--locked', '--all-features'], cwd=ws))
    packages = {p['id']: p for p in data['packages']}
    nodes = {n['id']: n for n in data['resolve']['nodes']}
    # Full resolution, no target filter. Includes transitive, dev and build edges,
    # including local packages substituted by a registry patch.
    local_ids = {pid for pid, p in packages.items() if p['source'] is None}
    for pid in local_ids:
        p = packages[pid]
        crate = Path(p['manifest_path']).resolve().parent
        if side == 'server':
            require(crate in allowed, f'foreign local package: {pid}')
        else:
            require(crate.is_relative_to(ws), f'foreign local package: {pid}')
        for dep in p['dependencies']:
            if 'path' in dep:
                path = Path(dep['path']).resolve()
                if side == 'server':
                    ok = crate == server and path == sdk
                else:
                    ok = path.is_relative_to(ws)
                require(ok, f"{pid}: {dep['kind']} path {path}")
        for target in p['targets']:
            require(Path(target['src_path']).resolve().is_relative_to(crate if side == 'server' else ws),
                    f"foreign target: {target['src_path']}")

    if side == 'server':
        by_dir = {Path(packages[pid]['manifest_path']).parent: pid for pid in local_ids}
        members = {Path(packages[pid]['manifest_path']).parent for pid in data['workspace_members']}
        require(members == {server}, 'expected server to be the only workspace member')
        require(set(by_dir) == {server, sdk}, 'expected server and independent Flow SDK')
        sdk_id = by_dir[sdk]
        require({pid for pid, p in packages.items() if p['name'] == 'ursi-flow-client'} == {sdk_id},
                'expected only the copied Flow SDK')
        legacy = {'flow-core', 'sandbox-access', 'ursi-sandbox-client', 'ursi-gateway', 'ursi-session-service'}
        for p in packages.values():
            require(p['name'] not in legacy, f"server reaches legacy package: {p['id']}")
        consumers = {pid for pid, node in nodes.items() if sdk_id in node['dependencies']}
        require(consumers == {by_dir[server]}, f'unexpected SDK consumers: {consumers}')
        require(any(dep['pkg'] == sdk_id and any(k['kind'] is None for k in dep['dep_kinds'])
                    for dep in nodes[by_dir[server]]['deps']), 'server needs a normal SDK dependency')

    for base in allowed:
        for source in base.rglob('*.rs'):
            text = source.read_text(encoding='utf-8')
            for path in INCLUDE.findall(text):
                require((source.parent / path).resolve().is_relative_to(base), f'{source}: foreign include/path {path}')
            for path in MANIFEST_INCLUDE.findall(text):
                crate = next(d for d in source.parents if (d / 'Cargo.toml').is_file())
                require(Path(str(crate) + path).resolve().is_relative_to(base), f'{source}: foreign include {path}')
    print(f'{side}: dependency and source boundaries OK')


if __name__ == '__main__':
    if sys.argv[1:] not in (['server'], ['sandbox']):
        sys.exit('usage: check-workspace-isolation.py server|sandbox (from isolated checkout)')
    check(sys.argv[1])
