#!/usr/bin/env python3
"""Offline Workbench -> executor platform migration (Linux, Python 3.9+)."""
import argparse
import ctypes
import errno
import fcntl
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
from contextlib import contextmanager

from assets import Refused, project, require, settings, strings, table

MIB = 1024 * 1024


def parse(raw):
    def unique(pairs):
        result = dict(pairs)
        require(len(result) == len(pairs), 'JSON 含重复键')
        return result

    return json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
                      parse_constant=lambda _: require(False, 'JSON 含非有限数'))


@contextmanager
def opened(name, directory=False, parent=None):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(name, flags | (os.O_DIRECTORY if directory else 0), dir_fd=parent)
    try:
        meta = os.fstat(fd)
        require(stat.S_ISDIR(meta.st_mode) if directory else
                stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1, '源包含链接或特殊文件')
        if parent is not None:
            require(mount(fd) == mount(parent), '拒绝跨挂载点读取')
        yield fd
    finally:
        os.close(fd)


def mount(fd):
    for line in Path(f'/proc/self/fdinfo/{fd}').read_text(encoding='ascii').splitlines():
        if line.startswith('mnt_id:'):
            return line.split()[1]
    raise Refused('需要 Linux procfs 的 mnt_id')


def read(fd, limit):
    require(os.fstat(fd).st_size <= limit, '源文件超过大小上限')
    with os.fdopen(fd, 'rb', closefd=False) as stream:
        data = stream.read(limit + 1)
    require(len(data) <= limit, '源文件超过大小上限')
    return data


def write(path, data):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def sync_dir(path):
    with opened(path, True) as fd:
        os.fsync(fd)


def publish(stage, target):
    # os.rename can silently replace an empty directory created after preflight.
    rename = getattr(ctypes.CDLL(None, use_errno=True), 'renameat2', None)
    require(rename is not None, '需要支持 renameat2 的 Linux libc')
    if rename(-100, os.fsencode(stage), -100, os.fsencode(target), 1) != 0:  # RENAME_NOREPLACE
        err = ctypes.get_errno()
        require(err != errno.EEXIST, '目标冲突，已有目录或文件')
        raise OSError(err, os.strerror(err))
    try:
        sync_dir(target.parent)
    except OSError as e:
        raise Refused('目标已发布但父目录同步失败，保持停机并检查磁盘') from e


class Copy:
    def __init__(self, secrets):
        self.secrets = secrets
        self.size = self.files = 0

    def inspect(self, data):
        require(not any(s in data for s in self.secrets), '管理资产含旧平台环境变量的明文值')

    def tree(self, fd, dst, parts=()):
        if dst is not None:
            dst.mkdir(mode=0o700)
        if not parts:
            for k in ('AGENTS.md', 'skills', 'mcp.json'):
                mode = os.stat(k, dir_fd=fd, follow_symlinks=False).st_mode
                require((stat.S_ISDIR if k == 'skills' else stat.S_ISREG)(mode), '配置目录结构不完整')
        with os.scandir(fd) as entries:
            self.entries(entries, fd, dst, parts)
        if dst is not None:
            sync_dir(dst)

    def entries(self, entries, fd, dst, parts):
        for item in entries:
            k = item.name
            rel = parts + (k,)
            self.files += 1
            require(self.files <= 100_000 and len(rel) <= 32 and len('/'.join(rel).encode()) <= 1024
                    and not k.startswith('.workbench-tmp-') and all(c.isprintable() for c in k),
                    '目录条目数或路径不受支持')
            self.inspect(k.encode())
            folder = item.is_dir(follow_symlinks=False)
            require(folder or item.is_file(follow_symlinks=False), '配置目录含链接或特殊文件')
            child = dst / k if dst is not None else None
            with opened(k, folder, fd) as entry:
                if folder:
                    self.tree(entry, child, rel)
                else:
                    data = read(entry, 8 * MIB)
                    self.size += len(data)
                    require(self.size <= 1024 * MIB, '配置文件总量超过 1 GiB')
                    self.inspect(data)
                    if rel == ('mcp.json',):
                        settings(parse(data))
                    if child is not None:
                        write(child, data)


def export(root, db, stage):
    out = project(db)
    values = list(table(db, 'platformEnvironment').values())
    require(len(values) <= 128 and all(isinstance(v, str) and 0 < len(v.encode()) <= 8192 for v in values),
            '旧环境变量表无效')
    copy = Copy({v.encode() for v in values})
    for s in strings(out):
        copy.inspect(s.encode())
    dest = stage / 'directories' if stage is not None else None
    if dest:
        dest.mkdir(mode=0o700)
    if out['directories']:
        with opened('directories', True, root) as base:
            for key in out['directories']:
                before = copy.files
                with opened(key, True, base) as src:
                    copy.tree(src, dest / key if dest else None)
                require(copy.files - before <= 20_000, '单个配置目录超过两万条目')
    data = json.dumps(out, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()
    if stage:
        sync_dir(dest)
        write(stage / 'platform.json', data)
        write(stage / 'work.lock', b'platform.json')
        sync_dir(stage)
    return dict(configPackages=len(out['configPatches']), resources=len(out['catalog']['resources']),
                executors=len(out['catalog']['executors']), reservedAttemptIds=len(out.get('executorAttempts', {})),
                directoryEntries=copy.files, fileBytes=copy.size)


def migrate(source, target, apply=False):
    source, target = Path(source).absolute(), Path(target).absolute()
    require(source == source.resolve(strict=True) and target.parent == target.parent.resolve(strict=True),
            '源和目标父目录须为无符号链接的规范路径')
    require(target != source and source not in target.parents and target not in source.parents,
            '源和目标目录不能重叠')
    require(not os.path.lexists(target), '目标冲突，须指定尚不存在的路径')
    parent = target.parent.stat()
    require(parent.st_uid in (os.geteuid(), 0) and parent.st_mode & 0o022 == 0, '目标父目录不得允许其他用户写入')
    with opened(source, True) as root, opened('work.lock', parent=root) as lock:
        require(os.fstat(root).st_mode & 0o077 == 0, '源库目录必须私有')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise Refused('源 work.lock 被占用，请停机') from e
        require(read(lock, 32) in (b'', b'work.json') and not os.path.lexists(source / 'platform.json'),
                '源库角色不是 Workbench')
        with opened('work.json', parent=root) as f:
            db = parse(read(f, 256 * MIB))
        if not apply:
            return export(root, db, None)
        stage = Path(tempfile.mkdtemp(prefix='.executor-migrate-', dir=target.parent))
        try:
            result = export(root, db, stage)
            publish(stage, target)
            return result
        finally:
            if stage.exists():
                shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description='离线迁移 Workbench 管理资产。默认只预检。')
    parser.add_argument('source', help='包含 work.json 和 work.lock 的目录')
    parser.add_argument('target', help='尚不存在的平台目录')
    parser.add_argument('--apply', action='store_true', help='确认配置正文和附件已做凭据审查，原子发布到目标路径')
    args = parser.parse_args()
    try:
        result = migrate(args.source, args.target, args.apply)
    except Refused as e:
        sys.exit(f'拒绝迁移：{e}')
    except OSError as e:
        sys.exit(f'迁移失败：{os.strerror(e.errno) if e.errno else "文件系统错误"}')
    except (TypeError, ValueError, RecursionError, KeyError):
        sys.exit('拒绝迁移：输入记录或文件编码无效')
    print(json.dumps(dict(mode='published' if args.apply else 'preflight', **result)))


if __name__ == '__main__':
    main()
