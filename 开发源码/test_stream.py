"""Real SSE decoder and agent stream flow; all upstreams are local fixtures."""
import io
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError, URLError

from deepseek_service import DeepSeekService, DeepSeekError
from agent_service import AgentService


def event(delta=None, finish=None, *, usage=None):
    value={"choices":[{"index":0,"delta":delta or {},"finish_reason":finish}]}
    if usage is not None:value["usage"]=usage
    return ("data: "+json.dumps(value,ensure_ascii=False)+"\r\n\r\n").encode("utf-8")


def completed(reply="施工要点", reasoning="核查资料"):
    return b"".join([event({"reasoning_content":reasoning}),event({"content":reply}),
                     event(finish="stop",usage={"total_tokens":21}),b"data: [DONE]\n\n"])


class MemoryVault:
    def read(self):return "sk-local-test-only"
    def write(self,value):pass


class ChunkResponse:
    def __init__(self,chunks):self.chunks=list(chunks);self.reads=0;self.closed=False
    def read1(self,size=-1):
        if self.closed:raise OSError("closed")
        self.reads+=1
        return self.chunks.pop(0) if self.chunks else b""
    read=read1
    def close(self):self.closed=True


class Opener:
    def __init__(self,response):self.response=response;self.requests=[]
    def open(self,request,timeout=None):
        self.requests.append((request,timeout))
        if isinstance(self.response,Exception):raise self.response
        return self.response


class FakeKnowledge:
    def __init__(self):self.selections=[]
    def search(self,selection):
        self.selections.append(selection)
        return {"hits":[{"id":"7","itemId":"7","parserItemId":"p0001-i000001",
            "citationVersion":3,"docId":"a"*32,"documentId":"a"*32,"label":"施工方案",
            "page":1,"locator":"第 1 页","text":"基础施工前复核钢筋。","unit":"WT","objectId":"F08","process":"WT-07"}]}


class StreamModel:
    def __init__(self):self.requests=[];self.failure=None
    def chat_stream(self,body,emit,cancelled):
        self.requests.append(body)
        emit({"type":"reasoning","delta":"真实模型思考"})
        emit({"type":"delta","delta":"检查 "})
        if self.failure:raise self.failure
        emit({"type":"delta","delta":"钢筋 [1]"})
        return {"reply":"检查 钢筋 [1]","reasoning":"真实模型思考","model":"fixture",
                "usage":{"total_tokens":10},"finishReason":"stop"}


class ModelStreamingTests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def service(self,response):
        opener=Opener(response)
        return DeepSeekService(self.root,vault=MemoryVault(),opener=opener),opener
    def body(self):return {"messages":[{"role":"user","content":"基础工序的质量要点？"}],"context":{}}

    def test_real_incremental_utf8_and_reasoning_before_answer_before_completion(self):
        raw=completed()
        response=ChunkResponse([raw[i:i+1] for i in range(len(raw))])
        model,opener=self.service(response);events=[];read_positions=[]
        result=model.chat_stream(self.body(),lambda e:(events.append(e),read_positions.append(response.reads)))
        self.assertEqual(result["reply"],"施工要点")
        self.assertEqual(result["reasoning"],"核查资料")
        self.assertEqual([e["type"] for e in events],["reasoning","delta"])
        self.assertLess(read_positions[0],len(raw))
        self.assertLess(read_positions[-1],len(raw))
        payload=json.loads(opener.requests[0][0].data)
        self.assertTrue(payload["stream"])
        self.assertTrue(payload["stream_options"]["include_usage"])
        self.assertEqual(result["usage"],{"total_tokens":21})
        self.assertTrue(response.closed)

    def test_bom_comments_multiline_sse_cr_split_and_usage_only_events(self):
        raw=b'\xef\xbb\xbf: keepalive\r\n\r\n'+event({"content":"结果"})
        raw+=b'data: {"choices": [],\r\ndata: "usage": {"total_tokens": 3}}\r\n\r\n'
        raw+=event(finish="length")+b'data: [DONE]'
        response=ChunkResponse([raw[i:i+3] for i in range(0,len(raw),3)])
        model,_=self.service(response);events=[]
        result=model.chat_stream(self.body(),events.append)
        self.assertEqual(result["reply"],"结果")
        self.assertEqual(result["reasoning"],"")
        self.assertEqual(result["finishReason"],"length")
        self.assertEqual(result["usage"],{"total_tokens":3})
        self.assertEqual(events,[{"type":"delta","delta":"结果"}])

    def test_truncated_stream_never_success_and_semaphore_is_released(self):
        for raw in [event({"content":"未完成"}),event({"content":"未完成"},finish="stop"),event({"content":"未完成"})+b'data: [DONE]\n\n']:
            model,_=self.service(ChunkResponse([raw]));events=[]
            with self.assertRaises(DeepSeekError) as failure:model.chat_stream(self.body(),events.append)
            self.assertEqual(failure.exception.status,502)
            self.assertEqual(events[0]["delta"],"未完成")
            self.assertTrue(model.requests.acquire(False));self.assertTrue(model.requests.acquire(False))
            model.requests.release();model.requests.release()

    def test_malformed_upstream_errors_are_sanitized(self):
        for raw in [b'data: not-json\n\n',b'data: {"error":{"message":"sk-local-test-only"}}\n\n',b'data: {"choices":"bad"}\n\n']:
            model,_=self.service(ChunkResponse([raw]))
            with self.assertRaises(DeepSeekError) as failure:model.chat_stream(self.body(),lambda e:None)
            self.assertEqual(failure.exception.status,502)
            self.assertNotIn('sk-local-test-only',str(failure.exception))

    def test_provider_error_and_timeout_keep_actionable_status(self):
        failures=[(HTTPError('https://api.deepseek.com',401,'',{},io.BytesIO(b'secret')),401),
                  (HTTPError('https://api.deepseek.com',429,'',{},io.BytesIO()),429),
                  (URLError(socket.timeout()),504)]
        for upstream,status in failures:
            model,_=self.service(upstream)
            with self.assertRaises(DeepSeekError) as failure:model.chat_stream(self.body(),lambda e:None)
            self.assertEqual(failure.exception.status,status)

    def test_cancel_after_real_delta_closes_provider_and_no_fake_completion(self):
        response=ChunkResponse([event({"content":"部分"}),event({"content":"后续"}),event(finish='stop'),b'data: [DONE]\n\n'])
        model,_=self.service(response);cancelled=threading.Event();events=[]
        def receive(event):events.append(event);cancelled.set()
        with self.assertRaises(DeepSeekError) as failure:model.chat_stream(self.body(),receive,cancelled.is_set)
        self.assertEqual(failure.exception.status,499)
        self.assertEqual(events,[{"type":"delta","delta":"部分"}])
        self.assertTrue(response.closed)

    def test_cancel_watcher_interrupts_a_blocking_response(self):
        class Blocking(ChunkResponse):
            def __init__(self):super().__init__([]);self.stop=threading.Event()
            def read1(self,size=-1):self.stop.wait(2);return b''
            read=read1
            def close(self):super().close();self.stop.set()
        response=Blocking();model,_=self.service(response);cancelled=threading.Event()
        timer=threading.Timer(.05,cancelled.set);timer.start();start=time.monotonic()
        try:
            with self.assertRaises(DeepSeekError) as failure:model.chat_stream(self.body(),lambda e:None,cancelled.is_set)
        finally:timer.cancel()
        self.assertEqual(failure.exception.status,499)
        self.assertLess(time.monotonic()-start,1)


class AgentStreamingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.knowledge=FakeKnowledge();self.model=StreamModel();self.agent=AgentService(self.root,self.knowledge,self.model)
    def tearDown(self):self.temp.cleanup()
    def body(self,**extra):
        return {"messages":[{"role":"user","content":"钢筋如何检查？"}],
                "context":{"unit":"WT","scope":"WT","object":{"id":"F08"},"process":{"code":"WT-07"}},
                "knowledge":{"mode":"auto","unit":"WT"},**extra}

    def test_agent_emits_canonical_citations_status_deltas_then_saved_done(self):
        events=[];result=self.agent.stream(self.body(),events.append)
        self.assertEqual([e['type'] for e in events],['status','citations','status','reasoning','status','delta','delta','done'])
        self.assertEqual(events[-1]['conversationId'],result['conversationId'])
        cite=result['citations'][0]
        self.assertEqual(cite['itemId'],'7');self.assertEqual(cite['citationVersion'],3)
        self.assertEqual(cite['parserItemId'],'p0001-i000001')
        saved=self.agent.get(result['conversationId'])['conversation']['messages'][-1]
        self.assertEqual(saved['reasoning'],'真实模型思考')
        self.assertEqual(saved['text'],'检查 钢筋 [1]')
        self.assertEqual(saved['citations'][0]['itemId'],'7')
        self.assertEqual(self.knowledge.selections[-1]['objectId'],'F08')

    def test_resume_uses_assistant_answer_but_never_reasoning_as_history(self):
        first=self.agent.stream(self.body(),lambda e:None)
        self.agent.stream(self.body(conversationId=first['conversationId']),lambda e:None)
        messages=self.model.requests[-1]['messages']
        self.assertEqual(len(messages),3)
        self.assertNotIn('真实模型思考',json.dumps(messages,ensure_ascii=False))
        saved=self.agent.get(first['conversationId'])['conversation']['messages']
        self.assertEqual(saved[1]['reasoning'],'真实模型思考')

    def test_failed_or_cancelled_partial_turn_is_not_saved_as_done(self):
        self.model.failure=DeepSeekError('上游中断',502);events=[]
        with self.assertRaises(DeepSeekError):self.agent.stream(self.body(),events.append)
        self.assertNotIn('done',[e['type'] for e in events])
        self.assertEqual(self.agent.list()['conversations'],[])
        self.assertFalse(self.agent.active)
        self.model.failure=None;stop=threading.Event()
        def receive(event):
            if event['type']=='delta':stop.set()
        with self.assertRaises(DeepSeekError):self.agent.stream(self.body(),receive,stop.is_set)
        self.assertEqual(self.agent.list()['conversations'],[])
        self.assertFalse(self.agent.active)

    def test_local_retrieval_has_no_fabricated_model_token_or_reasoning_events(self):
        body=self.body();body['knowledge']['mode']='knowledge';events=[]
        result=self.agent.stream(body,events.append)
        self.assertEqual([e['type'] for e in events],['status','citations','done'])
        self.assertEqual(result['model'],'本地资料检索')
        self.assertFalse(self.model.requests)
        self.assertNotIn('reasoning',result)

    def test_single_long_reasoning_conversation_remains_readable_and_keeps_latest_pair(self):
        row={"id":"b"*32,"title":"长会话","createdAt":"now","updatedAt":"now","scope":{},"messages":[]}
        for i in range(12):
            row["messages"].extend([{"role":"user","text":"问题"+str(i)},
                {"role":"assistant","text":"回答"+str(i),"reasoning":"思"*400000}])
        self.agent._save([row])
        self.assertLessEqual(self.agent.path.stat().st_size,12*1024*1024)
        saved=self.agent.get(row["id"])["conversation"]
        self.assertEqual(saved["messages"][-1]["text"],"回答11")
        self.assertEqual(saved["messages"][-2]["text"],"问题11")
        self.assertEqual(len(saved["messages"])%2,0)


if __name__=='__main__':unittest.main()
