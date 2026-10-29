"""HTTP and persistence checks using temporary directories, no browser automation."""
from __future__ import annotations

import copy
import hashlib
import http.client
import io
import json
import re
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import urlencode

import server


def example(text="升压站 · 施工管理辅助"):
    return {"version": 2, "profiles": {"SS:overview:desktop": {"nodes": {
        "right-progress.title": {"text": text, "style": {"fontSize": 18, "color": "#8ce0ff"}},
        "linear-inset": {"rect": {"x": .35, "y": .42, "w": .25, "h": .2, "mode": "viewport"}, "hidden": False},
        "module-nav.item:1": {"rect": {"x": -.1, "y": .1, "w": .8, "h": 1, "mode": "local"}, "attrs": {"title": "工序导航"}},
    }}}}


class ValidationTests(unittest.TestCase):
    def test_config_accepts_normalized_rect_text_style_and_attrs(self):
        value = example()
        clean = server.validate_config(value)
        self.assertEqual(clean, value)
        clean["profiles"]["SS:overview:desktop"]["nodes"]["linear-inset"]["hidden"] = True
        self.assertFalse(value["profiles"]["SS:overview:desktop"]["nodes"]["linear-inset"]["hidden"])

    def test_all_units_tasks_breakpoints_and_limits(self):
        config = server.empty_config()
        for unit in server.UNITS:
            for task in server.TASKS:
                for bp in server.SIZES:
                    config["profiles"][f"{unit}:{task}:{bp}"] = {"nodes": {}}
        self.assertEqual(len(server.validate_config(config)["profiles"]), 45)

    def test_unknown_fields_css_and_unsafe_ids_rejected(self):
        values = [
            {"version": 2, "profiles": {}, "html": "<script>bad()</script>"},
            {"version": 1, "profiles": {}},
            {"version": 2, "profiles": {"SS:unknown:desktop": {"nodes": {}}}},
            {"version": 2, "profiles": {"SS:overview:desktop": {"nodes": {"__proto__": {}}}}},
            {"version": 2, "profiles": {"SS:overview:desktop": {"nodes": {"x y": {}}}}},
        ]
        for patch in ({"html": "<b>x</b>"}, {"style": {"transform": "scale(2)"}},
                      {"attrs": {"onclick": "alert(1)"}}, {"disabled": True},
                      {"style": {"color": "url(https://example.com)"}},
                      {"style": {"color": "var(--bad)"}}, {"style": {"fontSize": True}},
                      {"style": {"opacity": 1.1}}, {"style": {"zIndex": 1.5}}):
            item = example()
            item["profiles"]["SS:overview:desktop"]["nodes"]["linear-inset"] = patch
            values.append(item)
        for value in values:
            with self.subTest(value=value):
                with self.assertRaises(server.ValidationError):
                    server.validate_config(value)

    def test_rect_bounds_and_modes(self):
        for patch in ({"x": -1.1}, {"x": float("nan")}, {"w": 0}, {"h": 2.1}, {"mode": "fixed"}):
            value = example()
            value["profiles"]["SS:overview:desktop"]["nodes"]["linear-inset"]["rect"].update(patch)
            with self.subTest(patch=patch), self.assertRaises(server.ValidationError):
                server.validate_config(value)
        value = example()
        rect = value["profiles"]["SS:overview:desktop"]["nodes"]["linear-inset"]["rect"]
        rect.update(mode="local", x=-5, y=5, w=5, h=.001)
        server.validate_config(value)

    def test_color_formats_and_plain_text(self):
        value = example("a < b\nSF6")
        for color in ("#123", "#1234", "#123456", "#12345678", "rgb(0, 128, 255)", "rgba(0,128,255,.5)"):
            value["profiles"]["SS:overview:desktop"]["nodes"]["right-progress.title"]["style"]["color"] = color
            server.validate_config(value)
        for color in ("rgb(256,0,0)", "rgba(0,0,0,2)", "rgb(0,0,0,.5)", "rgb(..,0,0)", "rgba(0,0,0,.)", "red", "#12"):
            value["profiles"]["SS:overview:desktop"]["nodes"]["right-progress.title"]["style"]["color"] = color
            with self.subTest(color=color), self.assertRaises(server.ValidationError):
                server.validate_config(value)

    def test_duplicate_json_prototype_nan_and_text_limits(self):
        for raw in (b'{"version":2,"version":2,"profiles":{}}', b'{"__proto__":{}}', b'{"x":NaN}', b'{"x":Infinity}'):
            with self.subTest(raw=raw), self.assertRaises(server.ValidationError):
                server.parse_json(raw)
        for text in ("x" * 20001, "bad\x00text"):
            with self.assertRaises(server.ValidationError):
                server.validate_config(example(text))
        value = example()
        value["profiles"]["SS:overview:desktop"]["nodes"]["linear-inset"]["rect"]["x"] = 10 ** 1000
        with self.assertRaises(server.ValidationError):
            server.validate_config(value)

    def test_optional_object_data_and_rejections(self):
        value = example()
        value["data"] = {"objects": {"WT:F08": {"percent": 54.5, "planned": 63, "label": "机位八", "location": "回路B", "group": "回路 B", "actual": "WT-07", "status": "active"}}}
        self.assertEqual(server.validate_config(value), value)
        for patch in ({"percent": 101}, {"planned": True}, {"actual": "SS-07"}, {"actual": "WT-7"}, {"status": "normal"}, {"label": "x" * 201}, {"html": "<b>x</b>"}):
            bad = copy.deepcopy(value)
            bad["data"]["objects"]["WT:F08"] = patch
            with self.subTest(patch=patch), self.assertRaises(server.ValidationError):
                server.validate_config(bad)
        for object_id in ("ALL:F08", "F08", "WT:a/b", "WT:__proto__", "WT:" + "a" * 40):
            bad = copy.deepcopy(value)
            bad["data"]["objects"] = {object_id: {}}
            with self.subTest(object_id=object_id), self.assertRaises(server.ValidationError):
                server.validate_config(bad)


class QuietHandler(server.Handler):
    def log_message(self, fmt, *args):
        pass


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="fuyu-v9-server-test-")
        cls.root = Path(cls.temp.name)
        (cls.root / "frontend.html").write_text('<!doctype html><title>Display</title><script id="fuyu-display-config" type="application/json">{"version":2,"profiles":{}}</script><script>window.displaySeed=1;</script>', encoding="utf-8")
        (cls.root / "admin.html").write_text("<!doctype html><title>Admin</title>", encoding="utf-8")
        (cls.root / "开发源码").mkdir()
        (cls.root / "开发源码" / "secret.py").write_text("secret", encoding="utf-8")
        cls.httpd = server.FuyuServer(("127.0.0.1", 0), cls.root, persistent_credentials=False)
        cls.httpd.RequestHandlerClass = QuietHandler
        cls.port = cls.httpd.server_port
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=3)
        cls.temp.cleanup()

    def request(self, method="GET", path="/api/state", value=None, *, headers=None, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        data = json.dumps(value, ensure_ascii=False).encode("utf-8") if raw is None and value is not None else raw
        final_headers = {"Content-Type": "application/json"}
        final_headers.update(headers or {})
        connection.request(method, path, body=data, headers=final_headers)
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, payload, dict(response.getheaders()))
        connection.close()
        return result

    def test_state_default_and_static_pages(self):
        status, raw, headers = self.request()
        self.assertEqual(status, 200)
        state = json.loads(raw)
        self.assertEqual(set(state), {"draft", "published", "versions", "service"})
        self.assertEqual(state["draft"]["version"], 2)
        self.assertEqual(headers["Cache-Control"], "no-store")
        for route in ("/", "/frontend.html", "/admin.html"):
            self.assertEqual(self.request(path=route)[0], 200)

    def test_state_service_identity_does_not_change_stored_config(self):
        status, raw, _ = self.request()
        self.assertEqual(status, 200)
        state = json.loads(raw)
        self.assertEqual(state["service"], {"name": "fuyu-ui-studio", "revision": "0.9.1", "workspace": str(self.root.resolve())})
        stored = self.httpd.store.state()
        self.assertEqual(set(stored), {"draft", "published", "versions"})
        self.assertEqual({k: state[k] for k in stored}, stored)
        self.assertNotIn("service", json.loads((self.root / "data/draft.json").read_text(encoding="utf-8")))

    def test_draft_and_publish_restore_remain_separate(self):
        first = example("第一版")
        status, raw, _ = self.request("PUT", "/api/draft", first,
            headers={"Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["draft"], first)
        status, raw, _ = self.request("POST", "/api/publish", {"label": "首次发布"})
        self.assertEqual(status, 200)
        published = json.loads(raw)
        vid = published["version"]["id"]
        self.assertTrue(server.VERSION_RE.fullmatch(vid))
        self.assertEqual(json.loads((self.root / "展示配置.json").read_text(encoding="utf-8")), first)
        self.assertEqual(json.loads(self.request(path="/api/published")[1]), first)
        second = example("第二版")
        self.assertEqual(self.request("POST", "/api/publish", {"config": second, "label": "第二版"})[0], 200)
        self.assertEqual(self.request("POST", "/api/restore", {"id": vid})[0], 200)
        state = json.loads(self.request()[1])
        self.assertEqual(state["draft"], first)
        self.assertEqual(state["published"], second)
        reloaded = server.Store(self.root)
        self.assertEqual(reloaded.state(), {key: state[key] for key in ("draft", "published", "versions")})

    def test_invalid_draft_does_not_change_state(self):
        before = json.loads(self.request()[1])
        bad = example()
        bad["profiles"]["SS:overview:desktop"]["nodes"]["linear-inset"]["style"] = {"cssText": "position:fixed"}
        status, raw, _ = self.request("PUT", "/api/draft", bad)
        self.assertEqual(status, 400)
        self.assertFalse(json.loads(raw)["ok"])
        self.assertEqual(json.loads(self.request()[1]), before)
        self.assertEqual(self.request("PUT", "/api/draft", raw=b"null")[0], 400)

    def test_origin_host_type_and_size_guards(self):
        origin = {"Origin": "https://outside.example"}
        self.assertEqual(self.request("PUT", "/api/draft", example(), headers=origin)[0], 403)
        self.assertEqual(self.request("POST", "/api/publish", {}, headers={"Origin": "null"})[0], 403)
        self.assertEqual(self.request(headers={"Host": "outside.example"})[0], 403)
        self.assertEqual(self.request("PUT", "/api/draft", example(), headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("PUT", "/api/draft", raw=b"x" * (server.MAX_BODY + 1))[0], 413)

    def test_static_traversal_data_and_source_not_exposed(self):
        for route in ("/../server.py", "/%2e%2e/server.py", "/data/draft.json", "/%64ata/published.json", "/C:/Windows/win.ini", "/%5c..%5cserver.py", "/.git/config", "/%E5%BC%80%E5%8F%91%E6%BA%90%E7%A0%81/secret.py"):
            with self.subTest(route=route):
                self.assertEqual(self.request(path=route)[0], 403)

    def test_version_forgery_rejected(self):
        self.assertEqual(self.request("POST", "/api/publish", {"id": "fake", "config": example()})[0], 400)
        self.assertEqual(self.request("POST", "/api/restore", {"id": "../../draft"})[0], 400)
        self.assertEqual(self.request("POST", "/api/restore", {"id": "20000101T000000Z-aaaaaaaaaaaa"})[0], 404)

    def test_publish_bakes_plain_text_and_object_data_into_frontend(self):
        config = example('</script><script>bad()</script>')
        config["data"] = {"objects": {"RD:RD-A02": {"percent": 66, "planned": 73, "actual": "RD-08", "status": "active"}}}
        status, raw, _ = self.request("POST", "/api/publish", {"config": config, "label": "展示数据测试"})
        self.assertEqual(status, 200)
        html = (self.root / "frontend.html").read_text(encoding="utf-8")
        body = re.search(r'<script id="fuyu-display-config" type="application/json">(.*?)</script>', html, re.S)[1]
        self.assertEqual(json.loads(body), config)
        self.assertNotIn('</script><script>bad()', html)
        self.assertIn('window.displaySeed=1;', html)
        self.assertEqual(html.count('</script>'), 2)
        self.assertEqual(json.loads(self.request(path="/api/published")[1]), config)

    def test_history_limit_and_atomic_no_temp_files(self):
        with tempfile.TemporaryDirectory(prefix="fuyu-v9-version-test-") as folder:
            store = server.Store(folder)
            oldest = None
            for number in range(32):
                result = store.publish(example(str(number)), str(number))
                oldest = oldest or result["version"]["id"]
            self.assertEqual(len(store.state()["versions"]), 30)
            self.assertEqual(len(list((Path(folder) / "data/versions").glob("*.json"))), 30)
            self.assertFalse((Path(folder) / "data/versions" / (oldest + ".json")).exists())
            self.assertFalse(list(Path(folder).rglob("*.tmp")))


class ScanDocumentTests(unittest.TestCase):
    PDF = b"%PDF-1.4\n% local scan fixture\n%%EOF\n"
    PNG = b"\x89PNG\r\n\x1a\n" + b"scan test bytes"
    JPEG = b"\xff\xd8\xff\xe0" + b"scan test bytes\xff\xd9"
    WEBP = b"RIFF\x10\x00\x00\x00WEBP" + b"scan test bytes"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fuyu-v91-scans-")
        self.root = Path(self.temp.name)
        (self.root / "frontend.html").write_text('<script id="fuyu-display-config" type="application/json">{"version":2,"profiles":{}}</script>', encoding="utf-8")
        self.httpd = server.FuyuServer(("127.0.0.1", 0), self.root, persistent_credentials=False)
        self.httpd.RequestHandlerClass = QuietHandler
        self.port = self.httpd.server_port
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)
        self.temp.cleanup()

    request = ServerTests.request

    def upload(self, raw=None, **extra):
        values = {"unit": "WT", "branch": "main", "category": "00", "filename": "施工扫描件.pdf", "label": "设计文件扫描件", **extra}
        mime = values.pop("mime", "application/pdf")
        return self.request("POST", "/api/documents?" + urlencode(values), raw=self.PDF if raw is None else raw, headers={"Content-Type": mime, "Origin": f"http://127.0.0.1:{self.port}"})

    def list(self, **extra):
        return self.request(path="/api/documents?" + urlencode({"unit": "WT", "branch": "main", **extra}))

    def test_default_empty_registry_and_exact_five_branches_34_categories(self):
        total = 0
        for (unit, branch), names in server.DOCUMENT_CATEGORIES.items():
            status, raw, _ = self.list(unit=unit, branch=branch)
            result = json.loads(raw)
            self.assertEqual(status, 200)
            self.assertEqual(result["documents"], [])
            self.assertEqual([item["name"] for item in result["categories"]], list(names))
            self.assertEqual(result["categories"][0]["id"], "00")
            total += len(result["categories"])
        self.assertEqual(total, 34)
        self.assertEqual(len(server.DOCUMENT_CATEGORIES), 5)
        self.assertEqual(self.request(path="/api/documents")[0], 400)

    def test_pdf_upload_persists_uuid_sha_and_pending_manual_review(self):
        state_before = json.loads(self.request()[1])
        status, raw, _ = self.upload(documentCode="WT-ZL-001", version="V2", recordDate="2026-10-28", objectId="F08", process="WT-07", notes="等待人工核验")
        self.assertEqual(status, 201)
        doc = json.loads(raw)["document"]
        self.assertRegex(doc["id"], r"^[a-f0-9]{32}$")
        self.assertEqual(doc["sha256"], hashlib.sha256(self.PDF).hexdigest())
        self.assertEqual(doc["bytes"], len(self.PDF))
        self.assertEqual(doc["reviewStatus"], "pending_manual")
        self.assertEqual(doc["archiveStatus"], "registered")
        self.assertEqual(doc["sourceType"], "local_upload")
        self.assertEqual(doc["documentCode"], "WT-ZL-001")
        self.assertEqual(doc["recordDate"], "2026-10-28")
        self.assertEqual(json.loads(self.request()[1]), state_before)
        persisted = server.DocumentStore(self.root).list("WT", "main")["documents"]
        self.assertEqual(persisted, [doc])
        self.assertTrue((self.root / "data/documents/blobs" / (doc["id"] + ".pdf")).is_file())
        self.assertFalse(list((self.root / "data/documents").rglob("*.tmp")))

    def test_supported_image_magic_and_generic_binary_header(self):
        for body, ext, mime in ((self.PNG, ".png", "image/png"), (self.JPEG, ".jpeg", "image/jpeg"), (self.WEBP, ".webp", "image/webp")):
            with self.subTest(mime=mime):
                status, raw, _ = self.upload(body, filename="扫描件" + ext, mime="application/octet-stream")
                self.assertEqual(status, 201)
                doc = json.loads(raw)["document"]
                self.assertEqual(doc["mime"], mime)
                self.assertEqual(self.request(path=doc["fileUrl"])[1], body)

    def test_reject_malformed_magic_extension_mime_and_filename_without_orphans(self):
        cases = ((b"<script>bad()</script>", "scan.pdf", "application/pdf"), (self.PDF, "scan.png", "image/png"),
                 (self.PNG, "scan.png", "application/pdf"), (self.PDF, "scan.html", "text/html"))
        for body, name, mime in cases:
            with self.subTest(name=name, mime=mime):
                self.assertEqual(self.upload(body, filename=name, mime=mime)[0], 415)
        for name in ("../scan.pdf", "C:\\scan.pdf", "scan.pdf\r\nInjected:1"):
            with self.subTest(name=name):
                self.assertEqual(self.upload(filename=name)[0], 400)
        self.assertEqual(list((self.root / "data/documents/blobs").iterdir()), [])
        self.assertEqual(json.loads(self.list()[1])["documents"], [])

    def test_scope_and_metadata_validation(self):
        for extra in ({"unit": "SS", "branch": "main"}, {"category": "07"}, {"unit": "RD", "category": "05"},
                      {"process": "SS-11"}, {"process": "WT-25"}, {"process": "WT-00"}, {"recordDate": "2026-02-30"},
                      {"label": ""}, {"reviewStatus": "passed"}):
            with self.subTest(extra=extra):
                self.assertEqual(self.upload(**extra)[0], 400)
        self.assertEqual(self.list(unit="SS", branch="civil", category="07")[0], 400)
        self.assertEqual(self.list(category="00&anything")[0], 400)

    def test_scope_category_filter_and_station_branch_are_distinct(self):
        self.upload(unit="SS", branch="civil", category="00", label="土建扫描件")
        self.upload(unit="SS", branch="install", category="00", label="安装扫描件")
        self.upload(unit="SS", branch="install", category="03", label="安装记录")
        civil = json.loads(self.list(unit="SS", branch="civil")[1])["documents"]
        install = json.loads(self.list(unit="SS", branch="install")[1])["documents"]
        one_category = json.loads(self.list(unit="SS", branch="install", category="03")[1])["documents"]
        self.assertEqual(len(civil), 1)
        self.assertEqual(len(install), 2)
        self.assertEqual([d["label"] for d in one_category], ["安装记录"])
        self.assertEqual(json.loads(self.list()[1])["documents"], [])

    def test_edit_metadata_archive_and_unarchive_without_system_verification(self):
        doc = json.loads(self.upload()[1])["document"]
        route = "/api/documents/" + doc["id"]
        patch = {"label": "更新的资料名称", "category": "01", "archiveStatus": "archived", "notes": "人工核验情况：已核对页数", "version": "V3", "documentCode": "DOC-3", "recordDate": "2026-10-28", "objectId": "F09", "process": "WT-08"}
        status, raw, _ = self.request("PUT", route, patch)
        self.assertEqual(status, 200)
        updated = json.loads(raw)["document"]
        for key, value in patch.items():
            self.assertEqual(updated[key], value)
        self.assertEqual(updated["sha256"], doc["sha256"])
        self.assertEqual(updated["reviewStatus"], "pending_manual")
        self.assertEqual(self.request("PUT", route, {"archiveStatus": "registered"})[0], 200)
        self.assertEqual(json.loads(self.list()[1])["documents"][0]["archiveStatus"], "registered")
        for invalid in ({"reviewStatus": "verified"}, {"verified": True}, {"filename": "changed.pdf"}, {"sha256": "fake"}):
            with self.subTest(invalid=invalid):
                self.assertEqual(self.request("PUT", route, invalid)[0], 400)

    def test_preview_download_range_and_missing_file(self):
        doc = json.loads(self.upload()[1])["document"]
        route = doc["fileUrl"]
        status, raw, headers = self.request(path=route)
        self.assertEqual(status, 200)
        self.assertEqual(raw, self.PDF)
        self.assertEqual(headers["Content-Type"], "application/pdf")
        self.assertIn("inline", headers["Content-Disposition"])
        self.assertIn("filename*=UTF-8''", headers["Content-Disposition"])
        status, raw, headers = self.request(path=route + "?download=1")
        self.assertIn("attachment", headers["Content-Disposition"])
        status, raw, headers = self.request(path=route, headers={"Range": "bytes=0-4"})
        self.assertEqual(status, 206)
        self.assertEqual(raw, b"%PDF-")
        self.assertEqual(headers["Content-Range"], f"bytes 0-4/{len(self.PDF)}")
        self.assertEqual(self.request(path=route, headers={"Range": "bytes=999-1000"})[0], 416)
        self.assertEqual(self.request(path=route, headers={"Range": "bytes=-5"})[1], self.PDF[-5:])
        self.assertEqual(self.request(path="/api/documents/" + "a" * 32 + "/file")[0], 404)
        self.assertEqual(self.request(path="/data/documents/blobs/" + doc["id"] + ".pdf")[0], 403)

    def test_upload_size_empty_origin_and_no_delete_interface(self):
        self.assertEqual(self.upload(b"")[0], 400)
        query = "/api/documents?" + urlencode({"unit": "WT", "branch": "main", "category": "00", "filename": "scan.pdf"})
        status = self.request("POST", query, raw=b"x", headers={"Content-Type": "application/pdf", "Content-Length": str(server.MAX_SCAN_BYTES + 1)})[0]
        self.assertEqual(status, 413)
        self.assertEqual(self.request("POST", query, raw=self.PDF, headers={"Content-Type": "application/pdf", "Origin": "https://outside.example"})[0], 403)
        doc = json.loads(self.upload()[1])["document"]
        self.assertEqual(self.request("DELETE", "/api/documents/" + doc["id"])[0], 405)
        self.assertEqual(len(json.loads(self.list()[1])["documents"]), 1)

    def test_exact_40mib_streamed_boundary_and_partial_stream_cleanup(self):
        class ScanStream:
            def __init__(self, size): self.remaining = size; self.first = True
            def read(self, size):
                size = min(size, self.remaining)
                self.remaining -= size
                if self.first:
                    self.first = False
                    return b"%PDF-" + b"0" * (size - 5)
                return b"0" * size
        store = self.httpd.documents
        metadata = {"unit": "WT", "branch": "main", "category": "00"}
        doc = store.upload(ScanStream(server.MAX_SCAN_BYTES), server.MAX_SCAN_BYTES, "application/pdf", metadata, "边界扫描件.pdf")
        self.assertEqual(doc["bytes"], 40 * 1024 * 1024)
        self.assertEqual(store.file(doc["id"])[1].stat().st_size, server.MAX_SCAN_BYTES)
        with self.assertRaises(server.ValidationError):
            store.upload(io.BytesIO(b"%PDF-"), 50, "application/pdf", metadata, "不完整.pdf")
        self.assertFalse(list(store.blobs.glob("*.tmp")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
