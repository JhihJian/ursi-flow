#!/usr/bin/env python3
"""Check the locked, all-features graph and literal Rust source inclusions."""
import json
from pathlib import Path
import re
import subprocess
import sys


SERVER = ('server', 'flow-core', 'sandbox-access')
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
    sdk = root / 'ursi-sandbox/client'
    access = root / 'sandbox-access'
    if side == 'server':
        allowed = [*(root / p for p in SERVER), sdk]
        for directory, entries in [(sdk.parent, {'Cargo.toml', 'client'}),
                                   (sdk, {'Cargo.toml', 'src'})]:
            require({p.name for p in directory.iterdir()} == entries,
                    f'{directory}: expected only {sorted(entries)}')
    else:
        allowed = [ws]
        for p in [*SERVER, 'Cargo.toml', 'Cargo.lock']:
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
                    ok = path in allowed and (path != sdk or crate == access) and crate != sdk
                else:
                    ok = path.is_relative_to(ws)
                require(ok, f"{pid}: {dep['kind']} path {path}")
        for target in p['targets']:
            require(Path(target['src_path']).resolve().is_relative_to(crate if side == 'server' else ws),
                    f"foreign target: {target['src_path']}")

    if side == 'server':
        by_dir = {Path(packages[pid]['manifest_path']).parent: pid for pid in local_ids}
        members = {Path(packages[pid]['manifest_path']).parent for pid in data['workspace_members']}
        require(members == {root / p for p in SERVER}, 'expected only the three server workspace members')
        sdk_id = by_dir.get(sdk)
        sdk_ids = {pid for pid, p in packages.items() if p['name'] == 'ursi-sandbox-client'}
        require(sdk_ids == {sdk_id}, 'expected only the copied public SDK')
        for p in packages.values():
            require(p['name'] not in {'ursi-gateway', 'ursi-session-service'},
                    f"server reaches sandbox implementation: {p['id']}")
        # Check resolved edges too: a patched or renamed dependency need not
        # declare the SDK path in the consumer's manifest.
        consumers = {pid for pid, node in nodes.items() if sdk_id in node['dependencies']}
        require(consumers == {by_dir[access]}, f'unexpected SDK consumers: {consumers}')
        core = by_dir[root / 'flow-core']
        seen = set()
        pending = [core]
        while pending:
            for dep in nodes[pending.pop()]['deps']:
                pid = dep['pkg']
                require(pid not in local_ids, f"flow-core reaches {pid}: {dep['dep_kinds']}")
                if pid not in seen:
                    seen.add(pid)
                    pending.append(pid)
        # metadata unifies workspace features. Ask Cargo for the selected package
        # graph so another member cannot turn sandbox-access back on unnoticed.
        tree = subprocess.check_output([
            'cargo', 'tree', '--locked', '-p', 'ursi-server', '--no-default-features',
            '--target', 'all', '-e', 'normal,build,dev', '--prefix', 'none', '--format', '{p}'
        ], cwd=ws, text=True)
        require(not re.search(r'^(sandbox-access|ursi-sandbox-client) v', tree, re.M),
                'ursi-server --no-default-features still reaches sandbox-access or the SDK')

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
