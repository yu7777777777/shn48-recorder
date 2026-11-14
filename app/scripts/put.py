#!/usr/bin/env python3
"""Upload one local file to the production server.

Companion to remote.py, for pushing a helper script before running it. Credentials
come from the same local file and are never printed.
"""
import re
import sys
from pathlib import Path

import paramiko

CREDENTIALS = Path("阿里云服务器.txt")


def load_credentials() -> dict:
    text = CREDENTIALS.read_text(encoding="utf-8")
    fields = {}
    for line in text.splitlines():
        match = re.match(r"^\s*([^:：]+)\s*[:：]\s*(.+?)\s*$", line)
        if match:
            fields[match.group(1).strip()] = match.group(2).strip()
    return fields


def main() -> int:
    if len(sys.argv) < 3:
        sys.exit("usage: python scripts/put.py <local> <remote-abs-path>")

    local, remote = Path(sys.argv[1]), sys.argv[2]
    if not local.is_file():
        sys.exit(f"local file not found: {local}")

    creds = load_credentials()
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(
        creds["ip"],
        port=int(creds.get("端口", "22")),
        username=creds.get("用户名", "root"),
        password=creds["密码"],
        timeout=25,
    )
    try:
        # The remote parent must exist before sftp.put.
        parent = remote.rsplit("/", 1)[0]
        client.exec_command(f"mkdir -p {parent}")[1].channel.recv_exit_status()
        sftp = client.open_sftp()
        try:
            sftp.put(str(local), remote)
        finally:
            sftp.close()
        print(f"uploaded {local} -> {remote}")
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
