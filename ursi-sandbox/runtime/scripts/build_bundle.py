#!/usr/bin/env python3
"""Build a deterministic, composable Runtime bundle."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import tempfile


BUNDLE_ID = "pi-execution"
DEFAULT_REQUIRED_CAPABILITIES = ["sshd", "supervisord", "pi-cli"]
DEFAULT_SERVICES = ["sshd", "session-service"]
DEFAULT_ENDPOINTS = [
    {"name": "ssh", "protocol": "ssh", "port": 2222},
    {"name": "agent_session", "protocol": "acp", "port": 8765},
]
DEFAULT_READINESS = {
    "ssh": "authenticated exec",
    "agent_session": "GET /healthz",
}
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
FORBIDDEN_ENDPOINT_FIELDS = {"address", "visibility", "gateway_key", "key"}
CAPABILITY_FIELDS = {
    "bundles",
    "required_capabilities",
    "services",
    "endpoints",
    "readiness",
}
INPUT_METADATA_FIELDS = {"files", "min_image_level", "profile", "version"}


def parse_args():
    parser = argparse.ArgumentParser(
        description=(
            "Build a deterministic runtime-bundle.tar.gz. Additional JSON "
            "manifest/bundle definitions are composed into its capability manifest."
        )
    )
    parser.add_argument("session_service", type=Path, help="executable session-service binary")
    parser.add_argument("output_dir", type=Path, help="directory for the archive and SHA256 file")
    parser.add_argument(
        "--manifest",
        action="append",
        type=Path,
        metavar="PATH",
        help="JSON manifest containing composable capability fields; may be repeated",
    )
    parser.add_argument(
        "--bundles",
        action="append",
        type=Path,
        nargs="+",
        metavar="PATH",
        help="one or more JSON bundle definitions; may be repeated",
    )
    return parser.parse_args()


def load_json(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"cannot read JSON definition {path}: {error}") from error
    return value


def unique_strings(values, field):
    if not isinstance(values, list):
        raise SystemExit(f"{field} must be an array of strings")
    result = []
    seen = set()
    for value in values:
        if not isinstance(value, str) or not value or len(value) > 128:
            raise SystemExit(f"{field} contains an invalid string")
        if value not in seen:
            result.append(value)
            seen.add(value)
    return result


def definition_objects(value, source):
    if isinstance(value, list):
        definitions = value
    elif isinstance(value, dict):
        definitions = [value]
    else:
        raise SystemExit(f"{source}: JSON root must be an object or array")
    if not definitions or any(not isinstance(item, dict) for item in definitions):
        raise SystemExit(f"{source}: every bundle definition must be an object")
    return definitions


def validate_endpoint(endpoint, source):
    if not isinstance(endpoint, dict):
        raise SystemExit(f"{source}: endpoint must be an object")
    forbidden = sorted(FORBIDDEN_ENDPOINT_FIELDS.intersection(endpoint))
    if forbidden:
        raise SystemExit(f"{source}: endpoint contains forbidden fields: {', '.join(forbidden)}")
    required = {"name", "protocol", "port"}
    if set(endpoint) != required:
        raise SystemExit(f"{source}: endpoint must contain only name, protocol and port")
    name, protocol, port = endpoint["name"], endpoint["protocol"], endpoint["port"]
    if not isinstance(name, str) or not IDENTIFIER.fullmatch(name):
        raise SystemExit(f"{source}: endpoint name is invalid")
    if not isinstance(protocol, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9+.-]{0,31}", protocol):
        raise SystemExit(f"{source}: endpoint protocol is invalid")
    if type(port) is not int or not 1 <= port <= 65535:
        raise SystemExit(f"{source}: endpoint port must be between 1 and 65535")
    return {"name": name, "protocol": protocol, "port": port}


def compose_definitions(paths):
    bundles = [BUNDLE_ID]
    required_capabilities = list(DEFAULT_REQUIRED_CAPABILITIES)
    services = list(DEFAULT_SERVICES)
    endpoints = list(DEFAULT_ENDPOINTS)
    readiness = dict(DEFAULT_READINESS)
    min_image_level = 1
    endpoint_names = {endpoint["name"] for endpoint in endpoints}
    endpoint_ports = {endpoint["port"] for endpoint in endpoints}

    for path in paths:
        for definition in definition_objects(load_json(path), str(path)):
            unknown = set(definition) - CAPABILITY_FIELDS - INPUT_METADATA_FIELDS
            if unknown:
                names = ", ".join(sorted(unknown))
                raise SystemExit(f"{path}: unsupported manifest fields: {names}")
            if "required_capabilities" not in definition:
                raise SystemExit(f"{path}: required_capabilities must be declared explicitly")
            for field in CAPABILITY_FIELDS:
                if field not in definition:
                    continue
                value = definition[field]
                if field == "endpoints":
                    if not isinstance(value, list):
                        raise SystemExit(f"{path}: endpoints must be an array")
                    for raw_endpoint in value:
                        endpoint = validate_endpoint(raw_endpoint, str(path))
                        if endpoint["name"] in endpoint_names:
                            raise SystemExit(f"{path}: duplicate endpoint name {endpoint['name']}")
                        if endpoint["port"] in endpoint_ports:
                            raise SystemExit(f"{path}: duplicate endpoint port {endpoint['port']}")
                        endpoints.append(endpoint)
                        endpoint_names.add(endpoint["name"])
                        endpoint_ports.add(endpoint["port"])
                elif field == "readiness":
                    if not isinstance(value, dict):
                        raise SystemExit(f"{path}: readiness must be an object")
                    for name, check in value.items():
                        if not isinstance(name, str) or not isinstance(check, str) or not check:
                            raise SystemExit(f"{path}: readiness entries must map names to strings")
                        if name in readiness and readiness[name] != check:
                            raise SystemExit(f"{path}: conflicting readiness for {name}")
                        readiness[name] = check
                elif field == "bundles":
                    values = unique_strings(value, "bundles")
                    for bundle_id in values:
                        if not IDENTIFIER.fullmatch(bundle_id):
                            raise SystemExit(f"{path}: bundle identifier is invalid: {bundle_id}")
                        if bundle_id not in bundles:
                            bundles.append(bundle_id)
                else:
                    values = unique_strings(value, field)
                    target = required_capabilities if field == "required_capabilities" else services
                    for item in values:
                        if item not in target:
                            target.append(item)
            if "min_image_level" in definition:
                level = definition["min_image_level"]
                if type(level) is not int or level < 1:
                    raise SystemExit(f"{path}: min_image_level must be a positive integer")
                min_image_level = max(min_image_level, level)
            if definition.get("profile") not in (None, "pi-execution"):
                raise SystemExit(f"{path}: only the pi-execution profile is supported")

    unknown_readiness = set(readiness) - endpoint_names
    if unknown_readiness:
        names = ", ".join(sorted(unknown_readiness))
        raise SystemExit(f"readiness names no longer have endpoints: {names}")
    return {
        "bundles": bundles,
        "required_capabilities": required_capabilities,
        "services": services,
        "endpoints": endpoints,
        "readiness": readiness,
        "min_image_level": min_image_level,
    }


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def build(binary, output, definitions):
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise SystemExit("session-service binary must be an executable file")
    output.mkdir(parents=True, exist_ok=True)
    runtime = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix=".bundle-", dir=output) as temporary:
        stage = Path(temporary)
        payload = stage / "payload"
        for path, source in {
            "bin/ursi-session-service": binary,
            "supervisor/supervisord.conf": runtime / "bundle/process-supervisor/supervisord.conf",
            "supervisor/recovery.py": runtime / "bundle/process-supervisor/recovery.py",
        }.items():
            target = payload / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o755 if path.startswith("bin/") else 0o644)
        files = {
            str(path.relative_to(payload)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(payload.rglob("*"))
            if path.is_file()
        }
        capability_manifest = {
            "bundles": definitions["bundles"],
            "required_capabilities": definitions["required_capabilities"],
            "services": definitions["services"],
            "endpoints": definitions["endpoints"],
            "readiness": definitions["readiness"],
        }
        version = hashlib.sha256(canonical_json({"files": files, **capability_manifest})).hexdigest()
        manifest = {
            "version": version,
            "min_image_level": definitions["min_image_level"],
            "profile": "pi-execution",
            "files": files,
            **capability_manifest,
        }
        (payload / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        archive = stage / "runtime-bundle.tar.gz"
        with archive.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as tar:
                for path in sorted(payload.rglob("*")):
                    info = tar.gettarinfo(str(path), str(path.relative_to(payload)))
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = "root"
                    info.mode = (
                        0o755
                        if path.is_dir() or str(path.relative_to(payload)).startswith("bin/")
                        else 0o644
                    )
                    if path.is_file():
                        with path.open("rb") as data:
                            tar.addfile(info, data)
                    else:
                        tar.addfile(info)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.replace(output / archive.name)
        (output / "runtime-bundle.sha256").write_text(
            digest + "  runtime-bundle.tar.gz\n", encoding="utf-8"
        )
        print(digest)


def main():
    args = parse_args()
    paths = list(args.manifest or [])
    for group in args.bundles or []:
        paths.extend(group)
    build(args.session_service.resolve(), args.output_dir.resolve(), compose_definitions(paths))


if __name__ == "__main__":
    main()
