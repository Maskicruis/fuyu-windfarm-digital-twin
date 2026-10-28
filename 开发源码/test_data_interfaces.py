import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request

from data_interfaces import InterfaceError, InterfaceStore, NoRedirect, MAX_REPLY


class MemoryVault:
    def __init__(self):
        self.data = {}

    def __call__(self, scope):
        key = str(scope)
        store = self.data

        class Vault:
            def read(self):
                return store.get(key, "")

            def write(self, value):
                store[key] = value

        return Vault()


class Response(io.BytesIO):
    def __init__(self, value=None, *, raw=None, headers=None, status=200):
        super().__init__(raw if raw is not None else json.dumps(value, ensure_ascii=False).encode("utf-8"))
        self.status = status
        self.headers = headers if headers is not None else {"Content-Type": "application/json"}


class Opener:
    def __init__(self, result):
        self.result = result
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class InterfaceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.vault = MemoryVault()
        self.opener = Opener(Response([]))
        self.store = InterfaceStore(self.root, self.opener, vault_factory=self.vault)

    def tearDown(self):
        self.folder.cleanup()

    def save(self, **patch):
        config = {"name": "进度接口", "url": "https://example.com/progress?project=fuyu", "unit": "WT",
                  "arrayPath": "data.items", "idField": "id", "fields": {"percent": "actual", "planned": "plan"}}
        config.update(patch)
        return self.store.save(config)["interface"]

    def response(self, value, **kwargs):
        self.opener.result = Response(value, **kwargs)

    def test_empty_persistence_and_nonsecret_configuration(self):
        self.assertEqual(self.store.list(), {"interfaces": []})
        row = self.save(apiKey="dummy-private-bearer")
        self.assertRegex(row["id"], r"^[a-f0-9]{32}$")
        self.assertTrue(row["hasApiKey"])
        self.assertNotIn("apiKey", row)
        raw = (self.root / "data/interfaces.json").read_text("utf-8")
        self.assertNotIn("dummy-private-bearer", raw)
        self.assertNotIn("apiKey", raw)
        loaded = InterfaceStore(self.root, self.opener, vault_factory=self.vault).list()["interfaces"][0]
        self.assertEqual(loaded["id"], row["id"])
        self.assertTrue(loaded["hasApiKey"])
        self.assertTrue(all("interface-secrets" in scope for scope in self.vault.data))

    def test_empty_key_preserves_replacement_and_clear(self):
        row = self.save(apiKey="dummy-original-token")
        identifier = row["id"]
        self.store.save({"id": identifier, "name": "新名称", "apiKey": ""})
        self.assertIn("dummy-original-token", self.vault.data.values())
        self.store.save({"id": identifier, "apiKey": "dummy-replacement-token"})
        self.assertIn("dummy-replacement-token", self.vault.data.values())
        cleared = self.store.save({"id": identifier, "clearApiKey": True})["interface"]
        self.assertFalse(cleared["hasApiKey"])
        with self.assertRaises(InterfaceError):
            self.store.save({"id": identifier, "clearApiKey": True, "apiKey": "dummy-new-token"})

    def test_url_schemes_credentials_fragments_and_secret_queries(self):
        bad = ["file:///private.json", "http://example.com/items", "https://a:b@example.com/items",
               "https://example.com/#fragment", "https://example.com/?api_key=private", "https://example.com/?token=private",
               "https://example.com/\r\nX-Test:private", "https://example.com:bad/items", "https://example.com\\@evil.test"]
        for url in bad:
            with self.subTest(url=url), self.assertRaises(InterfaceError):
                self.save(url=url)
        self.save(url="http://127.0.0.1:19000/items")
        self.save(url="http://[::1]:19000/items")
        self.save(url="http://localhost:19000/items")
        self.save(url="https://example.com/items?limit=50&unit=WT")

    def test_json_path_and_destination_are_not_expressions(self):
        for path in ("items[0]", "data.*", "data..items", "__proto__.items", "data.constructor", "x;import os", ""):
            with self.subTest(path=path), self.assertRaises(InterfaceError):
                self.save(idField=path)
        for fields in ({}, {"script": "value"}, {"percent": "progress[0]"}, {"percent": "__proto__"}):
            with self.subTest(fields=fields), self.assertRaises(InterfaceError):
                self.save(fields=fields)

    def test_get_only_bearer_request_and_nested_mapping(self):
        row = self.save(apiKey="dummy-bearer-1234", idField="asset.code", fields={"percent": "metrics.actual", "planned": "metrics.plan", "actual": "step", "status": "state", "label": "name"})
        self.response({"data": {"items": [{"asset": {"code": "F08"}, "metrics": {"actual": "58.5", "plan": 64}, "step": "WT-07", "state": "active", "name": "F08风机"}]}})
        result = self.store.test(row["id"])
        self.assertEqual(result["preview"], [{"objectId": "F08", "values": {"percent": 58.5, "planned": 64, "actual": "WT-07", "status": "active", "label": "F08风机"}}])
        request, timeout = self.opener.requests[-1]
        self.assertEqual(request.get_method(), "GET")
        self.assertIsNone(request.data)
        self.assertEqual(request.get_header("Authorization"), "Bearer dummy-bearer-1234")
        self.assertEqual(timeout, 15)
        self.assertNotIn("dummy-bearer-1234", json.dumps(result))
        self.assertEqual(self.store.list()["interfaces"][0]["lastStatus"], "success")

    def test_invalid_rows_are_skipped_without_clamping_or_guessing(self):
        row = self.save()
        self.response({"data": {"items": [{"id": "F01", "actual": -1, "plan": 80}, {"id": "F02", "actual": 101, "plan": 80},
            {"id": "F03", "actual": True, "plan": 80}, {"id": "F04", "actual": "58%", "plan": 80},
            {"id": "F05", "actual": 58, "plan": 80}, {"id": "F05", "actual": 60, "plan": 80},
            {"id": "F06", "actual": 50}, {"id": "../../private", "actual": 50, "plan": 80}, []]}})
        result = self.store.test(row["id"])
        self.assertEqual(result["rows"], 9)
        self.assertEqual(result["validRows"], 1)
        self.assertEqual(result["rejectedRows"], 8)
        self.assertEqual(result["preview"][0]["objectId"], "F05")
        self.assertEqual(len(result["warnings"]), 8)
        self.assertEqual(self.store.list()["interfaces"][0]["lastStatus"], "warning")

    def test_process_and_status_validation_match_twin_model(self):
        row = self.save(fields={"actual": "step", "status": "status"})
        self.response({"data": {"items": [{"id": "F01", "step": "SS-11", "status": "done"},
            {"id": "F02", "step": "WT-25", "status": "done"}, {"id": "F03", "step": "WT-24", "status": "finished"},
            {"id": "F04", "step": "WT-24", "status": "done"}]}})
        result = self.store.test(row["id"])
        self.assertEqual(result["validRows"], 1)
        self.assertEqual(result["preview"][0]["objectId"], "F04")

    def test_large_json_numbers_and_text_limits_do_not_escape_validation(self):
        row = self.save(fields={"percent": "value", "label": "name", "group": "group"})
        self.response({"data": {"items": [{"id": "F01", "value": 10 ** 400, "name": "F01", "group": "A"},
            {"id": "F02", "value": 50, "name": "X" * 201, "group": "A"},
            {"id": "F03", "value": 50, "name": "F03", "group": "X" * 101},
            {"id": "constructor", "value": 50, "name": "F04", "group": "A"},
            {"id": "F08", "value": 58, "name": "F08", "group": "A"}]}})
        result = self.store.test(row["id"])
        self.assertEqual(result["validRows"], 1)
        self.assertEqual(result["rejectedRows"], 4)
        self.assertEqual(result["preview"][0]["objectId"], "F08")

    def test_root_array_scope_missing_path_and_wrong_type(self):
        row = self.save(arrayPath="", fields={"percent": "value"})
        self.response([{"id": "F08", "value": 50}])
        self.assertEqual(self.store.test(row["id"])["validRows"], 1)
        self.store.save({"id": row["id"], "arrayPath": "data.items"})
        for body in ({"other": []}, {"data": {"items": {}}}):
            self.response(body)
            with self.assertRaises(InterfaceError) as error:
                self.store.test(row["id"])
            self.assertEqual(error.exception.status, 422)

    def test_empty_array_never_falls_back_to_whole_payload(self):
        row = self.save()
        self.response({"data": {"items": []}, "other": [{"id": "F08", "actual": 50, "plan": 60}]})
        result = self.store.test(row["id"])
        self.assertEqual(result["preview"], [])
        self.assertEqual(result["rows"], 0)

    def test_media_type_compression_and_invalid_json_are_safe_errors(self):
        row = self.save()
        samples = [Response([], headers={"Content-Type": "text/html"}),
            Response([], headers={"Content-Type": "application/json", "Content-Encoding": "gzip"}),
            Response(raw=b'{"key":"private-upstream-data",oops}'), Response(raw=b'{"data":NaN}')]
        for response in samples:
            self.opener.result = response
            with self.assertRaises(InterfaceError) as error:
                self.store.test(row["id"])
            self.assertEqual(error.exception.status, 502)
            self.assertNotIn("private-upstream-data", str(error.exception))
        self.response({"data": {"items": []}}, headers={"Content-Type": "application/vnd.progress+json; charset=utf-8"})
        self.assertEqual(self.store.test(row["id"])["rows"], 0)

    def test_reply_and_array_limits(self):
        row = self.save(arrayPath="")
        self.opener.result = Response(raw=b"x" * (MAX_REPLY + 1))
        with self.assertRaises(InterfaceError):
            self.store.test(row["id"])
        self.response([], headers={"Content-Type": "application/json", "Content-Length": str(MAX_REPLY + 1)})
        with self.assertRaises(InterfaceError):
            self.store.test(row["id"])
        self.response([{}] * 5001)
        with self.assertRaises(InterfaceError) as error:
            self.store.test(row["id"])
        self.assertEqual(error.exception.status, 422)

    def test_warnings_are_capped_and_truncation_is_explicit(self):
        row = self.save(arrayPath="")
        self.response([{}] * 150)
        result = self.store.test(row["id"])
        self.assertEqual(len(result["warnings"]), 100)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["rejectedRows"], 150)

    def test_disabled_interface_never_fetches(self):
        row = self.save(enabled=False)
        with self.assertRaises(InterfaceError) as error:
            self.store.test(row["id"])
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.opener.requests, [])

    def test_http_and_network_errors_never_reveal_diagnostics(self):
        row = self.save(apiKey="dummy-private-key")
        for upstream_status in (301, 401, 403, 404, 500):
            self.opener.result = HTTPError("https://example.com/private", upstream_status, "private-diagnostic", {}, io.BytesIO(b"dummy-private-key"))
            with self.assertRaises(InterfaceError) as error:
                self.store.test(row["id"])
            self.assertNotIn("private", str(error.exception))
            self.assertEqual(error.exception.status, upstream_status if upstream_status in (401, 403) else 502)
        for upstream_error in (TimeoutError(), URLError("private-diagnostic"), URLError(TimeoutError())):
            self.opener.result = upstream_error
            with self.assertRaises(InterfaceError) as error:
                self.store.test(row["id"])
            self.assertNotIn("private", str(error.exception))
        self.assertEqual(self.store.list()["interfaces"][0]["lastStatus"], "error")

    def test_redirect_handler_does_not_forward_bearer(self):
        request = Request("https://example.com/first", headers={"Authorization": "Bearer dummy-private"})
        with self.assertRaises(InterfaceError):
            NoRedirect().redirect_request(request, None, 302, "Found", {}, "https://other.test/second")

    def test_unknown_id_and_configuration_keys_are_rejected(self):
        with self.assertRaises(InterfaceError) as error:
            self.store.save({"id": "a" * 32, "enabled": False})
        self.assertEqual(error.exception.status, 404)
        for patch in ({"method": "POST"}, {"unit": "ALL"}, {"enabled": 1}, {"name": ""}):
            with self.subTest(patch=patch), self.assertRaises(InterfaceError):
                self.save(**patch)
        with self.assertRaises(InterfaceError):
            self.store.test("../bad")

    def test_corrupt_configuration_is_not_overwritten(self):
        self.store.path.parent.mkdir(parents=True)
        self.store.path.write_text('[{"apiKey":"private"}]', "utf-8")
        with self.assertRaises(InterfaceError) as error:
            self.store.list()
        self.assertEqual(error.exception.status, 503)
        with self.assertRaises(InterfaceError):
            self.save()
        self.assertEqual(self.store.path.read_text("utf-8"), '[{"apiKey":"private"}]')

    def test_fetch_concurrency_is_bounded(self):
        row = self.save()
        self.store.inflight.acquire()
        self.store.inflight.acquire()
        try:
            with self.assertRaises(InterfaceError) as error:
                self.store.test(row["id"])
            self.assertEqual(error.exception.status, 429)
            self.assertEqual(self.opener.requests, [])
        finally:
            self.store.inflight.release()
            self.store.inflight.release()

    def test_edited_connector_is_not_marked_healthy_by_old_request(self):
        row = self.save()
        snapshot = {key: value for key, value in row.items() if key not in ("hasApiKey", "keyHint")}
        self.store.save({"id": row["id"], "url": "https://example.com/new"})
        self.store._record_status(row["id"], snapshot, "success")
        self.assertEqual(self.store.list()["interfaces"][0]["lastStatus"], "unchecked")

    def test_test_only_does_not_write_ui_draft_or_published_files(self):
        row = self.save()
        self.response({"data": {"items": [{"id": "F08", "actual": 50, "plan": 60}]}})
        self.store.test(row["id"])
        self.assertFalse((self.root / "data/draft.json").exists())
        self.assertFalse((self.root / "data/published.json").exists())


if __name__ == "__main__":
    unittest.main()
