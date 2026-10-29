"""Run the portable EXE alone, with isolated data and a local mock model provider."""
from pathlib import Path
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import shutil
import subprocess
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--exe', type=Path, default=ROOT/'specflow-component/release/SpecFlow-Knowledge-Component-1.0.0-x64.exe')
    args = parser.parse_args()
    area = ROOT/'开发源码/验收产物/specflow-package-proof'
    area.mkdir(parents=True, exist_ok=True)
    executable = area/args.exe.name
    shutil.copy2(args.exe, executable)
    data = area/'isolated-data'
    record = data/'component-service.json'
    calls = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            if not calls[-1].get('stream'):
                raw=json.dumps({'choices':[{'message':{'content':'第二轮本机验收回答。'}}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for delta in [{'reasoning_content':'本机验收思考片段'}, {'content':'本机流式验收回答。'}]:
                self.wfile.write(('data: '+json.dumps({'choices':[{'delta':delta}]},ensure_ascii=False)+'\n\n').encode())
                self.wfile.flush()
                time.sleep(.15)
            self.wfile.write(b'data: [DONE]\n\n')

    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    process = None

    def start(extra):
        return subprocess.Popen([str(executable),'--headless','--data-dir',str(data),*extra], creationflags=0x08000000)

    def wait_service():
        for _ in range(90):
            try:
                r = json.loads(record.read_text('utf-8'))
                if Path(r['data']).resolve() == data.resolve():
                    with urllib.request.urlopen('http://127.0.0.1:'+str(r['port'])+'/api/v1/health', timeout=1) as response:
                        assert response.status == 200
                    return r
            except (OSError, ValueError, KeyError):
                pass
            time.sleep(1)
        raise RuntimeError('Portable EXE service did not start')

    def stop():
        # These PIDs belong only to the EXE and data directory this test created.
        try:
            r = json.loads(record.read_text('utf-8'))
            if Path(r['data']).resolve() == data.resolve():
                subprocess.run(['taskkill','/PID',str(r['pid']),'/T','/F'], capture_output=True)
        except (OSError, ValueError):
            pass
        if process and process.poll() is None:
            subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'], capture_output=True)

    def request(base, route, body=None, method='GET'):
        req = urllib.request.Request(base+route, data=None if body is None else json.dumps(body).encode(), method=method,
                                     headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)['data']

    try:
        process = start(['--port','38910'])
        service = wait_service()
        base = 'http://127.0.0.1:'+str(service['port'])
        with urllib.request.urlopen(base, timeout=10) as r:
            assert r.read() == (ROOT/'specflow-component/ui.html').read_bytes()
        settings = request(base, '/api/v1/settings')
        assert str(area.resolve()) in settings['library']
        request(base, '/api/v1/settings', {'port':38910,'llm':{'baseUrl':'http://127.0.0.1:'+str(provider.server_port),'model':'local-package-fixture','apiKey':'fixture-only-no-real-credential'}},'PATCH')
        events = []
        payload = {'question':'package first turn','retrievalMode':'general'}
        req = urllib.request.Request(base+'/api/v1/ask/stream', data=json.dumps(payload).encode(), headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=30) as response:
            assert 'text/event-stream' in response.headers['Content-Type']
            for line in response:
                if line.startswith(b'data: '):
                    event=json.loads(line[6:])
                    if event.get('type'):events.append(event)
        kinds={x['type'] for x in events}
        assert {'reasoning','delta','done'} <= kinds, kinds
        conversations=request(base, '/api/v1/conversations')['items']
        assert conversations
        conversation=conversations[0]
        request(base, '/api/v1/ask', {'question':'package second turn','conversationId':conversation['id'],'retrievalMode':'general'}, 'POST')
        assert any('package first turn' in str(m.get('content','')) for m in calls[-1]['messages'])
        saved=request(base,'/api/v1/conversations/'+conversation['id'])
        assert len(saved['turns']) >= 2
        stop()
        process=start([])
        service=wait_service()
        assert service['port']==38910
        base='http://127.0.0.1:'+str(service['port'])
        restored=request(base,'/api/v1/settings')
        assert restored['llm']['model']=='local-package-fixture'
        assert restored['llm']['apiKey']=='fixture-only-no-real-credential'
        assert len(request(base,'/api/v1/conversations/'+conversation['id'])['turns'])>=2
        proof={'passed':True,'sha256':hashlib.sha256(executable.read_bytes()).hexdigest(),
               'exe_alone':True,'original_ui_bytes':True,'sse_event_types':sorted(kinds),
               'context_history':True,'settings_and_history_survive_restart':True,
               'configured_port_survives_restart':True,'provider':'local mock, no real model API call',
               'data_isolation':True}
        (ROOT/'开发源码/验收产物/SpecFlow-binary-verification.json').write_text(json.dumps(proof,indent=2),'utf-8')
        print(json.dumps(proof),flush=True)
    finally:
        stop()
        provider.shutdown()
        provider.server_close()


if __name__=='__main__':
    main()
