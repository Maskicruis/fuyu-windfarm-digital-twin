"""Versioned embedding contract around the existing knowledge and agent services.

No parser/model implementation lives here: the HTTP host maps aliases to its
existing handlers. This module is intentionally independent of Fuyu's UI/server.
"""
from __future__ import annotations
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit, urlunsplit
from deepseek_service import DeepSeekError, _context

PREFIX = '/api/plugin/v1'
PROTOCOL = 'twin-knowledge/v1'
UNITS = {'ALL', 'WT', 'RD', 'CL', 'SS'}


class PluginError(DeepSeekError):
    pass


def canonical_origin(value):
    if not isinstance(value, str) or len(value) > 500:
        raise PluginError('宿主来源无效。', 400)
    u = urlsplit(value)
    try:
        port = u.port
    except ValueError:
        raise PluginError('宿主来源端口无效。', 400) from None
    if (u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password
            or u.path not in ('', '/') or u.query or u.fragment):
        raise PluginError('宿主来源必须为完整 HTTP(S) origin，不允许通配符、路径或凭据。', 400)
    host = u.hostname.lower()
    if not re.fullmatch(r'[a-z0-9.-]+|[0-9a-f:]+', host):
        raise PluginError('宿主来源域名无效。', 400)
    if ':' in host:
        host = '[' + host + ']'
    default = 80 if u.scheme == 'http' else 443
    return f'{u.scheme}://{host}' + (f':{port}' if port and port != default else '')


def validate_context(value):
    """Validate neutral context without assuming a particular 3D engine.

    Other systems use ALL plus host/system/project fields; wind-farm unit codes
    are optional filters, never inferred from arbitrary labels or coordinates.
    """
    if type(value) is not dict:
        raise PluginError('场景上下文必须为对象。')
    allowed = {'systemId', 'projectId', 'scope', 'unit', 'object', 'process',
               'location', 'module', 'summary', 'host', 'selection', 'progress',
               'resources', 'technology', 'quality', 'unitLabel', 'project'}
    if set(value) - allowed:
        raise PluginError('场景上下文含未登记字段，请放入 host 扩展对象。')
    try:
        clean = _context(value)
    except DeepSeekError as error:
        raise PluginError(str(error), error.status) from None
    if len(json.dumps(clean, ensure_ascii=False, allow_nan=False)) > 24000:
        raise PluginError('场景上下文不能超过 24000 字符。')
    for field in ('systemId', 'projectId', 'module', 'summary', 'unitLabel'):
        if field in clean and (not isinstance(clean[field], str) or len(clean[field]) > (2000 if field == 'summary' else 160)):
            raise PluginError(field + ' 格式无效。')
    for field in ('scope', 'unit'):
        if field in clean and clean[field] not in UNITS:
            raise PluginError('通用宿主请选择 ALL 工程范围，领域信息放入 host。')
    for field in ('object', 'process'):
        if field in clean:
            item = clean[field]
            if type(item) is not dict:
                raise PluginError(field + ' 必须为对象。')
            ident = item.get('id' if field == 'object' else 'code', '')
            if not isinstance(ident, str) or len(ident) > 160:
                raise PluginError(field + ' 标识无效。')
    clean.setdefault('scope', clean.get('unit', 'ALL'))
    clean.setdefault('unit', clean['scope'])
    return clean


class PluginAdapter:
    def __init__(self, root, *, allowed_origins=None, token=None, allow_configuration=None):
        self.root = Path(root)
        config_path = self.root / 'data' / 'plugin-settings.json'
        config = {}
        if config_path.is_file():
            config = json.loads(config_path.read_text('utf-8'))
            if type(config) is not dict:
                raise PluginError('组件接入配置必须为对象。')
        values = allowed_origins if allowed_origins is not None else config.get('allowedOrigins', [])
        if type(values) not in (tuple, list) or len(values) > 32:
            raise PluginError('宿主来源列表无效。')
        self.allowed_origins = tuple(dict.fromkeys(canonical_origin(v) for v in values))
        secret = token if token is not None else os.environ.get('FUYU_PLUGIN_TOKEN', '')
        if not isinstance(secret, str) or (secret and (len(secret) < 32 or len(secret) > 256 or not re.fullmatch(r'[!-~]+', secret))):
            raise PluginError('组件集成令牌须为 32–256 位无空白 ASCII 字符。')
        # Keep a digest only; never place integration/model credentials in URLs,
        # manifests, browser iframe messages, logs, or exported UI configuration.
        self.token_digest = hashlib.sha256(secret.encode()).digest() if secret else None
        self.allow_configuration = bool(config.get('allowConfiguration', False) if allow_configuration is None else allow_configuration)

    def manifest(self):
        return {'id': 'twin-knowledge-agent', 'name': '数字孪生知识与智能体组件',
                'version': '1.0.0', 'protocol': PROTOCOL, 'apiVersion': 'v1',
                'apiBase': PREFIX, 'widgetUrl': '/plugin/widget.html',
                'sdkUrl': '/plugin/twin-knowledge-sdk.js', 'openapiUrl': '/plugin/openapi.json',
                'allowedHostOrigins': list(self.allowed_origins),
                'crossOriginApiEnabled': bool(self.allowed_origins and self.token_digest),
                'configurationApiForExternalHosts': self.allow_configuration,
                'capabilities': ['context', 'chat.sse', 'reasoning.sse', 'history', 'documents.upload',
                                 'documents.parse', 'documents.search', 'citations.exact', 'scene.focus.request'],
                'events': ['ready', 'context.accepted', 'focus.request', 'close.request', 'error']}

    def rewrite_path(self, raw_path):
        """Return an existing handler path for a declared alias, otherwise None."""
        u = urlsplit(raw_path)
        if not u.path.startswith(PREFIX + '/'):
            return None
        route = u.path[len(PREFIX):]
        static = {'/settings': '/api/settings', '/settings/test': '/api/settings/test',
                  '/chat': '/api/chat', '/chat/stream': '/api/chat/stream',
                  '/conversations': '/api/agent/conversations'}
        target = static.get(route)
        if re.fullmatch(r'/conversations/[a-f0-9]{32}', route):
            target = '/api/agent' + route
        if re.fullmatch(r'/knowledge/(status|settings|groups|documents|search)', route) or re.fullmatch(
                r'/knowledge/documents/[a-f0-9]{32}(?:/(content|source|locate|reparse))?', route):
            target = '/api' + route
        return urlunsplit(('', '', target, u.query, '')) if target else None

    def public_response(self, value):
        if isinstance(value, dict):
            return {key: self.public_response(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.public_response(item) for item in value]
        if isinstance(value, str) and value.startswith('/api/knowledge/'):
            return PREFIX + value[len('/api'):]
        return value

    def normalize_body(self, path, body):
        if urlsplit(path).path in (PREFIX + '/chat', PREFIX + '/chat/stream'):
            if type(body) is not dict:
                raise PluginError('组件对话请求必须为对象。')
            body = {**body, 'context': validate_context(body.get('context', {}))}
        return body

    def authorize(self, origin, authorization, local_origin, *, configure=False, same_origin_browser=False):
        """Same-origin remains local; cross-origin requires allowlist AND bearer.

        Server-side/native clients have no Origin and require bearer on this
        versioned API. Legacy local UI endpoints keep their own same-origin guard.
        """
        local = canonical_origin(local_origin)
        if not origin and same_origin_browser:
            return True
        if origin:
            given = canonical_origin(origin)
            if given == local:
                return True
            if given not in self.allowed_origins:
                raise PluginError('组件未授权此宿主来源。', 403)
        if not self.token_digest or not isinstance(authorization, str) or not authorization.startswith('Bearer '):
            raise PluginError('组件跨来源或原生接入需要有效的集成令牌。', 401)
        candidate = authorization[7:]
        if not hmac.compare_digest(hashlib.sha256(candidate.encode()).digest(), self.token_digest):
            raise PluginError('组件集成令牌无效。', 401)
        if configure and not self.allow_configuration:
            raise PluginError('外部宿主未获准修改模型或解析设置，请在组件本机设置中配置。', 403)
        return True

    def cors_headers(self, origin):
        if not origin:
            return {}
        given = canonical_origin(origin)
        if given not in self.allowed_origins or not self.token_digest:
            return {}
        return {'Access-Control-Allow-Origin': given, 'Vary': 'Origin',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                'Access-Control-Max-Age': '600'}


def build_assets(root):
    """Assemble shared settings/source-reader UI without the Fuyu 3D scene."""
    root = Path(root)
    target = root / 'plugin'
    target.mkdir(exist_ok=True)
    for feature in ('system-settings', 'knowledge-ui'):
        for extension in ('js', 'css'):
            source = (root / '开发源码' / f'{feature}.{extension}').read_text('utf-8')
            if extension == 'js':
                source = source.replace("'/api/settings", "'/api/plugin/v1/settings")
                source = source.replace("'/api/knowledge", "'/api/plugin/v1/knowledge")
                source = source.replace('请通过“启动控制后台.cmd”或“打开前端展示.cmd”运行本地服务，再配置 DeepSeek。', '请运行数字孪生 EXE 或组件服务，再配置 API。')
            (target / f'shared-{feature}.{extension}').write_text(source, 'utf-8')
