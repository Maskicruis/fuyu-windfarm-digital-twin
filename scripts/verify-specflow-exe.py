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
import urllib.parse

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--exe', type=Path, default=ROOT/'specflow-component/release/SpecFlow-Knowledge-Component-1.1.0-x64.exe')
    parser.add_argument('--pdf', type=Path, help='Optional local text PDF for real upload/index/range checks; never published')
    args = parser.parse_args()
    area = ROOT/'开发源码/验收产物/specflow-package-proof-v110'
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
        if args.pdf:
            upload=urllib.request.Request(base+'/api/v1/jobs',data=args.pdf.read_bytes(),headers={'Content-Type':'application/pdf','X-File-Name':'native-validation.pdf'})
            with urllib.request.urlopen(upload,timeout=30) as response:
                job=json.load(response)['data']
            doc_id=job.get('id') or job.get('job',{}).get('id')
            assert doc_id,job
            for _ in range(90):
                job=request(base,'/api/v1/jobs/'+doc_id)['job']
                if job['status'] in ['ready','error']:break
                time.sleep(1)
            assert job['status']=='ready',job
            assert job['parser']=='pdf-text',job
            hits=request(base,'/api/v1/search?q='+urllib.parse.quote('混凝土养护')+'&doc='+doc_id)['hits']
            assert hits and hits[0]['bboxNormalized'],hits
            hit=hits[0]
            page_url=base+'/api/view?id='+doc_id+'&page='+str(hit['page'])
            with urllib.request.urlopen(page_url,timeout=5) as response:
                assert json.load(response)['items']
            req=urllib.request.Request(base+'/api/v1/documents/'+doc_id+'/source',headers={'Range':'bytes=0-1023'})
            with urllib.request.urlopen(req,timeout=5) as response:
                assert response.status==206
                assert response.headers['Accept-Ranges']=='bytes'
                assert len(response.read())==1024
            other=start(['--port','38911'])
            try:
                other.wait(timeout=120)
                assert json.loads(record.read_text('utf-8'))['pid']==service['pid']
            finally:
                if other.poll() is None:subprocess.run(['taskkill','/PID',str(other.pid),'/T','/F'],capture_output=True)
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
               'native_upload_search_page_range_singleton':bool(args.pdf),
               'data_isolation':True}
        (ROOT/'开发源码/验收产物/SpecFlow-binary-verification.json').write_text(json.dumps(proof,indent=2),'utf-8')
        print(json.dumps(proof),flush=True)
    finally:
        stop()
        provider.shutdown()
        provider.server_close()


if __name__=='__main__':
    main()
