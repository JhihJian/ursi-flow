#!/usr/bin/python3
"""Install a verified immutable bundle, prepare credentials, exec supervisord."""
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse

MAX_BYTES = 512 * 1024 * 1024
MAX_MEMBERS = 4096
REQUIRED = {"bin/ursi-session-service", "supervisor/supervisord.conf", "supervisor/recovery.py"}


def sha256(path):
    with open(path, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def check_level(value, level):
    if type(value) is not int or value < 1:
        raise ValueError("invalid minimum image level")
    if value > level:
        raise ValueError(f"bundle requires image level {value}, image provides {level}")


def preflight_tar(archive):
    """Reject extension headers before tarfile can allocate their declared size."""
    consumed, members = 0, 0
    with gzip.open(archive, "rb") as stream:
        while True:
            header = stream.read(512)
            consumed += len(header)
            if len(header) != 512:
                raise ValueError("truncated tar header")
            if header == bytes(512):
                while chunk := stream.read(65536):
                    consumed += len(chunk)
                    if consumed > MAX_BYTES or any(chunk):
                        raise ValueError("invalid or oversized tar trailer")
                return
            member = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
            members += 1
            if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE):
                raise ValueError("tar extensions, links and special files are unsupported")
            size = ((member.size + 511) // 512) * 512
            if member.size < 0 or members > MAX_MEMBERS or consumed + size > MAX_BYTES:
                raise ValueError("bundle exceeds archive limits")
            if member.isdir() and member.size:
                raise ValueError("directory has unexpected content")
            while size:
                chunk = stream.read(min(size, 65536))
                if not chunk:
                    raise ValueError("truncated tar content")
                size -= len(chunk)
                consumed += len(chunk)


def unpack(archive, destination, level):
    """No extractall: accept only bounded regular files/directories, no links."""
    preflight_tar(archive)
    names, files, total = set(), {}, 0
    with tarfile.open(archive, "r:gz") as source:
        for index, member in enumerate(source):
            if index >= MAX_MEMBERS:
                raise ValueError("too many bundle members")
            name = member.name.rstrip("/") if member.isdir() else member.name
            parts = PurePosixPath(name).parts
            if (not parts or name.startswith("/") or ".." in parts
                    or "\\" in name or name != str(PurePosixPath(name))
                    or name in names or not (member.isfile() or member.isdir())):
                raise ValueError("unsafe or duplicate bundle member")
            names.add(name)
            total += member.size
            if total > MAX_BYTES or member.size < 0:
                raise ValueError("bundle exceeds extraction limit")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(exist_ok=True)
                target.chmod(0o755)
            else:
                with source.extractfile(member) as incoming, target.open("xb") as output:
                    shutil.copyfileobj(incoming, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
                files[name] = sha256(target)
    for directory_path in destination.rglob("*"):
        if directory_path.is_dir():
            directory_path.chmod(0o755)
    manifest_path = destination / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError("missing manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or not isinstance(manifest.get("version"), str) or not manifest["version"]:
        raise ValueError("missing bundle version")
    check_level(manifest.get("min_image_level"), level)
    if manifest.get("profile") != "pi-execution":
        raise ValueError("unsupported environment profile")
    files.pop("manifest.json")
    if manifest.get("files") != files or not REQUIRED <= files.keys():
        raise ValueError("bundle content checksum mismatch or missing service")
    if not os.access(destination / "bin/ursi-session-service", os.X_OK):
        raise ValueError("session service is not executable")
    return manifest


def check_cache_path(path, directory=True):
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError("unsafe bundle cache ownership/permissions")


def snapshot(root):
    check_cache_path(root)
    result = {}
    for path in root.rglob("*"):
        info = path.lstat()
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError("unsafe bundle cache ownership/permissions")
        if stat.S_ISREG(info.st_mode):
            value = ("file", stat.S_IMODE(info.st_mode), sha256(path))
        elif stat.S_ISDIR(info.st_mode):
            value = ("dir", stat.S_IMODE(info.st_mode))
        else:
            raise ValueError("unsafe bundle cache entry")
        result[str(path.relative_to(root))] = value
    return result


def install_bundle(url, digest, level, cache):
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("URSI_BUNDLE_SHA256 must be a lowercase SHA256")
    cache.mkdir(parents=True, exist_ok=True, mode=0o755)
    check_cache_path(cache)
    installed, saved = cache / digest, cache / (digest + ".tar.gz")
    with tempfile.TemporaryDirectory(prefix=".incoming-", dir=cache) as temporary:
        stage = Path(temporary)
        archive = stage / "bundle.tar.gz"
        if saved.exists():
            check_cache_path(saved, directory=False)
            if saved.is_symlink() or not saved.is_file() or sha256(saved) != digest:
                raise ValueError("cached archive checksum mismatch")
            archive = saved
        else:
            if urllib.parse.urlsplit(url).scheme not in ("https", "http"):
                raise ValueError("URSI_BUNDLE_URL must use HTTP(S)")
            # URL may contain a signed query: pass through stdin, never log it.
            result = subprocess.run([
                "curl", "--fail", "--silent", "--show-error", "--location",
                "--proto", "=http,https", "--proto-redir", "=http,https",
                "--connect-timeout", "10", "--max-time", "180", "--retry", "2",
                "--max-filesize", str(MAX_BYTES), "--config", "-", "--output", str(archive)
            ], input="url = " + json.dumps(url) + "\n", text=True, capture_output=True)
            if result.returncode:
                raise ValueError("bundle download failed")
            if sha256(archive) != digest:
                raise ValueError("bundle SHA256 mismatch")
        tree = stage / "tree"
        tree.mkdir(mode=0o755)
        unpack(archive, tree, level)
        if installed.exists() or installed.is_symlink():
            if installed.is_symlink() or not installed.is_dir() or snapshot(installed) != snapshot(tree):
                raise ValueError("installed bundle cache checksum mismatch")
        else:
            tree.chmod(0o755)
            tree.rename(installed)
        if archive != saved:
            archive.chmod(0o600)
            archive.rename(saved)
    return installed


def directory(path, mode, uid=0, gid=0):
    path = Path(path)
    if path.is_symlink():
        raise ValueError(f"directory must not be symlink: {path}")
    path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir():
        raise ValueError(f"not a directory: {path}")
    os.chown(path, uid, gid)
    path.chmod(mode)
    return path


def prepare():
    config = Path("/run/ursi/config")
    info = config.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError("config directory must be root-owned mode 0700")
    if not os.statvfs(config).f_flag & os.ST_RDONLY:
        raise ValueError("config directory must be mounted read-only")
    for name in ("session-token", "authorized_keys", "session.json", "pi/models.json"):
        path = config / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"missing regular config file: {name}")
    if len((config / "session-token").read_text(encoding="utf-8").strip()) < 32:
        raise ValueError("session-token must contain at least 32 characters")
    keys = (config / "authorized_keys").read_text(encoding="utf-8").strip()
    if not keys or not any(line.strip() and not line.lstrip().startswith("#") for line in keys.splitlines()):
        raise ValueError("authorized_keys is empty")
    directory("/run/ursi", 0o755)
    directory("/run/ursi/agent", 0o700, 1000, 1000)
    directory("/run/sshd", 0o755)
    private = directory("/run/ursi/sshd", 0o700)
    # Sticky root-owned workspace allows agent writes while protecting root state
    # from rename/unlink by the workspace user. Never recursively chown user data.
    directory("/ursi/workspace", 0o1770, 0, 1000)
    directory("/ursi/workspace/.ursi-state", 0o700)
    for name in ("host_ed25519", "probe_ed25519"):
        key = private / name
        if not key.exists():
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)], check=True)
        key.chmod(0o600)
    authorized = Path("/etc/ssh/authorized_keys/agent")
    authorized.write_text(keys + "\n", encoding="utf-8")
    authorized.chmod(0o644)
    checked = subprocess.run(["ssh-keygen", "-l", "-f", str(authorized)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if checked.returncode:
        raise ValueError("authorized_keys contains no valid SSH public key")
    probe = (private / "probe_ed25519.pub").read_text(encoding="utf-8").strip()
    with authorized.open("a", encoding="utf-8") as output:
        output.write('from="127.0.0.1",restrict,command="/usr/bin/true" ' + probe + "\n")
    host = (private / "host_ed25519.pub").read_text(encoding="utf-8").split()
    (private / "known_hosts").write_text("[127.0.0.1]:2222 " + " ".join(host[:2]) + "\n", encoding="utf-8")
    subprocess.run(["/usr/sbin/sshd", "-t"], check=True)


def main():
    if os.getuid() != 0:
        raise ValueError("bootstrap must run as root; agent tasks run as uid 1000")
    level = int(Path("/etc/ursi-image-level").read_text())
    check_level(int(os.environ.get("URSI_BUNDLE_MIN_IMAGE_LEVEL", "1")), level)
    prepare()
    bundle = install_bundle(os.environ.get("URSI_BUNDLE_URL", ""),
                            os.environ.get("URSI_BUNDLE_SHA256", ""), level,
                            Path("/opt/ursi/runtime"))
    manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    Path("/run/ursi/recovery.started").unlink(missing_ok=True)
    # Only the explicit service contract reaches supervisord, not download URLs.
    env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
           "HOME": "/root", "LANG": "C.UTF-8", "URSI_RUNTIME_DIR": str(bundle),
           "URSI_SESSION_BIND": "0.0.0.0:8765", "URSI_SESSION_CONFIG_DIR": "/run/ursi/config",
           "URSI_WORKSPACE_ROOT": "/ursi/workspace",
           "URSI_SESSION_STATE_DIR": "/ursi/workspace/.ursi-state", "URSI_PI_BIN": "/usr/local/bin/pi"}
    if "browser" in manifest.get("bundles", []):
        env.update({"URSI_BROWSER_ENABLED": "1", "DISPLAY": ":99",
                    "URSI_BROWSER_RUN_DIR": "/run/ursi/browser",
                    "URSI_BROWSER_PROFILE_DIR": "/ursi/workspace/.browser-profile"})
    os.execve("/usr/bin/supervisord", ["supervisord", "-n", "-c", str(bundle / "supervisor/supervisord.conf")], env)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, EOFError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(f"ursi bootstrap: {error}", file=sys.stderr)
        sys.exit(1)
