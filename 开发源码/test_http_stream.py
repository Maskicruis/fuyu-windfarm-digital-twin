import http.client,json,tempfile,threading,unittest
from pathlib import Path
import server
from deepseek_service import DeepSeekError

class Quiet(server.Handler):
 def log_message(self,*args):pass

class HttpStreamTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.s=server.FuyuServer(('127.0.0.1',0),Path(self.tmp.name),persistent_credentials=False)
  self.s.RequestHandlerClass=Quiet;self.t=threading.Thread(target=self.s.serve_forever,daemon=True);self.t.start()
 def tearDown(self):self.s.shutdown();self.s.server_close();self.t.join(3);self.tmp.cleanup()
 def connect(self,origin=None):
  c=http.client.HTTPConnection('127.0.0.1',self.s.server_port,timeout=4)
  c.request('POST','/api/chat/stream',body=b'{}',headers={'Content-Type':'application/json',**({'Origin':origin} if origin else {})})
  return c,c.getresponse()
 def event(self,r):
  line=r.readline();self.assertTrue(line.startswith(b'data: '),line)
  self.assertEqual(r.readline(),b'\n');return json.loads(line[6:])
 def test_each_event_is_flushed_before_provider_completion(self):
  release=threading.Event();finished=threading.Event()
  def stream(body,emit,cancelled):
   emit({'type':'reasoning','delta':'检索当前工序'});release.wait(3)
   emit({'type':'delta','delta':'正文片段'});emit({'type':'done','reply':'正文片段'});finished.set()
  self.s.agent.stream=stream;c,r=self.connect()
  try:
   self.assertEqual(r.status,200);self.assertIn('text/event-stream',r.getheader('Content-Type'))
   self.assertEqual(self.event(r)['delta'],'检索当前工序');self.assertFalse(finished.is_set())
   release.set();self.assertEqual(self.event(r)['type'],'delta');self.assertEqual(self.event(r)['type'],'done')
  finally:release.set();c.close()
 def test_provider_error_is_one_sse_error_not_json_or_fake_done(self):
  def stream(*args):raise DeepSeekError('测试鉴权错误',401)
  self.s.agent.stream=stream;c,r=self.connect()
  try:self.assertEqual(self.event(r),{'type':'error','error':'测试鉴权错误','status':401});self.assertEqual(r.read(),b'')
  finally:c.close()
 def test_cross_origin_request_does_not_start_stream(self):
  self.s.agent.stream=lambda *args:self.fail('must not run')
  c,r=self.connect('https://example.org')
  try:self.assertEqual(r.status,403)
  finally:r.read();c.close()

if __name__=='__main__':unittest.main()
