"""Start or reuse this workspace's V10.1 service, without reusing an older server."""
from pathlib import Path
import argparse,json,socket,subprocess,sys,time,urllib.request,webbrowser

ROOT=Path(__file__).resolve().parent.parent

def compatible(port,root=ROOT):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/state',timeout=.8) as response:
            state=json.load(response)
        service=state.get('service',{})
        return (service.get('name')=='fuyu-ui-studio' and service.get('revision')=='10.1'
                and str(Path(service.get('workspace','')).resolve()).casefold()==str(root.resolve()).casefold())
    except (OSError,ValueError,TypeError):
        return False

def available(port):
    with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as probe:
        try:
            probe.bind(('127.0.0.1',port))
            return True
        except OSError:
            return False

def start(root=ROOT):
    data=root/'data';data.mkdir(exist_ok=True)
    record=data/'service.json'
    ports=[]
    try:
        remembered=json.loads(record.read_text(encoding='utf-8')).get('port')
        if isinstance(remembered,int) and 1024<=remembered<=65535:ports.append(remembered)
    except (OSError,ValueError,TypeError):pass
    ports=list(dict.fromkeys(ports+[8779]+list(range(8782,8792))))
    for port in ports:
        if compatible(port,root):return port
        if not available(port):continue
        with (data/'server.log').open('ab') as log:
            process=subprocess.Popen([sys.executable,str(root/'开发源码/server.py'),'--port',str(port)],
                cwd=root,stdout=log,stderr=log,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        for _ in range(60):
            if compatible(port,root):
                (data/'server.pid').write_text(str(process.pid),encoding='ascii')
                record.write_text(json.dumps({'port':port,'pid':process.pid,'revision':'10.1'},ensure_ascii=False),encoding='utf-8')
                return port
            if process.poll() is not None:break
            time.sleep(.15)
    raise RuntimeError('未能启动本机服务，请检查 data/server.log；也可先打开 admin.html 离线编辑。')

def main(argv=None):
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    parser=argparse.ArgumentParser(description='扶余一号本机前后台启动器')
    parser.add_argument('--view',action='store_true')
    parser.add_argument('--no-open',action='store_true',help='仅启动服务并打印地址')
    args=parser.parse_args(argv)
    try:
        port=start()
        url=f'http://127.0.0.1:{port}/'+('frontend.html' if args.view else '/admin.html').lstrip('/')
        print(url,flush=True)
        if not args.no_open:webbrowser.open(url)
        return 0
    except RuntimeError as error:
        print(str(error),file=sys.stderr)
        if not args.no_open:input('按 Enter 关闭')
        return 1

if __name__=='__main__':raise SystemExit(main())
