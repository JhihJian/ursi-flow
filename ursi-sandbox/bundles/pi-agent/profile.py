"""Image-side checks specific to the pi-execution profile."""
import os

NAME = "pi-execution"


def check_config(config):
    for name in ("session-token", "session.json", "pi/models.json"):
        path = config / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"missing regular config file: {name}")
    if len((config / "session-token").read_text(encoding="utf-8").strip()) < 32:
        raise ValueError("session-token must contain at least 32 characters")


def check_payload(destination):
    binary = destination / "bin/ursi-session-service"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError("session service is missing or not executable")
