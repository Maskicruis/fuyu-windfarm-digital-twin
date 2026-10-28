"""Fuyu local display/editor backend. Python standard library only.

Run: python server.py --port 8779
Only 127.0.0.1 is bound. Static frontend.html/admin.html live one level above
this source folder. Drafts, publication state and versions persist as JSON.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit

from deepseek_service import DeepSeekError, DeepSeekService
from knowledge_service import KnowledgeStore, KnowledgeError
from agent_service import AgentService
from data_interfaces import InterfaceStore, InterfaceError

MAX_BODY = 2 * 1024 * 1024
MAX_VERSIONS = 30
MAX_SCAN_BYTES = 40 * 1024 * 1024
DOCUMENT_ID_RE = re.compile(r"^[a-f0-9]{32}$")
DOCUMENT_CATEGORIES = {
    ("WT", "main"): ("设计文件", "管理体系", "施工管理", "材料、构件", "施工及验收", "单位工程验收", "统计汇总"),
    ("RD", "main"): ("设计文件", "管理体系", "施工管理", "材料、构件", "施工及验收"),
    ("CL", "main"): ("设计文件", "管理体系", "施工管理", "材料、构件", "施工记录", "试验报告", "验收记录", "统计汇总"),
    ("SS", "civil"): ("设计文件", "管理体系", "施工管理", "材料、构件", "施工记录", "验收记录", "统计汇总"),
    ("SS", "install"): ("设计文件", "管理体系", "施工管理", "安装记录", "电气设备试验", "验收记录", "统计汇总"),
}
SCAN_TYPES = {
    "application/pdf": (".pdf", frozenset((".pdf",))),
    "image/jpeg": (".jpg", frozenset((".jpg", ".jpeg"))),
    "image/png": (".png", frozenset((".png",))),
    "image/webp": (".webp", frozenset((".webp",))),
}
DOCUMENT_FIELDS = frozenset(("unit", "branch", "category", "label", "title", "documentCode", "version", "recordDate", "objectId", "process", "notes", "archiveStatus"))
UNITS = frozenset(("ALL", "WT", "RD", "CL", "SS"))
TASKS = frozenset(("overview", "simulation", "records"))
SIZES = frozenset(("desktop", "tablet", "mobile"))
FORBIDDEN = frozenset(("__proto__", "prototype", "constructor"))
ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
OBJECT_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,40}$")
PROCESS_RE = re.compile(r"^(WT|RD|CL|SS)-[0-9]{2}$")
VERSION_RE = re.compile(r"^\d{8}T\d{6}Z-[a-f0-9]{12}$")
HEX_RE = re.compile(r"^#(?:[a-fA-F0-9]{3,4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$")
RGB_RE = re.compile(r"^(rgb|rgba)\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$")
STYLE_NUMBERS = {
    "fontSize": (6, 120), "opacity": (0, 1), "borderWidth": (0, 20),
    "borderRadius": (0, 200), "zIndex": (0, 10000),
}
STYLE_COLORS = frozenset(("color", "backgroundColor", "borderColor"))
TEXT_ATTRS = frozenset(("title", "placeholder", "ariaLabel"))


class ValidationError(ValueError):
    pass


class NotFoundError(ValueError):
    pass


class ScanFormatError(ValidationError):
    pass


def document_scope(unit, branch, category=None):
    categories = DOCUMENT_CATEGORIES.get((unit, branch))
    if categories is None:
        raise ValidationError("请选择有效的单位工程及资料分支")
    result = [{"id": str(index).zfill(2), "name": name} for index, name in enumerate(categories)]
    if category is not None and category not in {item["id"] for item in result}:
        raise ValidationError("资料目录不属于所选单位工程及分支")
    return result


def scan_mime(header):
    if header.startswith(b"%PDF-"):
        return "application/pdf"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    raise ScanFormatError("文件签名不属于 PDF、JPEG、PNG 或 WEBP 扫描件")


def document_metadata(patch, previous=None, filename=""):
    _mapping(patch, DOCUMENT_FIELDS, "资料元数据")
    patch = dict(patch)
    if "title" in patch:
        if "label" in patch and patch["label"] != patch["title"]:
            raise ValidationError("label 与 title 内容不一致")
        patch["label"] = patch.pop("title")
    result = {"unit": "", "branch": "", "category": "", "label": Path(filename).stem,
              "documentCode": "", "version": "", "recordDate": "", "objectId": "", "process": "", "notes": "", "archiveStatus": "registered"}
    if previous:
        result.update({key: previous[key] for key in result})
    result.update(patch)
    for name, limit in (("unit", 2), ("branch", 12), ("category", 2), ("label", 240), ("documentCode", 160),
                        ("version", 80), ("recordDate", 10), ("objectId", 160), ("process", 5), ("notes", 4000), ("archiveStatus", 20)):
        result[name] = _text(result[name], limit, name)
    document_scope(result["unit"], result["branch"], result["category"])
    if not result["label"].strip():
        raise ValidationError("资料名称不能为空")
    if result["recordDate"]:
        try:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", result["recordDate"]):
                raise ValueError()
            dt.date.fromisoformat(result["recordDate"])
        except ValueError as exc:
            raise ValidationError("资料日期须为有效的 YYYY-MM-DD") from exc
    process = result["process"]
    if process:
        limits = {"WT": 24, "RD": 17, "CL": 21, "SS": 30}
        if not PROCESS_RE.fullmatch(process) or process[:2] != result["unit"] or not 1 <= int(process[3:]) <= limits[result["unit"]]:
            raise ValidationError("关联工序须为该单位工程已存在的工序编码，可留空")
    if result["archiveStatus"] not in ("registered", "archived"):
        raise ValidationError("archiveStatus 仅支持 registered / archived")
    return result


def empty_config():
    return {"version": 2, "profiles": {}}


def _mapping(value, keys, where):
    if type(value) is not dict:
        raise ValidationError(f"{where} 必须是对象")
    if any(key in FORBIDDEN for key in value):
        raise ValidationError(f"{where} 含禁止字段")
    unknown = set(value) - set(keys)
    if unknown:
        raise ValidationError(f"{where} 含未支持字段")
    return value


def _number(value, lo, hi, where, *, integer=False):
    try:
        finite = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite:
        raise ValidationError(f"{where} 必须是有限数值")
    if value < lo or value > hi or (integer and int(value) != value):
        raise ValidationError(f"{where} 超出允许范围")
    return int(value) if integer else value


def _text(value, limit, where):
    if type(value) is not str or len(value) > limit:
        raise ValidationError(f"{where} 必须是长度不超过 {limit} 的文本")
    if any(ord(c) < 32 and c not in "\n\r\t" for c in value):
        raise ValidationError(f"{where} 含不支持的控制字符")
    return value


def _color(value, where):
    if type(value) is not str or len(value) > 80:
        raise ValidationError(f"{where} 颜色格式无效")
    if HEX_RE.fullmatch(value):
        return value
    match = RGB_RE.fullmatch(value)
    if match:
        mode, r, g, b, alpha = match.groups()
        try:
            channels = [float(r), float(g), float(b)]
            alpha_value = float(alpha) if alpha is not None else None
        except ValueError as exc:
            raise ValidationError(f"{where} 颜色格式无效") from exc
        if any(not math.isfinite(v) or not 0 <= v <= 255 for v in channels):
            raise ValidationError(f"{where} 颜色通道超出范围")
        if (mode == "rgb" and alpha is None) or (mode == "rgba" and alpha_value is not None and 0 <= alpha_value <= 1):
            return value
    # No url(), variables, CSS expressions, gradients or selectors are accepted.
    raise ValidationError(f"{where} 仅支持十六进制或 rgb/rgba 颜色")


def validate_config(value):
    _mapping(value, ("version", "profiles", "data"), "配置")
    if type(value.get("version")) is not int or value["version"] != 2:
        raise ValidationError("不支持的配置版本，当前为 version 2")
    profiles = value.get("profiles")
    if type(profiles) is not dict or len(profiles) > 45:
        raise ValidationError("profiles 必须是最多 45 项的对象")
    clean = empty_config()
    total_nodes = 0
    for profile_id, profile in profiles.items():
        if not isinstance(profile_id, str):
            raise ValidationError("页面配置名称无效")
        parts = profile_id.split(":")
        if len(parts) != 3 or parts[0] not in UNITS or parts[1] not in TASKS or parts[2] not in SIZES:
            raise ValidationError("页面配置名称必须对应工程、模块和画幅")
        _mapping(profile, ("nodes",), profile_id)
        nodes = profile.get("nodes")
        if type(nodes) is not dict or len(nodes) > 4000:
            raise ValidationError("每个页面的 nodes 必须是最多 4000 项的对象")
        total_nodes += len(nodes)
        if total_nodes > 18000:
            raise ValidationError("配置组件总数超过限制")
        clean_nodes = {}
        for node_id, patch in nodes.items():
            if not isinstance(node_id, str) or not ID_RE.fullmatch(node_id) or node_id in FORBIDDEN:
                raise ValidationError("组件 ID 只能使用安全字母数字及 . _ : -")
            _mapping(patch, ("rect", "style", "hidden", "text", "attrs"), node_id)
            item = {}
            if "rect" in patch:
                rect = _mapping(patch["rect"], ("x", "y", "w", "h", "mode"), "rect")
                if set(rect) != {"x", "y", "w", "h", "mode"} or rect["mode"] not in ("viewport", "local"):
                    raise ValidationError("rect 必须包含 x/y/w/h 及 viewport/local 模式")
                lo, hi, extent = (-1, 2, 2) if rect["mode"] == "viewport" else (-5, 5, 5)
                item["rect"] = {
                    "x": _number(rect["x"], lo, hi, "rect.x"),
                    "y": _number(rect["y"], lo, hi, "rect.y"),
                    "w": _number(rect["w"], .001, extent, "rect.w"),
                    "h": _number(rect["h"], .001, extent, "rect.h"),
                    "mode": rect["mode"],
                }
            if "style" in patch:
                styles = _mapping(patch["style"], set(STYLE_NUMBERS) | STYLE_COLORS, "style")
                item["style"] = {}
                for name, style in styles.items():
                    if name in STYLE_COLORS:
                        item["style"][name] = _color(style, name)
                    else:
                        a, b = STYLE_NUMBERS[name]
                        item["style"][name] = _number(style, a, b, name, integer=name == "zIndex")
            if "hidden" in patch:
                if type(patch["hidden"]) is not bool:
                    raise ValidationError("hidden 必须是布尔值")
                item["hidden"] = patch["hidden"]
            if "text" in patch:
                # This value remains plain text. The UI must apply it via textContent.
                item["text"] = _text(patch["text"], 20000, "text")
            if "attrs" in patch:
                attrs = _mapping(patch["attrs"], TEXT_ATTRS, "attrs")
                item["attrs"] = {name: _text(text, 2048, name) for name, text in attrs.items()}
            clean_nodes[node_id] = item
        clean["profiles"][profile_id] = {"nodes": clean_nodes}
    if "data" in value:
        data = _mapping(value["data"], ("objects",), "data")
        objects = data.get("objects")
        if type(objects) is not dict or len(objects) > 4000:
            raise ValidationError("data.objects 必须是最多 4000 项的对象")
        clean_objects = {}
        for object_id, patch in objects.items():
            if not isinstance(object_id, str) or not OBJECT_ID_RE.fullmatch(object_id):
                raise ValidationError("业务对象 ID 无效")
            unit, separator, asset_id = object_id.partition(":")
            if not separator or unit not in ("WT", "RD", "CL", "SS") or not asset_id or asset_id in FORBIDDEN:
                raise ValidationError("业务对象 ID 必须包含有效单位工程前缀")
            _mapping(patch, ("percent", "planned", "label", "location", "group", "actual", "status"), object_id)
            result = {}
            for name in ("percent", "planned"):
                if name in patch:
                    result[name] = _number(patch[name], 0, 100, name)
            for name, limit in (("label", 200), ("location", 300), ("group", 100)):
                if name in patch:
                    result[name] = _text(patch[name], limit, name)
            if "actual" in patch:
                actual = patch["actual"]
                if type(actual) is not str or not PROCESS_RE.fullmatch(actual) or actual[:2] != unit or not 1 <= int(actual[-2:]) <= {"WT":24,"RD":17,"CL":21,"SS":30}[unit]:
                    raise ValidationError("已报工序编码须对应对象的单位工程")
                result["actual"] = actual
            if "status" in patch:
                if patch["status"] not in ("done", "active", "late", "waiting"):
                    raise ValidationError("对象状态无效")
                result["status"] = patch["status"]
            clean_objects[object_id] = result
        clean["data"] = {"objects": clean_objects}
    if len(json.dumps(clean, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_BODY:
        raise ValidationError("配置不能超过 2 MiB")
    return clean


def _json_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result or key in FORBIDDEN:
            raise ValidationError("JSON 含重复或禁止字段")
        result[key] = value
    return result


def parse_json(raw):
    try:
        return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=_json_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValidationError("JSON 数字无效")))
    except ValidationError:
        raise
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise ValidationError("JSON 格式无效") from exc


def atomic_json(path, value):
    data = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    atomic_bytes(path, data)


def atomic_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".fuyu-", suffix=".tmp", dir=path.parent, delete=False) as temp:
            temp_name = temp.name
            temp.write(data)
            temp.flush()
            os.fsync(temp.fileno())
        os.replace(temp_name, path)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.data = self.root / "data"
        self.version_dir = self.data / "versions"
        self.version_dir.mkdir(parents=True, exist_ok=True)
        if not self.data.resolve().is_relative_to(self.root) or not self.version_dir.resolve().is_relative_to(self.root):
            raise ValidationError("数据目录必须位于当前项目内")
        self.lock = threading.RLock()
        self.draft = self._config("draft.json")
        self.published = self._config("published.json")
        index = self.data / "versions.json"
        self.versions = parse_json(index.read_bytes()) if index.exists() else []
        if type(self.versions) is not list or len(self.versions) > MAX_VERSIONS:
            raise ValidationError("历史版本索引无效")
        for meta in self.versions:
            _mapping(meta, ("id", "createdAt", "label"), "历史版本")
            if set(meta) != {"id", "createdAt", "label"} or not VERSION_RE.fullmatch(str(meta["id"])):
                raise ValidationError("历史版本索引无效")
            _text(meta["label"], 160, "版本说明")
            _text(meta["createdAt"], 50, "版本时间")
        if not index.exists():
            atomic_json(index, [])
        if not (self.root / "展示配置.json").exists():
            atomic_json(self.root / "展示配置.json", self.published)

    def _config(self, name):
        path = self.data / name
        if path.exists():
            return validate_config(parse_json(path.read_bytes()))
        seed=self.root / "config" / "default-ui.json"
        value = validate_config(parse_json(seed.read_bytes())) if seed.exists() else empty_config()
        atomic_json(path, value)
        return value

    def state(self):
        with self.lock:
            return copy.deepcopy({"draft": self.draft, "published": self.published, "versions": self.versions})

    def save_draft(self, config):
        clean = validate_config(config)
        with self.lock:
            atomic_json(self.data / "draft.json", clean)
            self.draft = clean
            return copy.deepcopy(clean)

    def publish(self, config=None, label=""):
        _text(label, 160, "版本说明")
        with self.lock:
            clean = validate_config(self.draft if config is None else config)
            frontend = self._baked_frontend(clean)
            now = dt.datetime.now(dt.timezone.utc)
            meta = {"id": now.strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:12],
                    "createdAt": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
                    "label": label.strip() or "发布版本"}
            new_versions = [meta] + self.versions
            removed = new_versions[MAX_VERSIONS:]
            new_versions = new_versions[:MAX_VERSIONS]
            atomic_json(self.version_dir / (meta["id"] + ".json"), {**meta, "config": clean})
            atomic_json(self.data / "draft.json", clean)
            atomic_json(self.data / "published.json", clean)
            atomic_json(self.root / "展示配置.json", clean)
            if frontend is not None:
                atomic_bytes(self.root / "frontend.html", frontend.encode("utf-8"))
            atomic_json(self.data / "versions.json", new_versions)
            self.draft = copy.deepcopy(clean)
            self.published = clean
            self.versions = new_versions
            for old in removed:
                # IDs are validated; pruning never accepts a client-provided path.
                path = self.version_dir / (old["id"] + ".json")
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
            return copy.deepcopy({"published": clean, "version": meta})

    def _baked_frontend(self, config):
        path = self.root / "frontend.html"
        if not path.exists():
            return None
        html = path.read_text(encoding="utf-8-sig")
        pattern = re.compile(r'''(<script\b(?=[^>]*\bid\s*=\s*["']fuyu-display-config["'])[^>]*>)([\s\S]*?)(</script\s*>)''', re.I)
        matches = list(pattern.finditer(html))
        if len(matches) != 1 or not re.search(r'''\btype\s*=\s*["']application/json["']''', matches[0][1], re.I):
            raise ValidationError("展示页面缺少唯一的 JSON 配置标记，未执行发布")
        payload = json.dumps(config, ensure_ascii=False, separators=(",", ":"), allow_nan=False).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        return pattern.sub(lambda m: m[1] + payload + m[3], html, count=1)

    def restore(self, version_id):
        if type(version_id) is not str or not VERSION_RE.fullmatch(version_id):
            raise ValidationError("历史版本 ID 无效")
        with self.lock:
            if not any(meta["id"] == version_id for meta in self.versions):
                raise NotFoundError("历史版本不存在")
            path = self.version_dir / (version_id + ".json")
            if not path.is_file():
                raise NotFoundError("历史版本文件不存在")
            snapshot = parse_json(path.read_bytes())
            _mapping(snapshot, ("id", "createdAt", "label", "config"), "历史快照")
            if snapshot.get("id") != version_id:
                raise ValidationError("历史快照 ID 不一致")
            clean = validate_config(snapshot.get("config"))
            self.save_draft(clean)
            return copy.deepcopy(clean)


class DocumentStore:
    """An independent register of local scanned files, never part of UI config."""
    RECORD_FIELDS = frozenset(("id", "unit", "branch", "category", "label", "filename", "mime", "bytes", "sha256", "documentCode", "version", "recordDate", "objectId", "process", "notes", "archiveStatus", "reviewStatus", "uploadedAt", "updatedAt", "sourceType"))

    def __init__(self, root):
        self.root = Path(root).resolve()
        self.folder = self.root / "data" / "documents"
        self.blobs = self.folder / "blobs"
        self.blobs.mkdir(parents=True, exist_ok=True)
        if not self.folder.resolve().is_relative_to(self.root) or not self.blobs.resolve().is_relative_to(self.root):
            raise ValidationError("扫描件目录必须位于当前项目内")
        self.index_path = self.folder / "index.json"
        self.lock = threading.RLock()
        self.records = []
        if self.index_path.exists():
            index = parse_json(self.index_path.read_bytes())
            _mapping(index, ("version", "documents"), "扫描件登记表")
            if index.get("version") != 1 or type(index.get("documents")) is not list or len(index["documents"]) > 10000:
                raise ValidationError("扫描件登记表格式无效")
            ids = set()
            for row in index["documents"]:
                _mapping(row, self.RECORD_FIELDS, "扫描件记录")
                if set(row) != self.RECORD_FIELDS or type(row["id"]) is not str or not DOCUMENT_ID_RE.fullmatch(row["id"]) or row["id"] in ids:
                    raise ValidationError("扫描件记录 ID 无效或重复")
                ids.add(row["id"])
                document_metadata({k: row[k] for k in DOCUMENT_FIELDS if k != "title"})
                self.validate_filename(row["filename"])
                if row["mime"] not in SCAN_TYPES or Path(row["filename"]).suffix.lower() not in SCAN_TYPES[row["mime"]][1]:
                    raise ValidationError("扫描件格式记录无效")
                _number(row["bytes"], 1, MAX_SCAN_BYTES, "附件字节数", integer=True)
                if type(row["sha256"]) is not str or not re.fullmatch(r"[a-f0-9]{64}", row["sha256"]):
                    raise ValidationError("扫描件校验记录无效")
                if row["reviewStatus"] != "pending_manual" or row["sourceType"] != "local_upload":
                    raise ValidationError("扫描件来源或核验状态无效")
                _text(row["uploadedAt"], 50, "登记时间")
                _text(row["updatedAt"], 50, "更新时间")
                self.records.append(row)
        else:
            atomic_json(self.index_path, {"version": 1, "documents": []})

    @staticmethod
    def validate_filename(filename):
        _text(filename, 240, "filename")
        if not filename.strip() or any(c in filename for c in "/\\:\r\n") or filename.strip(" .") == "":
            raise ValidationError("原始文件名无效，请只提交文件名")
        if Path(filename).suffix.lower() not in set().union(*(v[1] for v in SCAN_TYPES.values())):
            raise ScanFormatError("只接收 .pdf、.jpg、.jpeg、.png、.webp 文件")

    @staticmethod
    def public(row):
        value = copy.deepcopy(row)
        value["fileUrl"] = "/api/documents/" + value["id"] + "/file"
        value["verificationNote"] = "附件已登记；扫描件真实性、完整性及验收结果待人工核验。人工核验说明可记录在备注中。"
        return value

    def list(self, unit, branch, category=None):
        categories = document_scope(unit, branch, category)
        with self.lock:
            rows = [self.public(r) for r in self.records if r["unit"] == unit and r["branch"] == branch and (category is None or r["category"] == category)]
        rows.sort(key=lambda r: (r["uploadedAt"], r["id"]), reverse=True)
        return {"unit": unit, "branch": branch, "categories": categories, "documents": rows}

    def upload(self, stream, length, declared_mime, metadata, filename):
        self.validate_filename(filename)
        clean = document_metadata(metadata, filename=filename)
        if not 1 <= length <= MAX_SCAN_BYTES:
            raise ValidationError("扫描件不能为空且不能超过 40 MiB")
        if declared_mime not in set(SCAN_TYPES) | {"application/octet-stream", ""}:
            raise ScanFormatError("扫描件 MIME 类型不受支持")
        with self.lock:
            if len(self.records) >= 10000:
                raise ValidationError("扫描件登记数量已达本地限制")
        temp_name = None
        final = None
        committed = False
        try:
            h = hashlib.sha256()
            head = b""
            with tempfile.NamedTemporaryFile(prefix=".upload-", suffix=".tmp", dir=self.blobs, delete=False) as temp:
                temp_name = Path(temp.name)
                remaining = length
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValidationError("扫描件上传不完整")
                    if len(head) < 32:
                        head += chunk[:32 - len(head)]
                    h.update(chunk)
                    temp.write(chunk)
                    remaining -= len(chunk)
                temp.flush()
                os.fsync(temp.fileno())
            actual_mime = scan_mime(head)
            extension, allowed_extensions = SCAN_TYPES[actual_mime]
            if Path(filename).suffix.lower() not in allowed_extensions or declared_mime not in (actual_mime, "application/octet-stream", ""):
                raise ScanFormatError("文件扩展名、MIME 与实际文件签名不一致")
            now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            document_id = uuid.uuid4().hex
            row = {"id": document_id, **clean, "filename": filename, "mime": actual_mime, "bytes": length,
                   "sha256": h.hexdigest(), "uploadedAt": now, "updatedAt": now, "reviewStatus": "pending_manual", "sourceType": "local_upload"}
            final = self.blobs / (document_id + extension)
            with self.lock:
                if len(self.records) >= 10000 or final.exists():
                    raise ValidationError("附件登记失败，请重试")
                os.replace(temp_name, final)
                temp_name = None
                updated = [*self.records, row]
                atomic_json(self.index_path, {"version": 1, "documents": updated})
                self.records = updated
                committed = True
            return self.public(row)
        finally:
            if temp_name and temp_name.exists():
                temp_name.unlink()
            if final and not committed and final.exists():
                final.unlink()

    def update(self, document_id, patch):
        if not DOCUMENT_ID_RE.fullmatch(document_id):
            raise ValidationError("扫描件 ID 无效")
        with self.lock:
            old = next((r for r in self.records if r["id"] == document_id), None)
            if old is None:
                raise NotFoundError("扫描件记录不存在")
            clean = document_metadata(patch, previous=old)
            row = {**old, **clean, "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")}
            updated = [row if r["id"] == document_id else r for r in self.records]
            atomic_json(self.index_path, {"version": 1, "documents": updated})
            self.records = updated
            return self.public(row)

    def file(self, document_id):
        if not DOCUMENT_ID_RE.fullmatch(document_id):
            raise NotFoundError("扫描件记录不存在")
        with self.lock:
            row = next((r for r in self.records if r["id"] == document_id), None)
            if row is None:
                raise NotFoundError("扫描件记录不存在")
            path = self.blobs / (document_id + SCAN_TYPES[row["mime"]][0])
            if not path.resolve().is_relative_to(self.blobs.resolve()) or not path.is_file():
                raise NotFoundError("扫描件原件尚不可用")
            if path.stat().st_size != row["bytes"]:
                raise ValidationError("扫描件原件大小与登记记录不一致，请人工检查")
            return copy.deepcopy(row), path


class FuyuServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, root):
        self.root = Path(root).resolve()
        self.store = Store(self.root)
        self.documents = DocumentStore(self.root)
        self.deepseek = DeepSeekService(self.root)
        self.knowledge = KnowledgeStore(self.root)
        self.agent = AgentService(self.root, self.knowledge, self.deepseek)
        self.interfaces = InterfaceStore(self.root)
        super().__init__(address, Handler)


    def server_close(self):
        self.knowledge.close()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    server_version = "FuyuLocal/10.0"
    sys_version = ""

    def _reply(self, status, value, *, head=False):
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if not head:
            self.wfile.write(raw)

    def _error(self, status, message):
        self._reply(status, {"ok": False, "error": message})

    def _host(self):
        values = self.headers.get_all("Host", [])
        if len(values) != 1:
            self._error(400, "请求 Host 无效")
            return None
        try:
            host = urlsplit("http://" + values[0])
            if (host.hostname not in ("127.0.0.1", "localhost") or host.username or host.password
                    or host.path or host.query or host.fragment
                    or (host.port or 80) != self.server.server_port):
                raise ValueError()
        except ValueError:
            self._error(403, "仅允许本机地址访问")
            return None
        return host

    def _mutating(self):
        host = self._host()
        if host is None:
            return False
        origins = self.headers.get_all("Origin", [])
        if len(origins) > 1:
            self._error(403, "Origin 无效")
            return False
        if origins:
            try:
                origin = urlsplit(origins[0])
                if (origin.scheme != "http" or origin.hostname != host.hostname or origin.port != host.port
                        or origin.username or origin.password or origin.path or origin.query or origin.fragment):
                    raise ValueError()
            except ValueError:
                self._error(403, "仅允许本机同源页面修改配置")
                return False
        return True

    def _body(self):
        if self.headers.get("Transfer-Encoding"):
            raise ValidationError("不支持分块请求体")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not re.fullmatch(r"\d{1,10}", lengths[0]):
            raise ValidationError("请求长度无效")
        length = int(lengths[0])
        if length > MAX_BODY:
            self._reject_body(413, "配置请求不能超过 2 MiB", length)
            return None
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            self._reject_body(415, "请求内容必须为 application/json", length)
            return None
        self.connection.settimeout(10)
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValidationError("请求内容不完整")
        value = parse_json(raw)
        if value is None:
            raise ValidationError("请求内容必须是 JSON 对象")
        return value

    def _query(self, allowed):
        try:
            values = parse_qs(urlsplit(self.path).query, keep_blank_values=True, max_num_fields=32, encoding="utf-8", errors="strict")
        except (ValueError, UnicodeError) as exc:
            raise ValidationError("查询字段格式无效") from exc
        if set(values) - set(allowed) or any(len(v) != 1 for v in values.values()):
            raise ValidationError("查询含重复或未支持的字段")
        return {key: value[0] for key, value in values.items()}

    def _scan_upload(self):
        metadata = self._query(DOCUMENT_FIELDS | {"filename"})
        filename = metadata.pop("filename", "")
        if self.headers.get("Transfer-Encoding"):
            raise ValidationError("扫描件不支持分块请求，请提交单个文件")
        values = self.headers.get_all("Content-Length", [])
        if len(values) != 1 or not re.fullmatch(r"\d{1,10}", values[0]):
            raise ValidationError("扫描件请求长度无效")
        length = int(values[0])
        if length > MAX_SCAN_BYTES:
            self._reject_body(413, "单个扫描件不能超过 40 MiB", length)
            return
        self.connection.settimeout(30)
        mime = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        record = self.server.documents.upload(self.rfile, length, mime, metadata, filename)
        self._reply(201, {"ok": True, "document": record})

    def _document_file(self, document_id, *, head=False):
        query = self._query(("download",))
        if query.get("download", "0") not in ("0", "1"):
            raise ValidationError("download 只支持 0 / 1")
        row, path = self.server.documents.file(document_id)
        size = row["bytes"]
        low, high, status = 0, size - 1, 200
        ranges = self.headers.get_all("Range", [])
        if ranges:
            match = re.fullmatch(r"bytes=(\d{0,20})-(\d{0,20})", ranges[0]) if len(ranges) == 1 else None
            valid = bool(match and (match[1] or match[2]))
            if valid:
                if not match[1]:
                    suffix = int(match[2])
                    valid = suffix > 0
                    low = max(0, size - suffix)
                else:
                    low = int(match[1])
                    high = min(size - 1, int(match[2])) if match[2] else size - 1
                valid = valid and 0 <= low <= high < size
            if not valid:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", row["mime"])
        self.send_header("Content-Length", str(high - low + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        disposition = "attachment" if query.get("download") == "1" else "inline"
        extension = SCAN_TYPES[row["mime"]][0]
        self.send_header("Content-Disposition", f"{disposition}; filename=\"scan{extension}\"; filename*=UTF-8''{quote(row['filename'], safe='')}")
        if status == 206:
            self.send_header("Content-Range", f"bytes {low}-{high}/{size}")
        self.end_headers()
        if head:
            return
        try:
            with path.open("rb") as file:
                file.seek(low)
                remaining = high - low + 1
                while remaining:
                    chunk = file.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            # Browsers routinely cancel old preview/range requests.
            pass

    def _reject_body(self, status, message, length):
        self._error(status, message)
        self.wfile.flush()
        self.close_connection = True
        # Drain only a bounded amount, so a normal oversized upload receives its
        # JSON 413 response instead of a Windows TCP reset from unread input.
        remaining = min(length, MAX_BODY + 65536)
        self.connection.settimeout(.3)
        try:
            while remaining:
                chunk = self.rfile.read1(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
        except OSError:
            pass

    def do_HEAD(self):
        self._get(head=True)

    def do_GET(self):
        self._get()

    def _get(self, head=False):
        if self._host() is None:
            return
        try:
            path = urlsplit(self.path).path
            if path == "/api/state":
                state = self.server.store.state()
                state["service"] = {"name": "fuyu-ui-studio", "revision": "10.0", "workspace": str(self.server.root.resolve())}
                self._reply(200, state, head=head)
            elif path == "/api/published":
                self._reply(200, self.server.store.state()["published"], head=head)
            elif path == "/api/settings":
                self._reply(200, self.server.deepseek.get(), head=head)
            elif path == "/api/system/status":
                self._reply(200, {"revision":"10.0","mode":"local","knowledge":self.server.knowledge.status(),"interfaces":len(self.server.interfaces.list()["interfaces"])}, head=head)
            elif path == "/api/agent/conversations":
                self._reply(200, self.server.agent.list(), head=head)
            elif re.fullmatch(r"/api/agent/conversations/[a-f0-9]{32}", path):
                self._reply(200, self.server.agent.get(path.rsplit("/",1)[1]), head=head)
            elif path == "/api/interfaces":
                self._reply(200, self.server.interfaces.list(), head=head)
            elif path.startswith("/api/knowledge/"):
                self._knowledge_get(path, head=head)
            elif path == "/api/documents":
                query = self._query(("unit", "branch", "category"))
                result = self.server.documents.list(query.get("unit", ""), query.get("branch", ""), query.get("category"))
                self._reply(200, result, head=head)
            elif re.fullmatch(r"/api/documents/[a-f0-9]{32}/file", path):
                self._document_file(path.split("/")[3], head=head)
            elif path.startswith("/api/"):
                self._error(404, "接口不存在")
            else:
                self._static(path, head=head)
        except (DeepSeekError, KnowledgeError, InterfaceError) as exc:
            self._error(exc.status, str(exc))
        except ValidationError as exc:
            self._error(400, str(exc))
        except NotFoundError as exc:
            self._error(404, str(exc))
        except (OSError, ValueError):
            self._error(500, "读取失败，请检查本地文件")

    def _knowledge_get(self, path, *, head=False):
        store=self.server.knowledge
        if path=="/api/knowledge/status":value=store.status()
        elif path=="/api/knowledge/settings":value=store.settings()
        elif path=="/api/knowledge/groups":value=store.groups()
        elif path=="/api/knowledge/documents":value=store.list_documents(self._query(("unit","groupId","q","search","includeArchived","objectId","process","documentIds")))
        elif path=="/api/knowledge/search":
            query=self._query(("q","query","unit","groupId","documentIds","objectId","process","limit"))
            query["query"]=query.pop("q",query.get("query",""))
            if "limit" in query:
                try:query["limit"]=int(query["limit"])
                except ValueError:raise ValidationError("检索条数无效")
            value=store.search(query)
        else:
            match=re.fullmatch(r"/api/knowledge/documents/([a-f0-9]{32})(?:/(content|source))?",path)
            if not match:raise KnowledgeError("知识库接口不存在",404)
            ident,action=match.groups()
            if action=="source":
                file,mime,name=store.source(ident)
                self._source_file(file,mime,name,head=head)
                return
            if action=="content":
                query=self._query(("page",))
                value=store.content(ident,query.get("page"))
            else:value={"document":store.document(ident)}
        self._reply(200,value,head=head)

    def _knowledge_mutate(self, method, path):
        store=self.server.knowledge
        if path=="/api/knowledge/documents" and method=="POST":
            meta=self._query(("filename","label","unit","groupId","objectId","process","notes"))
            filename=meta.pop("filename","")
            lengths=self.headers.get_all("Content-Length",[])
            if self.headers.get("Transfer-Encoding") or len(lengths)!=1 or not re.fullmatch(r"\d{1,10}",lengths[0]):raise ValidationError("文件长度无效")
            length=int(lengths[0])
            if not 0<length<=MAX_SCAN_BYTES:
                self._reject_body(413,"单个知识文件须为非空文件且不超过 40 MiB",length);return
            self.connection.settimeout(30)
            raw=self.rfile.read(length)
            if len(raw)!=length:raise ValidationError("文件上传不完整")
            self._reply(201,store.upload(raw,filename,self.headers.get("Content-Type","").split(";",1)[0],meta));return
        body=self._body()
        if body is None:return
        if path=="/api/knowledge/settings" and method=="PUT":value=store.update_settings(body)
        elif path=="/api/knowledge/groups" and method=="POST":value=store.create_group(body)
        else:
            match=re.fullmatch(r"/api/knowledge/documents/([a-f0-9]{32})(/reparse)?",path)
            if not match:raise KnowledgeError("知识库接口不存在",404)
            ident,action=match.groups()
            if action and method=="POST" and body=={}:value={"document":store.reparse(ident)}
            elif not action and method=="PUT":value={"document":store.update_document(ident,body)}
            else:raise KnowledgeError("知识库操作无效",405)
        self._reply(200,value)

    def _interfaces_mutate(self, method, path):
        body=self._body()
        if body is None:return
        if path=="/api/interfaces" and method=="POST":value=self.server.interfaces.save(body)
        else:
            match=re.fullmatch(r"/api/interfaces/([a-f0-9]{32})(?:/(test|apply))?",path)
            if not match:raise InterfaceError("数据接口不存在",404)
            ident,action=match.groups()
            if not action and method=="PUT":value=self.server.interfaces.save({**body,"id":ident})
            elif method=="POST" and action and body=={}:
                value=self.server.interfaces.test(ident)
                if action=="apply":
                    if value.get("rejectedRows") or value.get("warnings") or not value.get("preview"):raise InterfaceError("接口预览包含警告或没有有效对象，请修正映射后重试。",422)
                    config=self.server.store.state()["draft"]
                    config.setdefault("data",{}).setdefault("objects",{})
                    catalog_path=self.server.root/'config/object-catalog.json'
                    if catalog_path.exists():
                        catalog=parse_json(catalog_path.read_bytes())
                        unknown=[row['objectId'] for row in value['preview'] if row['objectId'] not in catalog.get(value['unit'],[])]
                        if unknown:raise InterfaceError('接口包含场景中尚未登记的对象：'+', '.join(unknown[:10]),422)
                    for row in value["preview"]:
                        key=value["unit"]+":"+row["objectId"]
                        config["data"]["objects"].setdefault(key,{}).update(row["values"])
                    value={**value,"draft":self.server.store.save_draft(config),"message":"接口数据已应用到后台草稿，检查后发布。"}
            else:raise InterfaceError("数据接口操作无效",405)
        self._reply(200,value)

    def _source_file(self, path, mime, name, *, head=False):
        query=self._query(("download",))
        if query.get("download","0") not in ("0","1"):raise ValidationError("下载参数无效")
        size=path.stat().st_size;low=0;high=size-1;status=200
        value=self.headers.get("Range")
        if value:
            match=re.fullmatch(r"bytes=(\d*)-(\d*)",value.strip())
            if not match or not any(match.groups()):
                self.send_response(416);self.send_header("Content-Range",f"bytes */{size}");self.send_header("Content-Length","0");self.end_headers();return
            a,b=match.groups()
            if a:low=int(a);high=min(int(b),size-1) if b else size-1
            else:low=max(0,size-int(b))
            if low>=size or high<low:
                self.send_response(416);self.send_header("Content-Range",f"bytes */{size}");self.send_header("Content-Length","0");self.end_headers();return
            status=206
        self.send_response(status);self.send_header("Content-Type",mime)
        self.send_header("Content-Length",str(high-low+1));self.send_header("Accept-Ranges","bytes")
        if status==206:self.send_header("Content-Range",f"bytes {low}-{high}/{size}")
        self.send_header("Content-Disposition",("attachment" if query.get("download")=="1" else "inline")+"; filename*=UTF-8''"+quote(name,safe=""))
        self.send_header("Cache-Control","no-store");self.send_header("X-Content-Type-Options","nosniff");self.end_headers()
        if not head:
            with path.open("rb") as stream:
                stream.seek(low);remaining=high-low+1
                while remaining:
                    chunk=stream.read(min(65536,remaining))
                    if not chunk:break
                    self.wfile.write(chunk);remaining-=len(chunk)

    def _static(self, raw_path, head=False):
        decoded = unquote(raw_path, errors="strict").replace("\\", "/")
        parts = decoded.split("/")
        if (not decoded.startswith("/") or any(p in (".", "..") or ":" in p or "\x00" in p for p in parts)
                or any(p.lower() in ("data", "开发源码", ".git", "node_modules") for p in parts)
                or any(p.startswith(".") for p in parts if p)):
            self._error(403, "文件路径不可访问")
            return
        relative = decoded.lstrip("/") or "frontend.html"
        target = (self.server.root / relative).resolve()
        if not target.is_relative_to(self.server.root):
            self._error(403, "文件路径不可访问")
            return
        if any(part.lower() in ("data", "开发源码", ".git", "node_modules") for part in target.relative_to(self.server.root).parts):
            self._error(403, "文件路径不可访问")
            return
        if not target.is_file():
            self._error(404, "文件不存在")
            return
        if target.suffix.lower() not in (".html", ".htm", ".css", ".js", ".json", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp", ".txt", ".pdf", ".zip"):
            self._error(403, "文件类型不可访问")
            return
        raw = target.read_bytes()
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix.lower() == ".js":
            mime = "text/javascript"
        if mime.startswith("text/") or mime in ("application/json", "text/javascript"):
            mime += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if not head:
            self.wfile.write(raw)

    def do_PUT(self):
        self._mutate("PUT")

    def do_POST(self):
        self._mutate("POST")

    def do_DELETE(self):
        if self._host() is not None:
            self._error(405, "未提供资料删除操作，可通过归档状态进行可逆管理")

    def _mutate(self, method):
        if not self._mutating():
            return
        try:
            path = urlsplit(self.path).path
            if path.startswith("/api/knowledge/"):
                self._knowledge_mutate(method, path)
                return
            if path == "/api/agent/conversations" and method == "POST":
                body=self._body()
                if body is not None:self._reply(201,self.server.agent.create(body))
                return
            if path == "/api/interfaces" or path.startswith("/api/interfaces/"):
                self._interfaces_mutate(method,path)
                return
            if method == "POST" and path == "/api/documents":
                self._scan_upload()
                return
            if method == "PUT" and re.fullmatch(r"/api/documents/[a-f0-9]{32}", path):
                body = self._body()
                if body is not None:
                    record = self.server.documents.update(path.split("/")[3], body)
                    self._reply(200, {"ok": True, "document": record})
                return
            if (method, path) in (("PUT", "/api/settings"), ("POST", "/api/settings/test"), ("POST", "/api/chat")):
                body = self._body()
                if body is not None:
                    operation = self.server.deepseek.update if method == "PUT" else self.server.deepseek.test if path.endswith("/test") else self.server.agent.chat
                    self._reply(200, operation(body))
                return
            if (method, path) not in (("PUT", "/api/draft"), ("POST", "/api/publish"), ("POST", "/api/restore")):
                self._error(404, "接口不存在")
                return
            body = self._body()
            if body is None:
                return
            if path == "/api/draft":
                self._reply(200, {"ok": True, "draft": self.server.store.save_draft(body)})
            elif path == "/api/publish":
                _mapping(body, ("config", "label"), "发布请求")
                result = self.server.store.publish(body.get("config"), body.get("label", ""))
                self._reply(200, {"ok": True, **result})
            else:
                _mapping(body, ("id",), "恢复请求")
                result = self.server.store.restore(body.get("id"))
                self._reply(200, {"ok": True, "draft": result, "restored": body["id"]})
        except (DeepSeekError, KnowledgeError, InterfaceError) as exc:
            self._error(exc.status, str(exc))
        except ScanFormatError as exc:
            self._error(415, str(exc))
        except ValidationError as exc:
            self._error(400, str(exc))
        except NotFoundError as exc:
            self._error(404, str(exc))
        except (OSError, ValueError, TimeoutError):
            self._error(500, "配置保存失败，请检查本地数据目录")

    def log_message(self, fmt, *args):
        # Do not print request bodies or configuration text.
        sys.stderr.write("[Fuyu] " + fmt % args + "\n")


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="扶余一号 UI 展示与控制后台（本机服务）")
    parser.add_argument("--port", type=int, default=8779)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1 到 65535 之间")
    root = Path(__file__).resolve().parent.parent
    try:
        server = FuyuServer(("127.0.0.1", args.port), root)
    except (OSError, ValidationError):
        print("本地服务启动失败：请确认端口未占用，且数据目录可读写。", file=sys.stderr)
        return 1
    print(f"展示前端: http://127.0.0.1:{args.port}/frontend.html", flush=True)
    print(f"控制后台: http://127.0.0.1:{args.port}/admin.html", flush=True)
    try:
        server.serve_forever(poll_interval=.4)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
