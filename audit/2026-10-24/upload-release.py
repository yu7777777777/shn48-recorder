#!/usr/bin/env python3
"""Upload one local release tarball to a staging directory on the production host.

Reads the same local credentials file as scripts/remote.py, never prints it.
Uses SFTP so large payloads do not pass through a shell command line.
"""
import re
import sys
from pathlib import Path

import paramiko

WORKSPACE = Path(__file__).resolve().parents[2]
CREDENTIALS = WORKSPACE / "阿里云服务器.txt"


def load_credentials() -> dict:
    fields = {}
    for line in CREDENTIALS.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s*([^:：]+)\s*[:：]\s*(.+?)\s*$", line)
        if match:
            fields[match.group(1).strip()] = match.group(2).strip()
    return fields


def main() -> int:
    if len(sys.argv) != 3:
        sys.exit('usage: python upload-release.py <local-tar> <remote-path>')
    local, remote = Path(sys.argv[1]), sys.argv[2]
    creds = load_credentials()
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(creds["ip"], port=int(creds.get("端口", "22")),
                   username=creds.get("用户名", "root"), password=creds["密码"], timeout=25)
    try:
        remote_dir = str(Path(remote).parent)
        client.exec_command(f"mkdir -p {remote_dir}")[1].channel.recv_exit_status()
        sftp = client.open_sftp()
        try:
            sftp.put(str(local), remote)
        finally:
            sftp.close()
        _, stdout, _ = client.exec_command(f"sha256sum {remote}")
        print(stdout.read().decode().strip())
        return stdout.channel.recv_exit_status()
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
