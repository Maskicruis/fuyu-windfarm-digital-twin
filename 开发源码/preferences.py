"""Non-secret project display preferences, separate from model credentials and UI drafts."""
import datetime
import json
import threading
from pathlib import Path

DEFAULTS = dict(projectName='中车扶余一号 · 建设施工', projectSubtitle='WIND FARM · CONSTRUCTION DIGITAL TWIN',
                dataDate='2026-10-30', defaultUnit='ALL', overview={})


class Preferences:
    def __init__(self, workspace):
        self.path = Path(workspace) / 'data' / 'project-preferences.json'
        self.lock = threading.RLock()

    def get(self):
        with self.lock:
            try:
                return self.validate(json.loads(self.path.read_text('utf-8')))
            except (OSError, ValueError, TypeError):
                return dict(DEFAULTS)

    @staticmethod
    def validate(value):
        if not isinstance(value, dict) or set(value) - set(DEFAULTS):
            raise ValueError('项目参数字段无效')
        clean = {**DEFAULTS, **value}
        for key, limit in [('projectName', 80), ('projectSubtitle', 120)]:
            if not isinstance(clean[key], str) or not 1 <= len(clean[key].strip()) <= limit:
                raise ValueError('项目名称或副标题长度无效')
            clean[key] = clean[key].strip()
        if clean['defaultUnit'] not in ['ALL', 'WT', 'RD', 'CL', 'SS']:
            raise ValueError('默认工程无效')
        overview = clean['overview']
        if not isinstance(overview, dict) or set(overview) - {'demo', 'summary', 'capacityMW', 'turbines', 'circuits', 'stations', 'actual', 'planned', 'units'}:
            raise ValueError('总览参数无效')
        if 'demo' in overview and not isinstance(overview['demo'], bool):
            raise ValueError('演示状态无效')
        if 'summary' in overview and (not isinstance(overview['summary'], str) or len(overview['summary']) > 300):
            raise ValueError('项目简介过长')
        for field in ['capacityMW', 'turbines', 'circuits', 'stations', 'actual', 'planned']:
            v = overview.get(field)
            limit = 100 if field in ['actual', 'planned'] else 1000000
            if v is not None and (type(v) not in [int, float] or not 0 <= v <= limit):
                raise ValueError('总览数字无效')
        units = overview.get('units', {})
        if not isinstance(units, dict) or set(units) - {'WT','RD','CL','SS'}:
            raise ValueError('分项进度无效')
        for v in units.values():
            if v is not None and (type(v) not in [int,float] or not 0 <= v <= 100):
                raise ValueError('分项进度超出范围')
        datetime.date.fromisoformat(clean['dataDate'])
        return clean

    def update(self, value):
        with self.lock:
            clean = self.validate({**self.get(), **value}) if isinstance(value, dict) else self.validate(value)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix('.tmp')
            temp.write_text(json.dumps(clean, ensure_ascii=False, indent=2), 'utf-8')
            temp.replace(self.path)
            return clean
