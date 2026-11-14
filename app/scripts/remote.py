#!/usr/bin/env python3
"""Run one read-only or staging command on the production server.

Reads the connection details from the local credentials file, which is never
printed: only the command output is shown. The password is passed to paramiko
directly and never appears on a command line or in this process's arguments.

Usage:
    python scripts/remote.py "<shell command>"
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
        # Accept both ASCII and full-width colons, which the file mixes.
        match = re.match(r"^\s*([^:：]+)\s*[:：]\s*(.+?)\s*$", line)
        if match:
            fields[match.group(1).strip()] = match.group(2).strip()
    return fields


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit('usage: python scripts/remote.py "<command>"')

    creds = load_credentials()
    host = creds.get("ip")
    user = creds.get("用户名", "root")
    password = creds.get("密码")
    port = int(creds.get("端口", "22"))
    if not (host and password):
        sys.exit("credentials file is missing the host or password")

    client = paramiko.SSHClient()
    client.load_system_host_keys()
    # The host key was just recorded via ssh-keyscan; trust-on-repeat is still
    # refused so a future key change is visible rather than silent.
    client.set_missing_host_key_policy(paramiko.RejectPolicy())

    client.connect(host, port=port, username=user, password=password, timeout=25)
    try:
        _, stdout, stderr = client.exec_command(sys.argv[1], timeout=600)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        status = stdout.channel.recv_exit_status()
        # The Windows console is GBK, so a remote message containing a non-GBK
        # symbol (a check mark, an emoji) would abort the print with
        # UnicodeEncodeError and hide the command's real output. Replace what the
        # console cannot encode instead.
        def emit(text: str, stream) -> None:
            encoding = getattr(stream, "encoding", None) or "utf-8"
            stream.write(text.encode(encoding, "replace").decode(encoding, "replace"))

        if out:
            emit(out, sys.stdout)
        if err:
            emit(err, sys.stderr)
        return status
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
