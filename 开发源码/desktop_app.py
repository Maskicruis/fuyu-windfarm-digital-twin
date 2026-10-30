"""Frozen Windows desktop entry; mutable state never lives in the one-file bundle."""
from __future__ import annotations
import argparse
import json
import logging
import multiprocessing
import os
from pathlib import Path
import sys
import threading
import time
import urllib.request
import webbrowser

from app_version import VERSION as REVISION


def asset_root():
    return Path(sys._MEIPASS) / 'assets' if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent.parent


def workspace_root(override=None, plugin_only=False):
    if override:
        return Path(override).resolve()
    if not getattr(sys, 'frozen', False):
        root = asset_root()
        return root / 'plugin-workspace' if plugin_only else root
    parent = Path(sys.executable).resolve().parent
    return parent / ('plugin-workspace' if plugin_only else 'workspace')


def compatible(port, workspace, plugin_only=False):
    try:
        request = urllib.request.Request(f'http://127.0.0.1:{port}/api/health')
        with urllib.request.urlopen(request, timeout=.7) as response:
            value = json.loads(response.read(16384))['service']
        return (value['name'] == 'fuyu-ui-studio' and value['revision'] == REVISION
                and Path(value['workspace']).resolve() == Path(workspace).resolve()
                and value['mode'] == ('plugin' if plugin_only else 'application'))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def create_service(workspace, *, port=0, plugin_only=False, allowed_origins=None):
    from server import FuyuServer
    folder = workspace / 'data'
    folder.mkdir(parents=True, exist_ok=True)
    record = folder / ('plugin-service.json' if plugin_only else 'service.json')
    candidates = [port] if port else []
    if not port:
        try:
            previous = json.loads(record.read_text('utf-8')).get('port')
            if type(previous) is int and 1024 <= previous <= 65535:
                candidates.append(previous)
        except (OSError, ValueError):
            pass
        candidates.extend([8780 if plugin_only else 8779, 0])
    for number in dict.fromkeys(candidates):
        if number and compatible(number, workspace, plugin_only):
            return None, number
        try:
            service = FuyuServer(('127.0.0.1', number), asset_root(), data_root=workspace,
                                 plugin_only=plugin_only, allowed_origins=allowed_origins)
        except OSError as error:
            logging.exception('本机服务启动失败，候选端口 %s', number)
            if number == 0 or port:
                raise
            continue
        thread = threading.Thread(target=service.serve_forever, kwargs={'poll_interval': .25}, daemon=True)
        thread.start()
        record.write_text(json.dumps({'pid': os.getpid(), 'port': service.server_port,
                         'revision': REVISION, 'mode': 'plugin' if plugin_only else 'application',
                         'workspace': str(workspace)}, ensure_ascii=False), 'utf-8')
        return service, service.server_port
    raise RuntimeError('无法启动本机服务，指定端口可能被其他程序占用。')


def setup_log(workspace):
    folder = workspace / 'data'
    folder.mkdir(parents=True, exist_ok=True)
    # Windowed executables have no console; HTTP logs contain paths only.
    stream = open(folder / 'desktop.log', 'a', encoding='utf-8', buffering=1)
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream
    logging.basicConfig(stream=stream, level=logging.WARNING)


def main(argv=None):
    parser = argparse.ArgumentParser(description='扶余一号数字孪生桌面应用')
    parser.add_argument('--view', action='store_true')
    parser.add_argument('--admin', action='store_true')
    parser.add_argument('--plugin-only', action='store_true')
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--data-dir', help='持久工作目录，目录内包含 data；不能放进 EXE 临时解压目录')
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--allow-origin', action='append', default=None)
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error('端口须为 0–65535')
    workspace = workspace_root(args.data_dir, args.plugin_only)
    setup_log(workspace)
    service = None
    try:
        service, port = create_service(workspace, port=args.port, plugin_only=args.plugin_only,
                                       allowed_origins=args.allow_origin)
        page = ('plugin/widget.html' if args.plugin_only else 'admin.html' if args.admin
                else 'frontend.html' if args.view else 'desktop-home.html')
        url = f'http://127.0.0.1:{port}/{page}'
        if args.headless:
            while True:
                time.sleep(.5)
        try:
            if os.name=='nt':
                import ctypes
                ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('CRRC.Fuyu.DigitalTwin')
            import webview
            window = webview.create_window('扶余一号 · 数字孪生' if not args.plugin_only else '知识与智能体组件',
                                  url, width=1600 if not args.plugin_only else 1000, height=940,
                                  min_size=(1100, 700) if not args.plugin_only else (600, 650),
                                  text_select=True)
            if service and service.updater and getattr(sys,'frozen',False):
                service.updater.target=Path(sys.executable).resolve()
                service.updater.port=port
                service.updater.exit_callback=window.destroy
            webview.start(gui='edgechromium', private_mode=False,icon=str(asset_root()/'lib/brand/fuyu-crrc-wind.ico'),
                          storage_path=str(workspace / 'webview-profile'))
        except Exception:
            logging.exception('内嵌窗口不可用，已切换浏览器入口')
            webbrowser.open(url)
            import tkinter as tk
            window = tk.Tk()
            window.title('扶余一号 · 数字孪生服务')
            window.geometry('460x250')
            window.iconbitmap(str(asset_root()/'lib/brand/fuyu-crrc-wind.ico'))
            tk.Label(window, text='扶余一号数字孪生正在运行', font=('Microsoft YaHei', 16)).pack(pady=24)
            tk.Button(window, text='打开系统', command=lambda: webbrowser.open(url), width=26).pack(pady=5)
            tk.Label(window, text='关闭此窗口将停止本机服务。', font=('Microsoft YaHei', 10)).pack(pady=20)
            window.mainloop()
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        logging.exception('桌面应用启动失败')
        if not args.headless:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, '启动失败：' + str(error) + '\n请查看工作目录 data/desktop.log。',
                                             '扶余一号', 0x10)
        return 1
    finally:
        if service:
            service.shutdown()
            service.server_close()


if __name__ == '__main__':
    multiprocessing.freeze_support()
    raise SystemExit(main())
