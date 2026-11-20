"""Trusted bootstrap for the bwrap worker. No recipe is read before lockdown."""
import base64
import collections
import csv
import ctypes
import datetime
import errno
import hashlib
import io
import itertools
import json
import math
import os
import re
import resource
import sys


def seal():
    os.closerange(3, 2**31 - 1)
    for kind, cap in ((resource.RLIMIT_NOFILE, 16), (resource.RLIMIT_NPROC, 0),
                      (resource.RLIMIT_CPU, 2), (resource.RLIMIT_CORE, 0),
                      (resource.RLIMIT_FSIZE, 0), (resource.RLIMIT_AS, 192 << 20)):
        resource.setrlimit(kind, (cap, cap))
    # The only permitted I/O after this point is on the inherited pipes. In
    # particular there is no open, socket, clone, exec, or namespace syscall.
    lib = ctypes.CDLL('libseccomp.so.2')
    uint, ptr = ctypes.c_uint32, ctypes.c_void_p
    lib.seccomp_init.argtypes = [uint]
    lib.seccomp_init.restype = ptr
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add.argtypes = [ptr, uint, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_load.argtypes = [ptr]
    ctx = lib.seccomp_init(0x00050000 | errno.EPERM)  # SCMP_ACT_ERRNO
    if not ctx:
        raise RuntimeError('seccomp init')
    for name in ('read write close brk mmap munmap mremap mprotect madvise '
                 'futex clock_gettime rt_sigreturn exit exit_group').split():
        nr = lib.seccomp_syscall_resolve_name(name.encode('ascii'))
        if nr < 0 or lib.seccomp_rule_add(ctx, 0x7fff0000, nr, 0) != 0:
            raise RuntimeError('seccomp rule')
    if lib.seccomp_load(ctx) != 0:
        raise RuntimeError('seccomp load')


seal()
sys.stdout.buffer.write(b'READY\n')
sys.stdout.buffer.flush()
payload = json.loads(sys.stdin.buffer.read())
namespace = {'__name__': '__recipe__'}
exec(compile(payload['script'], '<recipe>', 'exec'), namespace)
value = namespace['transform'](payload['item'], payload['resources'])
sys.stdout.buffer.write(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8'))
