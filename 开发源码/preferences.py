"""Non-secret project display preferences, separate from model credentials and UI drafts."""
import datetime
import json
import threading
from pathlib import Path

DEFAULTS = dict(projectName='中车扶余一号 · 建设施工', projectSubtitle='WIND FARM · CONSTRUCTION DIGITAL TWIN',
                dataDate='2026-10-29', defaultUnit='WT')


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
