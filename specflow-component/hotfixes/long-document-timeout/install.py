"""Install the 1.3.2 engine-only hotfix, preserving documents and settings."""
from pathlib import Path
import argparse, datetime, hashlib, json, os, shutil, tempfile

def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def atomic_copy(source, destination):
    handle, name = tempfile.mkstemp(prefix=destination.name + '.', dir=destination.parent)
    try:
        with os.fdopen(handle, 'wb') as stream:
            stream.write(source.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, destination)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def install(root, replacement=None):
    root = Path(root).resolve()
    engine = root / 'engines'
    entry = engine / 'run_mineru.py'
    marker = engine / 'component-patches.json'
    replacement = Path(replacement or Path(__file__).with_name('run_mineru.py'))
    if not (engine / 'python/python.exe').is_file() or not entry.is_file():
        raise RuntimeError('未找到已安装的解析引擎。请先运行 EXE 完成资源安装，再把修复文件夹放在 EXE 旁。')
    text = entry.read_text('utf8')
    if 'from mineru.cli.client import main' not in text or "MINERU_PROCESSING_WINDOW_SIZE" not in text:
        raise RuntimeError('不是受支持的 SpecFlow 内置解析入口，未修改任何文件。')
    data = json.loads(marker.read_text('utf8'))
    expected = data.get('files', {}).get('run_mineru.py')
    if expected != sha(entry):
        raise RuntimeError('解析入口与本机校验记录不一致，请先检查自定义修改。未覆盖该文件。')
    if sha(entry) == sha(replacement):
        return {'installed': True, 'already_current': True, 'version': '1.3.2-hotfix.1'}
    timestamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup = root / '数据备份' / ('长文档超时修复-' + timestamp)
    backup.mkdir(parents=True, exist_ok=False)
    shutil.copy2(entry, backup / entry.name)
    shutil.copy2(marker, backup / marker.name)
    atomic_copy(replacement, entry)
    data['files']['run_mineru.py'] = sha(entry)
    data['hotfix'] = {'version': '1.3.2-hotfix.1', 'task_result_timeout_seconds': 28800,
                      'stall_watchdog_unchanged': True}
    # Keep the source identity of the installed EXE. Its preparation step checks
    # this marker and the new file digest, so this explicit engine hotfix survives
    # restart. A newer EXE with a changed source identity can supersede it normally.
    payload = backup / 'patched-marker.json'
    payload.write_text(json.dumps(data, ensure_ascii=False, indent=2), 'utf8')
    atomic_copy(payload, marker)
    return {'installed': True, 'version': data['hotfix']['version'],
            'task_result_timeout_seconds': 28800, 'settings_and_database_untouched': True}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    print(json.dumps(install(args.root), ensure_ascii=False))
