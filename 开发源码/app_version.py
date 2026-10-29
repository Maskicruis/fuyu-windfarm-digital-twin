from pathlib import Path
import json
import re
import sys

ROOT=Path(sys._MEIPASS)/'assets' if getattr(sys,'frozen',False) else Path(__file__).resolve().parent.parent
VERSION=json.loads((ROOT/'config/app-version.json').read_text('utf-8'))['version']
if not re.fullmatch(r'\d+\.\d+\.\d+',VERSION):
    raise ValueError('Application version must use major.minor.patch')
