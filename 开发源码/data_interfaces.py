"""Manual, read-only JSON connectors for the twin's display-data drafts.

Connector definitions contain no secrets. Bearer tokens use project/id-scoped
Windows DPAPI vaults outside the deliverable. Fetching never changes a draft;
the owning HTTP service must explicitly apply the validated preview.
"""
from __future__ import annotations

import copy
import datetime as dt
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import socket
import tempfile
import threading
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from deepseek_service import DeepSeekError, WindowsKeyVault

MAX_REPLY = 2 * 1024 * 1024
MAX_ROWS = 5000
MAX_INTERFACES = 100
MAX_WARNINGS = 100
ID_RE = re.compile(r"^[a-f0-9]{32}$")
OBJECT_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,40}$")
PATH_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,11}$")
NUMBER_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")
SECRET_QUERY_RE = re.compile(r"api[-_]?key|token|authorization|password|secret|signature|access[-_]?key", re.I)
UNITS = {"WT": 24, "RD": 17, "CL": 21, "SS": 30}
FIELDS = frozenset(("percent", "planned", "label", "location", "group", "actual", "status"))
STATUSES = frozenset(("done", "active", "late", "waiting"))
CONFIG_FIELDS = frozenset(("id", "name", "url", "enabled", "unit", "idField", "arrayPath", "fields"))
STORED_FIELDS = CONFIG_FIELDS | frozenset(("createdAt", "updatedAt", "lastCheckedAt", "lastStatus", "lastError"))


class InterfaceError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise InterfaceError("数据接口返回了重定向。请在配置中填写最终接口地址。", 502)


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _text(value, limit, label, *, allow_empty=True):
    if (type(value) is not str or len(value) > limit or any(ord(c) < 32 for c in value)
            or not allow_empty and not value.strip()):
        raise InterfaceError(label + "格式或长度无效。")
    return value.strip()


def _path(value, label, *, allow_empty=False):
    value = _text(value, 300, label)
    if not value and allow_empty:
        return ""
    if not PATH_RE.fullmatch(value) or any(x in ("__proto__", "prototype", "constructor") for x in value.split(".")):
        raise InterfaceError(label + "只支持点分隔字段名，例如 data.items 或 progress.actual。")
    return value


def _url(value):
    value = _text(value, 2000, "接口 URL", allow_empty=False)
    try:
        split = urlsplit(value)
        host = split.hostname or ""
        _ = split.port
        if not host or split.username is not None or split.password is not None or split.fragment:
            raise ValueError()
        if any(ord(c) > 127 or c.isspace() or c == "\\" for c in value):
            raise ValueError()
        loopback = host.casefold() == "localhost"
        try:
            loopback = loopback or ipaddress.ip_address(host).is_loopback
        except ValueError:
            pass
        if split.scheme != "https" and not (split.scheme == "http" and loopback):
            raise ValueError()
        if any(SECRET_QUERY_RE.search(name) for name, _ in parse_qsl(split.query, keep_blank_values=True)):
            raise InterfaceError("请将认证令牌填写到独立密钥栏，不要放入接口 URL。")
    except (TypeError, ValueError):
        raise InterfaceError("接口 URL 需为 HTTPS 或本机 HTTP 地址，且不能包含账户、密码或片段。") from None
    return value


def _lookup(row, path):
    value = row
    if not path:
        return value
    for key in path.split("."):
        if type(value) is not dict or key not in value:
            raise KeyError(path)
        value = value[key]
    return value


def _atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".interfaces-", suffix=".tmp", dir=path.parent, delete=False) as file:
            temp_name = file.name
            file.write(json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8"))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_name, path)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def _value(field, value, unit):
    if field in ("percent", "planned"):
        if type(value) is str and NUMBER_RE.fullmatch(value.strip()):
            value = float(value)
        if type(value) not in (int, float) or not 0 <= value <= 100 or not math.isfinite(value):
            raise InterfaceError(field + "应为 0–100 的有限数值。")
        return value
    if field == "actual":
        value = _text(value, 6, "已报工序")
        if not re.fullmatch(re.escape(unit) + r"-[0-9]{2}", value) or not 1 <= int(value[-2:]) <= UNITS[unit]:
            raise InterfaceError("已报工序不属于当前单位工程。")
        return value
    if field == "status":
        if type(value) is not str or value not in STATUSES:
            raise InterfaceError("状态仅支持 done、active、late、waiting。")
        return value
    return _text(value, {"label": 200, "location": 300, "group": 100}[field], field)


def _bad_constant(value):
    raise ValueError("Non-finite JSON number")


class InterfaceStore:
    def __init__(self, root, opener=None, *, vault_factory=None):
        self.root = Path(root).resolve()
        self.path = self.root / "data" / "interfaces.json"
        if not self.path.resolve().is_relative_to(self.root):
            raise InterfaceError("接口配置目录必须位于当前项目内。")
        self.opener = opener if opener is not None else build_opener(NoRedirect())
        self.vault_factory = vault_factory or WindowsKeyVault
        self.lock = threading.RLock()
        self.inflight = threading.BoundedSemaphore(2)

    def _vault(self, interface_id):
        # WindowsKeyVault hashes this scope and stores only in LOCALAPPDATA.
        return self.vault_factory(self.root / "interface-secrets" / interface_id)

    def _load(self):
        if not self.path.exists():
            return []
        try:
            if self.path.stat().st_size > 512 * 1024:
                raise ValueError()
            rows = json.loads(self.path.read_text("utf-8"), parse_constant=_bad_constant)
            if type(rows) is not list or len(rows) > MAX_INTERFACES:
                raise ValueError()
            seen = set()
            for row in rows:
                if type(row) is not dict or set(row) - STORED_FIELDS:
                    raise ValueError()
                clean = self._validate({key: row[key] for key in CONFIG_FIELDS if key in row}, new=False)
                if clean["id"] in seen:
                    raise ValueError()
                seen.add(clean["id"])
            return rows
        except (OSError, ValueError, TypeError, KeyError, InterfaceError):
            raise InterfaceError("接口配置文件无效，请恢复 interfaces.json 后重试。", 503) from None

    @staticmethod
    def _validate(body, *, new=False):
        if type(body) is not dict or set(body) - CONFIG_FIELDS:
            raise InterfaceError("接口配置包含不支持的字段。")
        row = copy.deepcopy(body)
        if new:
            row.setdefault("id", uuid.uuid4().hex)
            row.setdefault("enabled", True)
            row.setdefault("idField", "id")
            row.setdefault("arrayPath", "")
            row.setdefault("fields", {"percent": "percent", "planned": "planned"})
        required = {"id", "name", "url", "enabled", "unit", "idField", "arrayPath", "fields"}
        if not required <= row.keys():
            raise InterfaceError("请填写接口名称、URL、单位工程及字段映射。")
        if type(row["id"]) is not str or not ID_RE.fullmatch(row["id"]):
            raise InterfaceError("接口 ID 无效。")
        row["name"] = _text(row["name"], 100, "接口名称", allow_empty=False)
        row["url"] = _url(row["url"])
        if type(row["enabled"]) is not bool:
            raise InterfaceError("启用状态必须为布尔值。")
        if type(row["unit"]) is not str or row["unit"] not in UNITS:
            raise InterfaceError("请选择有效单位工程。")
        row["idField"] = _path(row["idField"], "对象 ID 字段")
        row["arrayPath"] = _path(row["arrayPath"], "数组路径", allow_empty=True)
        if type(row["fields"]) is not dict or not row["fields"] or set(row["fields"]) - FIELDS:
            raise InterfaceError("请配置有效的数据字段映射。")
        row["fields"] = {field: _path(path, field + " 字段路径") for field, path in row["fields"].items()}
        return row

    def _public(self, row):
        result = copy.deepcopy(row)
        try:
            key = self._vault(row["id"]).read()
            result["hasApiKey"] = bool(key)
            result["keyHint"] = "已保存 · 尾号 " + key[-4:] if key else "未配置"
        except DeepSeekError:
            result["hasApiKey"] = False
            result["keyHint"] = "密钥需重新配置"
        return result

    def list(self):
        with self.lock:
            return {"interfaces": [self._public(row) for row in self._load()]}

    def save(self, body):
        if type(body) is not dict or set(body) - (CONFIG_FIELDS | {"apiKey", "clearApiKey"}):
            raise InterfaceError("接口配置包含不支持的字段。")
        patch = dict(body)
        key = _text(patch.pop("apiKey", ""), 256, "认证密钥")
        clear = patch.pop("clearApiKey", False)
        if type(clear) is not bool or clear and key:
            raise InterfaceError("请分别执行替换密钥和清除密钥操作。")
        if key and (len(key) < 8 or not re.fullmatch(r"[!-~]+", key)):
            raise InterfaceError("认证密钥应为 8–256 位无空白 ASCII 字符。")
        with self.lock:
            rows = self._load()
            supplied_id = patch.get("id")
            existing = next((r for r in rows if r["id"] == supplied_id), None)
            if supplied_id and existing is None:
                raise InterfaceError("接口配置不存在。", 404)
            if existing:
                merged = {field: existing[field] for field in CONFIG_FIELDS}
                merged.update(patch)
                row = self._validate(merged)
                for field in ("createdAt", "lastCheckedAt", "lastStatus", "lastError"):
                    if field in existing:
                        row[field] = existing[field]
            else:
                if len(rows) >= MAX_INTERFACES:
                    raise InterfaceError("接口配置数量已达到 100 个上限。")
                row = self._validate(patch, new=True)
                row["createdAt"] = _now()
            row["updatedAt"] = _now()
            if not row["enabled"]:
                row["lastStatus"] = "disabled"
            elif existing and any(existing.get(f) != row.get(f) for f in ("url", "unit", "idField", "arrayPath", "fields")):
                row["lastStatus"] = "unchecked"
                row["lastError"] = ""
            old_bytes = self.path.read_bytes() if self.path.exists() else None
            candidate = [r for r in rows if r["id"] != row["id"]] + [row]
            try:
                _atomic(self.path, candidate)
                if key or clear:
                    self._vault(row["id"]).write("" if clear else key)
            except (OSError, DeepSeekError):
                if old_bytes is None:
                    self.path.unlink(missing_ok=True)
                else:
                    self.path.write_bytes(old_bytes)
                raise InterfaceError("接口配置或密钥保存失败，请检查本机写入权限。", 503) from None
            return {"interface": self._public(row)}

    def _record_status(self, interface_id, row_snapshot, status, error=""):
        with self.lock:
            rows = self._load()
            row = next((r for r in rows if r["id"] == interface_id), None)
            # Do not let an in-flight check label a newly edited URL as healthy.
            if row is None or any(row.get(k) != row_snapshot.get(k) for k in CONFIG_FIELDS):
                return
            row.update({"lastCheckedAt": _now(), "lastStatus": status, "lastError": error})
            _atomic(self.path, rows)

    def _fetch(self, row, key):
        headers = {"Accept": "application/json", "Accept-Encoding": "identity"}
        if key:
            headers["Authorization"] = "Bearer " + key
        request = Request(row["url"], headers=headers, method="GET")
        try:
            deadline = time.monotonic() + 15
            with self.opener.open(request, timeout=15) as response:
                if response.status != 200:
                    raise InterfaceError("数据接口未返回成功状态。", 502)
                mime = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                if mime != "application/json" and not (mime.startswith("application/") and mime.endswith("+json")):
                    raise InterfaceError("数据接口需返回 JSON 类型内容。", 502)
                if response.headers.get("Content-Encoding", "identity").lower() not in ("", "identity"):
                    raise InterfaceError("数据接口返回了不支持的压缩格式。", 502)
                length = response.headers.get("Content-Length")
                if length and (not length.isdigit() or int(length) > MAX_REPLY):
                    raise InterfaceError("数据接口内容超过 2 MiB 上限。", 502)
                parts, size = [], 0
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError()
                    raw_socket = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
                    if raw_socket is not None:
                        raw_socket.settimeout(remaining)
                    reader = getattr(response, "read1", response.read)
                    part = reader(min(65536, MAX_REPLY + 1 - size))
                    if not part:
                        break
                    parts.append(part)
                    size += len(part)
                    if size > MAX_REPLY:
                        raise InterfaceError("数据接口内容超过 2 MiB 上限。", 502)
                return json.loads(b"".join(parts), parse_constant=_bad_constant)
        except HTTPError as error:
            code = error.code
            error.close()
            if code in (401, 403):
                raise InterfaceError("数据接口认证失败，请检查认证密钥和访问权限。", code) from None
            if 300 <= code < 400:
                raise InterfaceError("数据接口返回了重定向，请填写最终接口地址。", 502) from None
            raise InterfaceError("数据接口请求失败，请检查服务状态。", 502) from None
        except (TimeoutError, socket.timeout):
            raise InterfaceError("数据接口请求超时，请稍后重试。", 504) from None
        except URLError as error:
            if isinstance(error.reason, (TimeoutError, socket.timeout)):
                raise InterfaceError("数据接口连接超时，请检查网络。", 504) from None
            raise InterfaceError("无法连接数据接口，请检查网络及接口地址。", 502) from None
        except (ValueError, TypeError, OSError):
            raise InterfaceError("数据接口未返回有效 JSON，或连接已中断。", 502) from None

    def test(self, interface_id):
        if type(interface_id) is not str or not ID_RE.fullmatch(interface_id):
            raise InterfaceError("接口 ID 无效。")
        with self.lock:
            row = next((r for r in self._load() if r["id"] == interface_id), None)
            if row is None:
                raise InterfaceError("接口配置不存在。", 404)
            row = copy.deepcopy(row)
            if not row["enabled"]:
                raise InterfaceError("此接口已停用，请先启用后再测试。", 409)
            try:
                key = self._vault(interface_id).read()
            except DeepSeekError:
                raise InterfaceError("接口认证密钥无法读取，请重新填写。", 503) from None
        if not self.inflight.acquire(blocking=False):
            raise InterfaceError("已有两个数据接口请求正在处理，请稍后再试。", 429)
        try:
            data = self._fetch(row, key)
            try:
                values = _lookup(data, row["arrayPath"])
            except KeyError:
                raise InterfaceError("响应中未找到配置的数组路径。", 422) from None
            if type(values) is not list:
                raise InterfaceError("响应中的数组路径没有指向 JSON 数组。", 422)
            if len(values) > MAX_ROWS:
                raise InterfaceError("响应数组超过 5000 条上限，请在源接口分页或筛选。", 422)
            preview, warnings, seen = [], [], set()
            rejected = 0
            for index, item in enumerate(values, 1):
                try:
                    if type(item) is not dict:
                        raise InterfaceError("数据行必须是 JSON 对象。")
                    object_id = _lookup(item, row["idField"])
                    if (type(object_id) is not str or not OBJECT_RE.fullmatch(object_id)
                            or object_id in ("__proto__", "prototype", "constructor")):
                        raise InterfaceError("对象 ID 应为最多 40 位的字母、数字及 _ . : -。")
                    if object_id in seen:
                        raise InterfaceError("对象 ID 重复。")
                    mapped = {field: _value(field, _lookup(item, source), row["unit"]) for field, source in row["fields"].items()}
                    seen.add(object_id)
                    preview.append({"objectId": object_id, "values": mapped})
                except KeyError:
                    rejected += 1
                    if len(warnings) < MAX_WARNINGS:
                        warnings.append("第 " + str(index) + " 行：缺少对象 ID 或映射字段，已跳过。")
                except InterfaceError as error:
                    rejected += 1
                    if len(warnings) < MAX_WARNINGS:
                        warnings.append("第 " + str(index) + " 行：" + str(error) + "已跳过。")
            checked = _now()
            self._record_status(interface_id, row, "warning" if rejected else "success")
            return {"interfaceId": interface_id, "unit": row["unit"], "rows": len(values), "validRows": len(preview),
                    "preview": preview, "warnings": warnings, "rejectedRows": rejected,
                    "truncated": rejected > len(warnings), "checkedAt": checked}
        except InterfaceError as error:
            self._record_status(interface_id, row, "error", str(error))
            raise
        finally:
            self.inflight.release()
