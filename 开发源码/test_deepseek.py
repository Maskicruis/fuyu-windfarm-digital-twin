"""Deterministic DeepSeek tests. No real provider call or user API key is used."""
from __future__ import annotations
from app_version import VERSION

import http.client
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import quote

import deepseek_service as ai
import server


TEST_KEY = "unit-test-key-not-real-4521"


class MemoryVault:
    def __init__(self, value=""):
        self.value = value
    def read(self):
        return self.value
    def write(self, value):
        self.value = value


class RecordingOpener:
    def __init__(self, payload=None, error=None):
        self.payload = payload if payload is not None else {"choices": [{"message": {"content": "这是测试模型回答", "reasoning_content": "never_return_this"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 16, "completion_tokens": 8, "total_tokens": 24, "unsafe": TEST_KEY}}
        self.error = error
        self.calls = []
    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if self.error:
            raise self.error
        raw = self.payload if type(self.payload) is bytes else json.dumps(self.payload, ensure_ascii=False).encode()
        return io.BytesIO(raw)


def messages(turns=0):
    result = []
    for index in range(turns):
        result.extend([{"role": "user", "content": f"旧提问{index}"}, {"role": "assistant", "content": f"旧回答{index}"}])
    return result + [{"role": "user", "content": "当前要准备哪些机械？"}]


class SettingsAndChatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fuyu-deepseek-unit-")
        self.root = Path(self.temp.name)
        self.vault = MemoryVault()
        self.opener = RecordingOpener()
        self.service = ai.DeepSeekService(self.root, vault=self.vault, opener=self.opener)
    def tearDown(self):
        self.temp.cleanup()

    def test_defaults_no_key_or_network_and_blank_preserves(self):
        settings = self.service.get()
        self.assertEqual(settings["model"], "deepseek-flash")
        self.assertFalse(settings["hasApiKey"])
        self.assertNotIn("apiKey", settings)
        self.assertFalse(self.opener.calls)
        self.service.update({"apiKey": TEST_KEY, "historyTurns": 3})
        self.service.update({"apiKey": "", "temperature": .7})
        self.assertEqual(self.vault.value, TEST_KEY)
        self.assertEqual(self.service.get()["keyHint"], "已保存 · 尾号 4521")
        saved = self.service.path.read_text(encoding="utf-8")
        self.assertNotIn(TEST_KEY, saved)
        self.assertNotIn("apiKey", saved)
        other = ai.DeepSeekService(self.root, vault=self.vault, opener=self.opener)
        self.assertEqual(other.get()["historyTurns"], 3)

    def test_replace_and_clear_key_never_echo(self):
        public = self.service.update({"apiKey": TEST_KEY})
        self.assertNotIn(TEST_KEY, json.dumps(public))
        self.service.update({"apiKey": "another-test-only-key-0002"})
        self.assertTrue(self.service.get()["keyHint"].endswith("0002"))
        self.service.update({"clearApiKey": True})
        self.assertFalse(self.service.get()["hasApiKey"])
        self.assertFalse(self.vault.value)

    def test_strict_settings_and_endpoint_no_arbitrary_proxy(self):
        bad = [None, [], {"random": True}, {"provider": "other"}, {"model": "bad model"},
               {"baseUrl": "http://api.deepseek.com"}, {"baseUrl": "https://example.com/chat/completions"},
               {"baseUrl": "https://api.deepseek.com@evil.example"}, {"baseUrl": "https://api.deepseek.com/?x"},
               {"temperature": True}, {"temperature": 2.01}, {"maxTokens": 127}, {"maxTokens": 2048.0},
               {"historyTurns": 0}, {"historyTurns": 21}, {"maxTokens": 10 ** 500}, {"contextEnabled": "true"}, {"thinking": 1},
               {"clearApiKey": "true"}, {"apiKey": "short"}, {"apiKey": "bad\nheader\nx"},
               {"apiKey": TEST_KEY, "clearApiKey": True}]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ai.DeepSeekError):
                self.service.update(value)
        public = self.service.update({"baseUrl": "https://api.deepseek.com/v1/", "model": "deepseek-v4-pro", "thinking": True})
        self.assertEqual(public["baseUrl"], "https://api.deepseek.com/v1")
        self.assertFalse(self.service.path.read_text(encoding="utf-8").find("apiKey") >= 0)

    def test_custom_models_and_compatible_api_edit_preserves_key_and_payload(self):
        self.service.update({"apiKey": TEST_KEY})
        edited=self.service.update({"provider":"openai-compatible", "baseUrl":"https://gateway.example/v1/", "model":"vendor/custom-v2"})
        self.assertTrue(edited["hasApiKey"])
        self.assertEqual(edited["model"],"vendor/custom-v2")
        self.assertEqual(edited["baseUrl"],"https://gateway.example/v1")
        self.service.chat({"messages": messages()})
        request,_=self.opener.calls[-1]
        self.assertEqual(request.full_url,"https://gateway.example/v1/chat/completions")
        payload=json.loads(request.data)
        self.assertNotIn("thinking",payload)
        self.assertEqual(request.headers["Authorization"],"Bearer "+TEST_KEY)
        self.assertEqual(self.service.get()["model"],"vendor/custom-v2")
        self.assertEqual(ai._base_url("http://127.0.0.1:11434/v1/"),"http://127.0.0.1:11434/v1")
        for unsafe in ("http://192.168.1.1/v1", "https://user:pass@example.com/v1", "https://host/v1?key=x", "https://host/v1#key"):
            with self.assertRaises(ai.DeepSeekError):ai._base_url(unsafe)
        generic=ai.DeepSeekService(self.root,vault=self.vault,opener=self.opener,system_prompt=ai.GENERIC_SYSTEM_PROMPT)
        _,_,sent=generic._prepare_chat({"messages":messages(),"context":{}})
        self.assertNotIn("中车扶余",sent[0]["content"])

    def test_missing_key_is_actionable_without_fallback(self):
        for call in (lambda: self.service.test({}), lambda: self.service.chat({"messages": messages(), "context": {}})):
            with self.assertRaises(ai.DeepSeekError) as failure:
                call()
            self.assertEqual(failure.exception.status, 409)
            self.assertIn("设置", str(failure.exception))
        self.assertFalse(self.opener.calls)

    def test_chat_payload_context_history_model_and_result(self):
        self.service.update({"apiKey": TEST_KEY, "historyTurns": 2, "maxTokens": 1536})
        result = self.service.chat({"messages": messages(5), "context": {"unit": "RD", "object": {"id": "RD-A02", "percent": 54}, "process": {"code": "RD-08"}, "reference": {"file": "工序表.xlsx", "resource": "压路机"}}})
        request, timeout = self.opener.calls[0]
        self.assertEqual(request.full_url, "https://api.deepseek.com/chat/completions")
        self.assertEqual(request.headers["Authorization"], "Bearer " + TEST_KEY)
        self.assertLessEqual(timeout, 55)
        payload = json.loads(request.data)
        self.assertEqual(len(payload["messages"]), 6)
        self.assertEqual(payload["messages"][1]["content"], "旧提问3")
        self.assertEqual(payload["messages"][-1]["role"], "user")
        self.assertIn("RD-A02", payload["messages"][0]["content"])
        self.assertIn("质量通病、危大工程和验收标准", payload["messages"][0]["content"])
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertFalse(payload["stream"])
        self.assertEqual(payload["max_tokens"], 1536)
        self.assertEqual(result["reply"], "这是测试模型回答")
        self.assertEqual(result["usage"], {"prompt_tokens": 16, "completion_tokens": 8, "total_tokens": 24})
        self.assertNotIn("never_return_this", json.dumps(result))
        self.assertNotIn(TEST_KEY, json.dumps(result))

    def test_context_switch_and_disabled_context(self):
        self.service.update({"apiKey": TEST_KEY})
        for unit in ("WT", "RD", "CL", "SS"):
            self.service.chat({"messages": messages(), "context": {"unit": unit, "object": {"id": unit + "01"}}})
            self.assertIn(unit + "01", json.loads(self.opener.calls[-1][0].data)["messages"][0]["content"])
        self.service.update({"contextEnabled": False})
        self.service.chat({"messages": messages(), "context": {"unit": "SS", "object": "unique-not-shared"}})
        prompt = json.loads(self.opener.calls[-1][0].data)["messages"][0]["content"]
        self.assertNotIn("unique-not-shared", prompt)
        self.assertIn("未启用工程上下文", prompt)

    def test_conversation_and_context_limits_reject_injection_roles(self):
        self.service.update({"apiKey": TEST_KEY})
        bad = [{"messages": []}, {"messages": [{"role": "system", "content": "bad"}]},
               {"messages": [{"role": "user", "content": ""}]}, {"messages": messages() * 2},
               {"messages": [{"role": "user", "content": "x" * 12001}]},
               {"messages": messages(), "apiKey": TEST_KEY}, {"messages": messages(), "context": []},
               {"messages": messages(), "context": {"secret": TEST_KEY}}, {"messages": messages(), "context": {"number": 10 ** 500}},
               {"messages": messages(), "context": {"a": "x" * 12001}},
               {"messages": messages(), "context": {"a": "x" * 10000, "b": "x" * 10000, "c": "x" * 10000}},
               {"messages": messages(), "context": {"a": {"b": {"c": {"d": {"e": {"f": {"g": "x"}}}}}}}}]
        for value in bad:
            with self.subTest(value=str(value)[:180]), self.assertRaises(ai.DeepSeekError):
                self.service.chat(value)
        self.assertFalse(self.opener.calls)

    def test_test_connection_uses_saved_config_and_small_disabled_thinking(self):
        self.service.update({"apiKey": TEST_KEY, "model": "deepseek-v4-pro", "thinking": True})
        result = self.service.test({})
        self.assertTrue(result["ok"])
        self.assertEqual(result["model"], "deepseek-v4-pro")
        payload = json.loads(self.opener.calls[0][0].data)
        self.assertEqual(payload["max_tokens"], 64)
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        with self.assertRaises(ai.DeepSeekError):
            self.service.test({"apiKey": TEST_KEY})

    def test_upstream_error_statuses_are_sanitized(self):
        self.service.update({"apiKey": TEST_KEY})
        for upstream, public in ((400, 502), (401, 401), (402, 402), (403, 403), (422, 502), (429, 429), (500, 502), (503, 502)):
            self.opener.error = HTTPError("https://api.deepseek.com", upstream, TEST_KEY, {}, io.BytesIO(TEST_KEY.encode()))
            with self.subTest(status=upstream), self.assertRaises(ai.DeepSeekError) as failure:
                self.service.chat({"messages": messages()})
            self.assertEqual(failure.exception.status, public)
            self.assertNotIn(TEST_KEY, str(failure.exception))

    def test_network_timeout_malformed_empty_and_large_responses(self):
        self.service.update({"apiKey": TEST_KEY})
        for error, status in ((TimeoutError(TEST_KEY), 504), (URLError(TimeoutError(TEST_KEY)), 504), (URLError(TEST_KEY), 502)):
            self.opener.error = error
            with self.subTest(error=type(error).__name__), self.assertRaises(ai.DeepSeekError) as failure:
                self.service.chat({"messages": messages()})
            self.assertEqual(failure.exception.status, status)
            self.assertNotIn(TEST_KEY, str(failure.exception))
        self.opener.error = None
        for payload in (b"not json", {}, {"choices": []}, {"choices": [{"message": {"content": ""}}]}, b" " * (ai.MAX_REPLY_BYTES + 1)):
            self.opener.payload = payload
            with self.subTest(payload_type=type(payload).__name__), self.assertRaises(ai.DeepSeekError) as failure:
                self.service.chat({"messages": messages()})
            self.assertEqual(failure.exception.status, 502)

    def test_concurrency_cap_and_released_after_failure(self):
        self.service.update({"apiKey": TEST_KEY})
        self.service.requests.acquire()
        self.service.requests.acquire()
        with self.assertRaises(ai.DeepSeekError) as failure:
            self.service.chat({"messages": messages()})
        self.assertEqual(failure.exception.status, 429)
        self.service.requests.release()
        self.service.requests.release()
        self.opener.error = TimeoutError()
        with self.assertRaises(ai.DeepSeekError):
            self.service.chat({"messages": messages()})
        self.assertTrue(self.service.requests.acquire(blocking=False))
        self.assertTrue(self.service.requests.acquire(blocking=False))
        self.service.requests.release()
        self.service.requests.release()

    def test_no_authorization_redirect(self):
        with self.assertRaises(ai.DeepSeekError) as failure:
            ai.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://evil.example")
        self.assertEqual(failure.exception.status, 502)

    def test_rollback_settings_if_key_save_fails(self):
        self.service.update({"temperature": .8})
        before = self.service.path.read_bytes()
        with patch.object(self.vault, "write", side_effect=OSError(TEST_KEY)):
            with self.assertRaises(ai.DeepSeekError) as failure:
                self.service.update({"apiKey": TEST_KEY, "temperature": .1})
        self.assertEqual(before, self.service.path.read_bytes())
        self.assertNotIn(TEST_KEY, str(failure.exception))

    @unittest.skipUnless(os.name == "nt", "DPAPI requires Windows")
    def test_windows_dpapi_round_trip_in_temp_vault(self):
        vault = ai.WindowsKeyVault(self.root)
        self.assertFalse(vault.path.is_relative_to(self.root))
        # Only the path is redirected. Exercise real per-user DPAPI with test data.
        vault.path = self.root / "test-vault" / "deepseek.key"
        vault.write(TEST_KEY)
        self.assertNotIn(TEST_KEY.encode(), vault.path.read_bytes())
        self.assertEqual(vault.read(), TEST_KEY)
        vault.write("")
        self.assertEqual(vault.read(), "")


class QuietHandler(server.Handler):
    def log_message(self, fmt, *args):
        pass


class DeepSeekHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fuyu-deepseek-http-")
        self.root = Path(self.temp.name)
        self.httpd = server.FuyuServer(("127.0.0.1", 0), self.root, persistent_credentials=False)
        self.httpd.RequestHandlerClass = QuietHandler
        self.opener = RecordingOpener()
        self.httpd.deepseek = ai.DeepSeekService(self.root, vault=MemoryVault(), opener=self.opener)
        self.httpd.agent.model = self.httpd.deepseek
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(3)
        self.temp.cleanup()
    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        raw = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        connection.request(method, quote(path, safe="/%?=&"), body=raw, headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def test_complete_settings_test_chat_http_and_state_is_separate(self):
        status, raw = self.request("GET", "/api/settings")
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(raw)["hasApiKey"])
        status, raw = self.request("PUT", "/api/settings", {"apiKey": TEST_KEY, "historyTurns": 2})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(raw)["hasApiKey"])
        self.assertNotIn(TEST_KEY.encode(), raw)
        status, raw = self.request("POST", "/api/settings/test", {})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(raw)["ok"])
        status, raw = self.request("POST", "/api/chat", {"messages": messages(), "context": {"unit": "SS"}})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["reply"], "这是测试模型回答")
        for path in ("/api/state", "/api/published", "/data/settings.json", "/开发源码/deepseek_service.py"):
            status, raw = self.request("GET", path)
            self.assertIn(status, (200, 403))
            self.assertNotIn(TEST_KEY.encode(), raw)
            self.assertNotIn(b"keyHint", raw)
        state = json.loads(self.request("GET", "/api/state")[1])
        self.assertEqual(state["service"]["revision"], VERSION)

    def test_missing_key_validation_unknown_route_and_wrong_method(self):
        self.assertEqual(self.request("POST", "/api/chat", {"messages": messages()})[0], 409)
        self.assertEqual(self.request("PUT", "/api/settings", {"maxTokens": 100000})[0], 400)
        self.assertEqual(self.request("POST", "/api/settings", {})[0], 404)
        self.assertEqual(self.request("GET", "/api/chat")[0], 404)

    def test_same_origin_and_json_required(self):
        for method, path, body in (("PUT", "/api/settings", {"apiKey": TEST_KEY}), ("POST", "/api/settings/test", {}), ("POST", "/api/chat", {"messages": messages()})):
            with self.subTest(path=path):
                self.assertEqual(self.request(method, path, body, {"Origin": "https://evil.example"})[0], 403)
                self.assertEqual(self.request(method, path, body, {"Content-Type": "text/plain"})[0], 415)
        self.assertFalse(self.opener.calls)


if __name__ == "__main__":
    unittest.main(verbosity=2)
