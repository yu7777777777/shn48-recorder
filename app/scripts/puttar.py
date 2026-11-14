#!/usr/bin/env python3
"""Upload a local tarball and extract it into a remote directory.

Uses the credentials file the same way scripts/put.py does; never prints secrets.
"""
import posixpath
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
        sys.exit("usage: python scripts/puttar.py <local.tar.gz> <remote-dir>")

    local, remote_dir = Path(sys.argv[1]), sys.argv[2].rstrip("/")
    creds = load_credentials()

    # Normalize Windows separators so the uploaded name is just the basename.
    local_name = str(local).replace("\\", "/").rstrip("/").split("/")[-1]
    remote_tar = posixpath.join(remote_dir, local_name)

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
        client.exec_command(f"mkdir -p {remote_dir}")[1].read()

        sftp = client.open_sftp()
        try:
            sftp.put(str(local), remote_tar)
        finally:
            sftp.close()
        print(f"uploaded {local_name} -> {remote_tar}")

        command = (
            f"rm -rf {remote_dir}/extracted && mkdir -p {remote_dir}/extracted && "
            f"tar -xzf {remote_tar} -C {remote_dir}/extracted && "
            f"find {remote_dir}/extracted -type f | wc -l"
        )
        _, out, err = client.exec_command(command)
        count = out.read().decode().strip()
        error = err.read().decode().strip()
        print(f"extracted files: {count}")
        if error:
            print(f"stderr: {error}")
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
