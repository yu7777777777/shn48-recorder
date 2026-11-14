#!/usr/bin/env python3
"""Single-request 115 worker. See worker-protocol.md; never logs provider payloads."""
from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import warnings

VERSION = "0.0.9.6.5.1"
PART_SIZE = 16 * 1024 * 1024
MAX_INPUT = 65536
MESSAGES = {
    "unauthorized": "Authorization required; waiting for explicit QR login.",
    "quota": "Provider storage or upload quota exceeded.",
    "network": "Provider connection failed; retry later.",
    "mismatch": "Remote metadata or account does not match expectations.",
    "source_changed": "Source file changed or does not match its declared size/hash.",
    "provider_error": "Provider operation failed.",
    "invalid_request": "Invalid worker request.",
    "invalid_path": "Path is outside the permitted root or contains invalid components.",
    "runtime_unavailable": "Python >=3.12 and the pinned p115client distribution are required.",
    "state_error": "Private worker state is unavailable or unsafe.",
}


class WorkerError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(MESSAGES[code])


def fail(code):
    raise WorkerError(code)


def mapped_error(exc):
    if isinstance(exc, WorkerError):
        return exc
    names = {c.__name__ for c in type(exc).__mro__}
    if names & {"P115AuthenticationError", "P115LoginError", "P115AccessTokenError"}:
        return WorkerError("unauthorized")
    if names & {"P115NoSpaceError", "P115ExceededError", "P115FileTooBig"}:
        return WorkerError("quota")
    if isinstance(exc, (TimeoutError, ConnectionError)) or names & {
        "RequestError", "TransportError", "TimeoutException", "HTTPError", "URLError"
    }: # Inspect types only, never the SDK exception text/response.
        return WorkerError("network")
    return WorkerError("provider_error")


def no_symlinks(path):
    path = Path(os.path.abspath(path))
    for part in [path, *path.parents]:
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            fail("invalid_path")
    return path


def inside(path, root):
    return path == root or root in path.parents


def open_source(path):
    """Open every path component without following links on the Linux target."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    if os.open not in os.supports_dir_fd:
        return os.open(path, flags)
    directory = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        return os.open(path.name, flags, dir_fd=directory)
    finally:
        os.close(directory)


def segment(value):
    if (not isinstance(value, str) or not value or value in (".", "..")
            or len(value) > 255 or value != value.strip()
            or any(ord(c) < 32 or ord(c) == 127 or c in "/\\<>:\"|?*" for c in value)):
        fail("invalid_path")
    return value


def remote_path(value):
    if not isinstance(value, str) or not value.startswith("/") or value == "/":
        fail("invalid_path")
    parts = value[1:].split("/")
    if len(parts) > 25:
        fail("invalid_path")
    for item in parts:
        segment(item)
    return "/" + "/".join(parts)


def identifier(value):
    if isinstance(value, bool) or not re.fullmatch(r"[1-9][0-9]*", str(value)):
        fail("invalid_request")
    return str(value)


def runtime():
    if sys.version_info < (3, 12):
        return None
    try:
        if importlib.metadata.version("p115client") != VERSION:
            return None
        # Importing the SDK reads its user-key cache; status must not import it.
        return True if importlib.util.find_spec("p115client") is not None else None
    except Exception:
        return None


def qr_wait_timeout(exc):
    seen = set()
    for _ in range(5):
        if exc is None or id(exc) in seen:
            break
        seen.add(id(exc))
        names = {c.__name__ for c in type(exc).__mro__}
        if names & {"ReadTimeout", "ReadTimeoutError"}:
            return True
        if getattr(exc, "errno", None) == 990009:
            return True
        exc = getattr(exc, "reason", None) or exc.__cause__ or exc.__context__
    return False


class Worker:
    def __init__(self, emit=lambda event: None):
        data = Path(os.environ.get("DATA_DIR", "data"))
        self.state = no_symlinks(os.environ.get("BACKUP115_DIR", str(data / "backup115")))
        self.cookie = self.state / "cookies.json"
        self.emit = emit

    def private_state(self):
        no_symlinks(self.state)
        try:
            self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
            if not self.state.is_dir():
                fail("state_error")
            os.chmod(self.state, 0o700)
        except OSError:
            fail("state_error")

    def load_sdk(self):
        self.private_state()
        # SDK const.py hard-codes ~/.p115client.cache.d and util.py reads it on import.
        # Isolate it before import so no host user-key/cookie cache is ever consulted.
        os.environ["HOME"] = str(self.state)
        os.environ["USERPROFILE"] = str(self.state)
        os.umask(0o077)
        cache = self.state / ".p115client.cache.d"
        no_symlinks(cache)
        for name in ("pickcode_stable_points.json", "userkey_stable_points.json"):
            no_symlinks(cache / name)
            no_symlinks(cache / (name + ".lock"))
        try:
            from p115client import P115Client, check_response
            from p115client.fs import P115FileSystem
            return P115Client, check_response, P115FileSystem
        except Exception:
            fail("runtime_unavailable")

    def cookie_exists(self):
        no_symlinks(self.cookie)
        try:
            return stat.S_ISREG(self.cookie.stat().st_mode) and self.cookie.stat().st_size > 0
        except FileNotFoundError:
            return False

    def save_cookie(self, cookies):
        self.private_state()
        no_symlinks(self.cookie)
        fd, name = tempfile.mkstemp(prefix=".cookies-", dir=self.state)
        temporary = Path(name)
        try:
            os.chmod(temporary, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump({"cookies": cookies}, output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.cookie)
            os.chmod(self.cookie, 0o600)
            if os.name == "posix":
                dirfd = os.open(self.state, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(dirfd)
                finally:
                    os.close(dirfd)
        finally:
            if temporary.exists():
                temporary.unlink()

    def client(self, sdk):
        if not self.cookie_exists():
            fail("unauthorized")
        try:
            fd = os.open(self.cookie, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, encoding="utf-8") as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                    fail("state_error")
                cookies = json.load(source)["cookies"]
            if not isinstance(cookies, (str, dict)) or not cookies:
                fail("unauthorized")
        except (OSError, ValueError, KeyError):
            fail("state_error")
        # None would launch an interactive login; never pass None or a PathLike.
        return sdk[0](cookies=cookies, console_qrcode=False)

    def connection(self, client, sdk):
        if not client.login_status():
            fail("unauthorized")
        response = sdk[1](client.user_info())
        data = response.get("data")
        if not isinstance(data, dict):
            fail("provider_error")
        info = data.get("user_info", data)
        if not isinstance(info, dict):
            fail("provider_error")
        try:
            account = identifier(info.get("user_id", info.get("uid", info.get("id", ""))))
        except WorkerError:
            fail("provider_error")
        # Remote identity must match cookie identity as well.
        if account != str(client.user_id):
            fail("mismatch")
        # Do not echo provider labels (untrusted and potentially sensitive).
        return {"runtimeAvailable": True, "authorized": True, "accountId": account,
                "accountLabel": "115 ***" + account[-4:], "message": "Authorized."}

    def phase(self, name):
        self.emit({"type": "progress", "phase": name})

    @contextlib.contextmanager
    def source(self, request):
        raw = request.get("localPath")
        if not isinstance(raw, str) or not os.path.isabs(raw):
            fail("invalid_path")
        try:
            path = no_symlinks(raw).resolve(strict=True)
        except FileNotFoundError:
            fail("source_changed")
        roots = []
        if os.environ.get("RECORDINGS_DIR"):
            roots.append(no_symlinks(os.environ["RECORDINGS_DIR"]).resolve())
        metadata = no_symlinks(self.state / "files").resolve()
        allowed = inside(path, metadata) or any(inside(path, root) for root in roots)
        # State credentials must never become upload sources, even with a broad recording root.
        if not allowed or (inside(path, self.state) and not inside(path, metadata)):
            fail("invalid_path")
        before = path.stat()
        if not stat.S_ISREG(before.st_mode):
            fail("invalid_path")
        fd = open_source(path)
        with os.fdopen(fd, "rb") as source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                fail("source_changed")
            no_symlinks(path)
            if path.resolve(strict=True) != path:
                fail("source_changed")
            size = request.get("size")
            sha1 = request.get("sha1")
            if type(size) is not int or size < 0 or not isinstance(sha1, str) or not re.fullmatch(r"[a-fA-F0-9]{40}", sha1):
                fail("invalid_request")
            def verify():
                current = os.fstat(source.fileno())
                if current.st_size != size or (current.st_mtime_ns, current.st_ctime_ns) != (opened.st_mtime_ns, opened.st_ctime_ns):
                    fail("source_changed")
                source.seek(0)
                digest = hashlib.file_digest(source, "sha1").hexdigest()
                if digest.upper() != sha1.upper():
                    fail("source_changed")
                source.seek(0)
            verify()
            yield source, verify
            verify()

    def ensure_directory(self, client, fs, sdk, path):
        parent = 0
        for name in path[1:].split("/"):
            matches = [a for a in fs.iterdir(parent) if a.get("name") == name]
            if not matches:
                sdk[1](client.fs_mkdir(name, pid=parent))
                matches = [a for a in fs.iterdir(parent) if a.get("name") == name]
            if len(matches) != 1 or not matches[0].get("is_dir"):
                fail("mismatch")
            parent = int(identifier(matches[0].get("id")))
        return parent

    def verified_remote(self, fs, fid, parent, name, size, sha1, path):
        # By-ID fresh query is mandatory; do not verify against upload callback or cached listing.
        try:
            attr = fs.get_attr(int(identifier(fid)), refresh=True)
        except FileNotFoundError:
            fail("mismatch")
        needed = {"id", "parent_id", "name", "size", "sha1", "is_dir"}
        if not needed.issubset(attr):
            fail("mismatch")
        if (attr["is_dir"] or str(attr["id"]) != str(fid) or str(attr["parent_id"]) != str(parent)
                or attr["name"] != name or type(attr["size"]) is not int or attr["size"] != size
                or not isinstance(attr["sha1"], str) or attr["sha1"].upper() != sha1.upper()):
            fail("mismatch")
        return {"fileId": str(attr["id"]), "parentId": str(parent), "name": name,
                "size": size, "sha1": sha1.upper(), "path": path + "/" + name}

    def upload(self, request, sdk):
        directory = remote_path(request.get("remoteDir"))
        root = remote_path(os.environ.get("BACKUP115_REMOTE_ROOT", "/48tools"))
        if directory != root and not directory.startswith(root + "/"):
            fail("invalid_path")
        name = segment(request.get("filename"))
        expected = identifier(request.get("expectedAccountId"))
        self.phase("validating_source")
        with self.source(request) as (source, verify):
            client = self.client(sdk)
            self.phase("checking_account")
            connection = self.connection(client, sdk)
            if connection["accountId"] != expected:
                fail("mismatch")
            fs = sdk[2](client, refresh=True)
            self.phase("ensuring_directory")
            parent = self.ensure_directory(client, fs, sdk, directory)
            size, sha1 = request["size"], request["sha1"]
            fid = request.get("remoteFileId")
            if fid is not None:
                fid = identifier(fid)
            else:
                self.phase("checking_existing")
                candidates = [a for a in fs.iterdir(parent) if a.get("name") == name and not a.get("is_dir")
                              and a.get("size") == size and str(a.get("sha1", "")).upper() == sha1.upper()]
                if candidates:
                    fid = identifier(candidates[0].get("id"))
                else:
                    self.phase("uploading")
                    sdk[1](client.upload_file(source, pid=parent, filename=name, filesha1=sha1.upper(),
                                             filesize=size, partsize=PART_SIZE))
                    # Callback schema varies by fast-upload/multipart. Resolve via fresh listing, then verify by ID.
                    candidates = [a for a in fs.iterdir(parent) if a.get("name") == name and not a.get("is_dir")
                                  and a.get("size") == size and str(a.get("sha1", "")).upper() == sha1.upper()]
                    if len(candidates) != 1:
                        fail("mismatch")
                    fid = identifier(candidates[0].get("id"))
            self.phase("verifying")
            remote = self.verified_remote(fs, fid, parent, name, size, sha1, directory)
        return {"remote": remote, "verified": True, "accountId": expected}

    def execute(self, request):
        if not isinstance(request, dict):
            fail("invalid_request")
        command = request.get("command")
        fields = {"status": set(), "check": set(), "logout": set(), "qr_start": set(),
                  "qr_poll": {"token", "app"}, "upload": {"localPath", "remoteDir", "filename", "size",
                                                          "sha1", "expectedAccountId", "remoteFileId"}}
        if not isinstance(command, str) or command not in fields or set(request) - fields[command] - {"command"}:
            fail("invalid_request")
        if command == "logout":
            no_symlinks(self.cookie)
            self.cookie.unlink(missing_ok=True)
            return {"authorized": False}
        sdk = runtime()
        if command == "status":
            present = self.cookie_exists()
            return {"runtimeAvailable": sdk is not None, "cookiePresent": present,
                    "authorized": False, "message": "Local status only; authorization not checked."}
        if sdk is None:
            if command == "check":
                return {"runtimeAvailable": False, "authorized": False, "accountId": None,
                        "accountLabel": None, "message": MESSAGES["runtime_unavailable"]}
            fail("runtime_unavailable")
        if sdk is True:
            sdk = self.load_sdk()
        if command == "check":
            try:
                return self.connection(self.client(sdk), sdk)
            except Exception as exc:
                error = mapped_error(exc)
                if error.code != "unauthorized":
                    raise error from None
                return {"runtimeAvailable": True, "authorized": False, "accountId": None,
                        "accountLabel": None, "message": MESSAGES["unauthorized"]}
        if command == "qr_start":
            token = sdk[1](sdk[0].login_qrcode_token(timeout=8, retries=False))["data"]
            payload = {key: token[key] for key in ("uid", "time", "sign")}
            return {"token": payload, "qrUrl": "https://115.com/scan/dg-" + str(payload["uid"]), "expiresIn": 120}
        if command == "qr_poll":
            token = request.get("token")
            if (not isinstance(token, dict) or set(token) != {"uid", "time", "sign"}
                    or not isinstance(token["uid"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", token["uid"])
                    or not isinstance(token["sign"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", token["sign"])
                    or type(token["time"]) is not int):
                fail("invalid_request")
            app = request.get("app", "alipaymini")
            if app not in {"alipaymini", "web", "android", "ios", "qandroid", "ipad", "tv"}:
                fail("invalid_request")
            if not -30 <= time.time() - token["time"] <= 120:
                return {"status": "expired", "connection": None}
            try:
                raw = sdk[0].login_qrcode_scan_status(token, timeout=5, retries=False)
                if isinstance(raw, dict) and any(raw.get(k) == 990009 for k in ("code", "errno", "errNo")):
                    return {"status": "waiting", "connection": None}
                response = sdk[1](raw)
            except Exception as exc:
                if qr_wait_timeout(exc):
                    return {"status": "waiting", "connection": None}
                raise

            status = {0: "waiting", 1: "scanned", 2: "signed_in", -1: "expired", -2: "canceled"}.get(response["data"].get("status"))
            if status is None:
                fail("provider_error")
            connection = None
            if status == "signed_in":
                cookies = sdk[1](sdk[0].login_qrcode_scan_result(token["uid"], app=app))["data"]["cookie"]
                if not isinstance(cookies, (dict, str)) or not cookies:
                    fail("unauthorized")
                client = sdk[0](cookies=cookies, console_qrcode=False)
                connection = self.connection(client, sdk)
                self.save_cookie(cookies)
            return {"status": status, "connection": connection}
        return self.upload(request, sdk)


def main():
    # Keep a dedicated protocol stream; silence even SDK native writes/warnings on fd 1/2.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    with open(os.devnull, "w") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    logging.disable(logging.CRITICAL)
    warnings.filterwarnings("ignore")
    def emit(event):
        protocol.write(json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n")
        protocol.flush()
    try:
        line = sys.stdin.buffer.readline(MAX_INPUT + 1)
        if len(line) > MAX_INPUT or not line.endswith(b"\n"):
            fail("invalid_request")
        request = json.loads(line.decode("utf-8"))
        data = Worker(emit).execute(request)
        emit({"type": "result", "data": data})
        return 0
    except (KeyboardInterrupt, BrokenPipeError):
        return 1
    except Exception as exc:
        error = mapped_error(exc) if not isinstance(exc, (json.JSONDecodeError, UnicodeError)) else WorkerError("invalid_request")
        emit({"type": "error", "code": error.code, "message": MESSAGES[error.code]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
