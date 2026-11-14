"""Offline unit tests: fake provider only, never reads real cookies or contacts 115."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

WORKER = Path(__file__).resolve().parents[1] / "modules" / "backup115" / "worker.py"
spec = importlib.util.spec_from_file_location("backup115_worker", WORKER)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class FakeClient:
    user_id = 123456
    nodes = {}
    uploads = []
    statuses = []
    invalid = False
    mutation = None
    qr_status = 0

    def __init__(self, *, cookies, console_qrcode):
        assert cookies and console_qrcode is False

    def login_status(self):
        self.statuses.append(True)
        return not self.invalid

    def user_info(self):
        return {"state": True, "data": {"user_id": self.user_id, "user_name": "NEVER_ECHO"}}

    def fs_mkdir(self, name, pid):
        fid = len(self.nodes) + 1
        self.nodes[fid] = {"id": fid, "parent_id": pid, "name": name, "is_dir": True}
        return {"state": True}

    def upload_file(self, source, **kwargs):
        assert kwargs["partsize"] >= 10 * 1024 * 1024
        assert source.read() == b"recording"
        self.uploads.append(kwargs)
        self.nodes[90] = {"id": 90, "parent_id": kwargs["pid"], "name": kwargs["filename"],
                          "is_dir": False, "size": kwargs["filesize"], "sha1": kwargs["filesha1"]}
        if self.mutation:
            self.mutation()
        return {"state": True, "data": {"sensitive": "NEVER_ECHO"}}

    @staticmethod
    def login_qrcode_token(**kwargs):
        return {"state": True, "data": {"uid": "fakeuid", "time": int(time.time()), "sign": "fakesign"}}

    @classmethod
    def login_qrcode_scan_status(cls, token, **kwargs):
        return {"state": True, "data": {"status": cls.qr_status}}

    @staticmethod
    def login_qrcode_scan_result(uid, app):
        return {"state": True, "data": {"cookie": {"UID": "fake-cookie-for-offline-test"}}}


class FakeFS:
    checks = []
    transform = None

    def __init__(self, client, refresh):
        assert refresh is True

    def iterdir(self, parent):
        return iter([dict(a) for a in FakeClient.nodes.values() if a["parent_id"] == parent])

    def get_attr(self, fid, refresh):
        assert refresh is True
        self.checks.append(fid)
        attr = dict(FakeClient.nodes[fid])
        return self.transform(attr) if self.transform else attr


def checked(response):
    assert response["state"] is True
    return response


SDK = (FakeClient, checked, FakeFS)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="backup115-offline-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.recordings = self.root / "recordings"
        self.recordings.mkdir()
        self.source = self.recordings / "sample.ts"
        self.source.write_bytes(b"recording")
        self.env = patch.dict(os.environ, {"BACKUP115_DIR": str(self.root / "state"),
                                           "RECORDINGS_DIR": str(self.recordings),
                                           "BACKUP115_REMOTE_ROOT": "/48tools"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.fake_runtime = patch.object(w, "runtime", return_value=SDK)
        self.fake_runtime.start()
        self.addCleanup(self.fake_runtime.stop)
        FakeClient.nodes = {}
        FakeClient.uploads = []
        FakeClient.statuses = []
        FakeClient.invalid = False
        FakeClient.mutation = None
        FakeClient.qr_status = 0
        FakeFS.checks = []
        FakeFS.transform = None
        self.events = []
        self.worker = w.Worker(self.events.append)
        self.request = {"command": "upload", "localPath": str(self.source), "remoteDir": "/48tools/test",
                        "filename": "sample.ts", "size": 9, "sha1": hashlib.sha1(b"recording").hexdigest(),
                        "expectedAccountId": "123456"}

    def authorized(self):
        # Artificial test fixture only; no host/provider credentials are accessed.
        self.worker.save_cookie({"UID": "fake-cookie-for-offline-test"})

    def assert_code(self, code, callback):
        with self.assertRaises(w.WorkerError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_status_no_network_and_does_not_claim_authorization(self):
        self.authorized()
        with patch.object(FakeClient, "__init__", side_effect=AssertionError("network")):
            result = self.worker.execute({"command": "status"})
        self.assertTrue(result["cookiePresent"])
        self.assertFalse(result["authorized"])
        self.assertEqual(FakeClient.statuses, [])

    def test_status_probe_does_not_import_sdk_or_create_state(self):
        with patch.object(w, "runtime", return_value=True), patch.object(self.worker, "load_sdk", side_effect=AssertionError("SDK import")):
            result = self.worker.execute({"command": "status"})
        self.assertTrue(result["runtimeAvailable"])
        self.assertFalse(self.worker.state.exists())

    def test_sdk_home_isolated_before_import(self):
        fake_package = type(sys)("p115client")
        fake_package.P115Client = FakeClient
        fake_package.check_response = checked
        fake_fs = type(sys)("p115client.fs")
        fake_fs.P115FileSystem = FakeFS
        with patch.dict(sys.modules, {"p115client": fake_package, "p115client.fs": fake_fs}):
            sdk = self.worker.load_sdk()
        self.assertIs(sdk[0], FakeClient)
        self.assertEqual(os.environ["HOME"], str(self.worker.state))
        self.assertEqual(os.environ["USERPROFILE"], str(self.worker.state))

    def test_status_missing_runtime(self):
        with patch.object(w, "runtime", return_value=None):
            result = self.worker.execute({"command": "status"})
        self.assertFalse(result["runtimeAvailable"])

    def test_check_no_cookie_waits_for_explicit_login(self):
        result = self.worker.execute({"command": "check"})
        self.assertFalse(result["authorized"])
        self.assertEqual(FakeClient.statuses, [])

    def test_check_authorized_and_sanitized(self):
        self.authorized()
        result = self.worker.execute({"command": "check"})
        self.assertEqual(result["accountId"], "123456")
        self.assertNotIn("NEVER_ECHO", json.dumps(result))
        FakeClient.invalid = True
        self.assertFalse(self.worker.execute({"command": "check"})["authorized"])

    def test_unknown_cookie_path_and_unknown_fields_rejected(self):
        for request in ({"command": "check", "cookiePath": "anything"}, {"command": "bogus"}, [],
                        {"command": "qr_start", "app": "web"}, {"command": "upload", "cookies": "fake"}):
            self.assert_code("invalid_request", lambda: self.worker.execute(request))

    def test_upload_new_fixed_partsize_fresh_id_verification_local_retained(self):
        self.authorized()
        result = self.worker.execute(self.request)
        self.assertEqual(result["remote"]["fileId"], "90")
        self.assertEqual(result["remote"]["path"], "/48tools/test/sample.ts")
        self.assertTrue(result["verified"])
        self.assertEqual(len(FakeClient.uploads), 1)
        self.assertEqual(FakeFS.checks, [90])
        self.assertTrue(self.source.exists())
        self.assertTrue(all(set(event) == {"type", "phase"} for event in self.events))

    def test_existing_same_hash_skips_upload_and_still_fresh_verifies(self):
        self.authorized()
        self.worker.execute(self.request)
        FakeClient.uploads.clear()
        self.worker.execute(self.request)
        self.assertEqual(FakeClient.uploads, [])
        self.assertEqual(FakeFS.checks, [90, 90])

    def test_remote_file_id_verified_not_trusted(self):
        self.authorized()
        self.worker.execute(self.request)
        FakeClient.uploads.clear()
        request = dict(self.request, remoteFileId="90")
        self.worker.execute(request)
        self.assertEqual(FakeClient.uploads, [])
        FakeClient.nodes[90]["size"] = 8
        self.assert_code("mismatch", lambda: self.worker.execute(request))

    def test_all_required_remote_fields_fail_closed(self):
        self.authorized()
        self.worker.execute(self.request)
        for key in ("id", "size", "sha1", "parent_id", "name", "is_dir"):
            with self.subTest(key=key):
                FakeFS.transform = staticmethod(lambda attr, key=key: {k: v for k, v in attr.items() if k != key})
                self.assert_code("mismatch", lambda: self.worker.execute(self.request))
        FakeFS.transform = None

    def test_wrong_hash_or_parent_fail_fresh_verification(self):
        self.authorized()
        self.worker.execute(self.request)
        for key, value in (("sha1", "0" * 40), ("parent_id", 999), ("name", "wrong.ts"), ("size", 123)):
            FakeFS.transform = staticmethod(lambda attr, key=key, value=value: dict(attr, **{key: value}))
            self.assert_code("mismatch", lambda: self.worker.execute(self.request))
        FakeFS.transform = None

    def test_account_mismatch_no_upload(self):
        self.authorized()
        self.assert_code("mismatch", lambda: self.worker.execute(dict(self.request, expectedAccountId="999")))
        self.assertEqual(FakeClient.uploads, [])
        self.assertEqual(FakeClient.nodes, {})

    def test_source_size_hash_and_ordinary_file(self):
        self.authorized()
        for request in (dict(self.request, size=10), dict(self.request, sha1="0" * 40)):
            self.assert_code("source_changed", lambda: self.worker.execute(request))
        self.assert_code("invalid_path", lambda: self.worker.execute(dict(self.request, localPath=str(self.recordings))))
        self.assertEqual(FakeClient.uploads, [])

    def test_missing_source_and_missing_remote_fail_closed(self):
        self.authorized()
        self.assert_code("source_changed", lambda: self.worker.execute(dict(self.request, localPath=str(self.recordings / "missing.ts"))))
        self.worker.execute(self.request)
        with patch.object(FakeFS, "get_attr", side_effect=FileNotFoundError("DO NOT ECHO")):
            self.assert_code("mismatch", lambda: self.worker.execute(self.request))

    def test_source_mutation_during_upload_fails(self):
        self.authorized()
        FakeClient.mutation = staticmethod(lambda: self.source.write_bytes(b"changed!!"))
        self.assert_code("source_changed", lambda: self.worker.execute(self.request))

    def test_local_root_escape_and_prefix_confusion(self):
        outside = self.root / "recordings-other"
        outside.mkdir()
        file = outside / "sample.ts"
        file.write_bytes(b"recording")
        self.assert_code("invalid_path", lambda: self.worker.execute(dict(self.request, localPath=str(file))))

    def test_metadata_root_allowed_but_private_state_excluded(self):
        self.authorized()
        files = self.worker.state / "files"
        files.mkdir()
        metadata = files / "metadata.json"
        metadata.write_bytes(b"recording")
        self.worker.execute(dict(self.request, localPath=str(metadata)))
        with patch.dict(os.environ, {"RECORDINGS_DIR": str(self.root)}):
            self.assert_code("invalid_path", lambda: self.worker.execute(dict(self.request, localPath=str(self.worker.cookie))))

    def test_symlink_escape(self):
        outside = self.root / "outside.ts"
        outside.write_bytes(b"recording")
        link = self.recordings / "link.ts"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("Host does not permit symlink creation")
        self.assert_code("invalid_path", lambda: self.worker.execute(dict(self.request, localPath=str(link))))

    def test_remote_path_invalid_segments_and_root(self):
        for path in ("/other", "/48tools2/test", "/48tools/../other", "/48tools/", "/48tools//x",
                     "/48tools/./x", "/48tools/x\\y", "/48tools/a<", "/48tools/ x", "relative", "/"):
            with self.subTest(path=path):
                self.assert_code("invalid_path", lambda: self.worker.execute(dict(self.request, remoteDir=path)))

    def test_logout_only_fixed_cookie_and_idempotent(self):
        self.authorized()
        keep = self.worker.state / "keep.json"
        keep.write_text("test fixture")
        self.worker.execute({"command": "logout"})
        self.assertFalse(self.worker.cookie.exists())
        self.assertTrue(keep.exists())
        self.worker.execute({"command": "logout"})

    def test_atomic_cookie_permissions_and_no_temporary_residue(self):
        self.authorized()
        self.assertEqual(list(self.worker.state.glob(".cookies-*")), [])
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(self.worker.cookie.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(self.worker.state.stat().st_mode), 0o700)

    def test_qr_states_and_cookie_never_returned(self):
        start = self.worker.execute({"command": "qr_start"})
        self.assertEqual(start["expiresIn"], 120)
        for code, status in ((0, "waiting"), (1, "scanned"), (-1, "expired"), (-2, "canceled"), (2, "signed_in")):
            FakeClient.qr_status = code
            result = self.worker.execute({"command": "qr_poll", "token": start["token"]})
            self.assertEqual(result["status"], status)
            self.assertNotIn("fake-cookie", json.dumps(result))
        self.assertTrue(self.worker.cookie_exists())

    def test_qr_long_poll_read_timeout_remains_waiting_with_bounded_request(self):
        token = self.worker.execute({"command": "qr_start"})["token"]
        timeout = type("ReadTimeoutError", (Exception,), {})("private provider text")
        wrapper = type("MaxRetryError", (Exception,), {})("private URL")
        wrapper.reason = timeout
        for exc in (timeout, wrapper):
            with patch.object(FakeClient, "login_qrcode_scan_status", side_effect=exc) as request:
                self.assertEqual(self.worker.execute({"command": "qr_poll", "token": token}), {"status": "waiting", "connection": None})
                self.assertEqual(request.call_args.kwargs, {"timeout": 5, "retries": False})

    def test_qr_provider_long_poll_code_is_waiting_not_authentication(self):
        token = self.worker.execute({"command": "qr_start"})["token"]
        with patch.object(FakeClient, "login_qrcode_scan_status", return_value={"state": False, "code": 990009}):
            self.assertEqual(self.worker.execute({"command": "qr_poll", "token": token})["status"], "waiting")
        self.assertFalse(self.worker.cookie_exists())

    def test_qr_connection_failures_are_not_hidden_as_waiting(self):
        token = self.worker.execute({"command": "qr_start"})["token"]
        with patch.object(FakeClient, "login_qrcode_scan_status", side_effect=ConnectionError("private URL")):
            with self.assertRaises(ConnectionError):
                self.worker.execute({"command": "qr_poll", "token": token})
        self.assertFalse(self.worker.cookie_exists())

    def test_qr_expired_rejected_without_provider(self):
        token = {"uid": "fakeuid", "time": int(time.time()) - 200, "sign": "fake"}
        with patch.object(FakeClient, "login_qrcode_scan_status", side_effect=AssertionError("network")):
            self.assertEqual(self.worker.execute({"command": "qr_poll", "token": token})["status"], "expired")

    def test_error_mapping_never_uses_exception_text(self):
        for name, code in (("P115AuthenticationError", "unauthorized"), ("P115NoSpaceError", "quota"),
                           ("ReadTimeout", "provider_error"), ("RequestError", "network")):
            exc = type(name, (Exception,), {})("COOKIE AND URL SHOULD NEVER ESCAPE")
            mapped = w.mapped_error(exc)
            self.assertEqual(mapped.code, code)
            self.assertNotIn("COOKIE", str(mapped))

    def protocol(self, line):
        return subprocess.run([sys.executable, "-B", str(WORKER)], input=line, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, env=dict(os.environ), timeout=20)

    def test_protocol_status_offline_valid_ndjson_and_empty_stderr(self):
        result = self.protocol(b'{"command":"status"}\n')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")
        event = json.loads(result.stdout)
        self.assertEqual(event["type"], "result")
        self.assertFalse(event["data"]["cookiePresent"])

    def test_protocol_bad_json_and_missing_newline(self):
        for line in (b"not json\n", b'{"command":"status"}', b'{"command":"check","cookiePath":"secret"}\n', b"x" * 65537 + b"\n"):
            result = self.protocol(line)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, b"")
            event = json.loads(result.stdout)
            self.assertEqual(event["type"], "error")
            self.assertEqual(event["code"], "invalid_request")
            self.assertNotIn("secret", result.stdout.decode())


if __name__ == "__main__":
    unittest.main(verbosity=2)
