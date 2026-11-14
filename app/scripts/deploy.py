#!/usr/bin/env python3
"""Upload and stage a release package on the production server.

Credentials come from the environment, never from a file inside the working
tree:

    SHN48_HOST       host or IP of the production server
    SHN48_USER       ssh user (default: root)
    SHN48_PASSWORD   ssh password (prefer SHN48_KEYFILE instead)
    SHN48_KEYFILE    path to a private key, if using key auth
    SHN48_KNOWN_HOSTS  path to a known_hosts file (optional but recommended)

Usage:

    python deploy.py <local-archive> <remote-dir> [--extract]

``<remote-dir>`` is relative to /opt/shn48, for example
``releases/1.18.0``. With ``--extract`` the archive is also unpacked into a
sibling staging directory.

Host key checking is enabled by default: the previous AutoAddPolicy silently
trusted any host key, which defeats the point of the transport being encrypted.
"""
import argparse
import os
import posixpath
import sys

import paramiko

BASE_DIR = "/opt/shn48"


def connect() -> paramiko.SSHClient:
    host = os.environ.get("SHN48_HOST")
    if not host:
        sys.exit("SHN48_HOST is not set")

    user = os.environ.get("SHN48_USER", "root")
    password = os.environ.get("SHN48_PASSWORD")
    keyfile = os.environ.get("SHN48_KEYFILE")
    if not password and not keyfile:
        sys.exit("set SHN48_PASSWORD or SHN48_KEYFILE")

    client = paramiko.SSHClient()

    known_hosts = os.environ.get("SHN48_KNOWN_HOSTS")
    if known_hosts:
        client.load_host_keys(os.path.expanduser(known_hosts))
    else:
        # Fall back to the user's own known_hosts; still reject unknown hosts.
        client.load_system_host_keys()

    client.set_missing_host_key_policy(paramiko.RejectPolicy())

    kwargs = {"port": int(os.environ.get("SHN48_PORT", "22")), "username": user, "timeout": 20}
    if keyfile:
        kwargs["key_filename"] = os.path.expanduser(keyfile)
    else:
        kwargs["password"] = password

    client.connect(host, **kwargs)
    return client


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", help="local archive to upload")
    parser.add_argument("remote_dir", help="directory under /opt/shn48")
    parser.add_argument("--extract", action="store_true",
                        help="also unpack the archive next to it")
    args = parser.parse_args()

    if not os.path.isfile(args.archive):
        sys.exit(f"local archive not found: {args.archive}")

    ssh = connect()
    try:
        remote_target = posixpath.join(BASE_DIR, args.remote_dir.lstrip("/"))
        # posixpath.basename does not treat backslashes as separators, so on
        # Windows a path like "release\stage.tar.gz" would arrive as the single
        # name "releasestage.tar.gz". Normalise the separator first.
        local_name = args.archive.replace("\\", "/").rstrip("/").split("/")[-1]
        remote_file = posixpath.join(remote_target, local_name)

        # Create the directory before the transfer so sftp.put cannot fail on a
        # missing parent.
        ssh.exec_command(f"mkdir -p {remote_target}")[1].channel.recv_exit_status()

        sftp = ssh.open_sftp()
        try:
            sftp.put(args.archive, remote_file)
        finally:
            sftp.close()
        print(f"uploaded {args.archive} -> {remote_file}")

        if args.extract:
            staging = posixpath.join(BASE_DIR, "deploy", args.remote_dir.lstrip("/").split("/")[-1])
            cmd = (
                f"set -e; rm -rf {staging}; mkdir -p {staging}; "
                f"tar -xzf {remote_file} -C {staging}; echo EXTRACTED"
            )
            _, out, err = ssh.exec_command(cmd)
            status = out.channel.recv_exit_status()
            print(out.read().decode())
            stderr = err.read().decode()
            if stderr:
                print(stderr, file=sys.stderr)
            if status != 0:
                return status
    finally:
        ssh.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
