"""Agent orchestration tests: real local retrieval; model calls are mocked."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from agent_service import AgentService
from deepseek_service import DeepSeekError, DeepSeekService
from knowledge_service import KnowledgeStore


class MemoryVault:
    def __init__(self,value=''):self.value=value
    def read(self):return self.value
    def write(self,value):self.value=value


class FakeModel:
    def __init__(self):self.calls=[]
    def chat(self,body):
        self.calls.append(copy.deepcopy(body))
        return {'reply':'按资料记录养护温度。[1]','model':'mock-model','usage':{},'finishReason':'stop'}


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='fuyu-agent-test-')
        self.root=Path(self.temp.name)
        self.knowledge=KnowledgeStore(self.root)
        self.knowledge.update_settings({'engine':'native','mineruExecutable':''})
        self.model=FakeModel()
        self.agent=AgentService(self.root,self.knowledge,self.model)
        self.context={'scope':'WT','unit':'WT','module':'施工管理辅助',
                      'object':{'id':'F08','location':'测试回路位置'},'process':{'code':'WT-07'}}

    def tearDown(self):
        self.knowledge.close();self.temp.cleanup()

    def upload(self,value='混凝土养护须逐日记录温度和养护措施。',**meta):
        document=self.knowledge.upload(value.encode(),'养护参考.txt','text/plain',{'unit':'WT',**meta})['document']
        for _ in range(200):
            current=self.knowledge.document(document['id'])
            if current['status'] not in ('queued','parsing'):break
            time.sleep(.01)
        self.assertEqual(current['status'],'ready')
        return document['id']

    def ask(self,question='混凝土养护如何记录？',**values):
        return self.agent.chat({'messages':[{'role':'user','content':question}],
                                'context':self.context,'knowledge':{'mode':'knowledge','unit':'WT'},**values})

    def test_knowledge_only_needs_no_provider_and_persists_citations_for_followup(self):
        ident=self.upload()
        result=self.ask()
        self.assertEqual(self.model.calls,[])
        self.assertEqual(result['model'],'本地资料检索');self.assertTrue(result['citations'])
        self.assertEqual(result['citations'][0]['documentId'],ident)
        self.assertIn('[1]',result['reply'])
        session=result['conversationId']
        resumed=AgentService(self.root,self.knowledge,self.model)
        stored=resumed.get(session)['conversation']
        self.assertEqual(len(stored['messages']),2)
        self.assertEqual(stored['messages'][1]['citations'],result['citations'])
        self.assertEqual(stored['scope']['objectId'],'F08')
        followup=resumed.chat({'messages':[{'role':'user','content':'具体还需要注意什么？'}],
                              'context':self.context,'knowledge':{'mode':'knowledge','unit':'WT'},'conversationId':session})
        self.assertTrue(followup['citations']);self.assertEqual(followup['conversationId'],session)
        self.assertEqual(len(resumed.get(session)['conversation']['messages']),4)

    def test_explicit_empty_group_does_not_expand_or_invoke_model(self):
        self.upload()
        group=self.knowledge.create_group({'name':'空范围'})['group']['id']
        result=self.ask(knowledge={'mode':'knowledge','groupId':group,'unit':'WT'})
        self.assertFalse(result['citations']);self.assertEqual(result['retrieval']['status'],'no_matches')
        self.assertIn('未自动扩大',result['reply']);self.assertFalse(self.model.calls)

    def test_auto_sends_retrieved_evidence_and_general_skips_library(self):
        self.upload()
        result=self.ask(knowledge={'mode':'auto','unit':'WT'})
        self.assertTrue(result['citations'])
        body=self.model.calls[-1]
        self.assertIn('逐日记录温度',body['evidence']['citations'][0]['text'])
        self.assertEqual(body['context'],self.context)
        result=self.ask(knowledge={'mode':'general','unit':'WT'})
        self.assertFalse(result['citations']);self.assertEqual(self.model.calls[-1]['evidence'],{})

    def test_context_switch_does_not_discard_explicit_knowledge_when_disabled(self):
        self.upload()
        model=DeepSeekService(self.root,vault=MemoryVault('dummy-test-key'))
        model.update({'contextEnabled':False})
        sent=[]
        def call(settings,key,messages,**kwargs):
            sent.extend(copy.deepcopy(messages))
            return {'reply':'养护记录包含温度。[1]','model':settings['model'],'usage':{},'finishReason':'stop'}
        model._call=call
        agent=AgentService(self.root,self.knowledge,model)
        result=agent.chat({'messages':[{'role':'user','content':'混凝土养护'}],
                           'context':self.context,'knowledge':{'mode':'auto','unit':'WT'}})
        self.assertTrue(result['citations'])
        system=sent[0]['content']
        self.assertIn('逐日记录温度',system);self.assertNotIn('测试回路位置',system)
        self.assertIn('未启用工程上下文',system)

    def test_citation_navigation_comes_from_server_ids_not_model_urls(self):
        valid='a'*32
        class Library:
            def search(self,body):
                return {'hits':[{'id':'item-1','documentId':valid,'label':'合法原件','text':'参考段落','page':2,
                                 'sourceUrl':'https://attacker.invalid/steal','bboxNormalized':[.1,.2,.8,.4]},
                                {'id':'bad','documentId':'../../outside','text':'不合法目的地'}]}
        result=AgentService(self.root,Library(),self.model).chat({'messages':[{'role':'user','content':'查资料'}],
                                                                 'context':{},'knowledge':{'mode':'auto'}})
        self.assertEqual(len(result['citations']),1)
        self.assertEqual(result['citations'][0]['sourceUrl'],'/api/knowledge/documents/'+valid+'/source')
        self.assertNotIn('attacker',json.dumps(result['citations']))

    def test_invalid_context_and_scope_are_validation_errors_not_type_errors(self):
        bad=[{'context':[]},{'context':{'scope':{}},'knowledge':{}},{'knowledge':{'mode':[]}},
             {'knowledge':{'unit':[]}},{'knowledge':{'mode':{},'unit':'WT'}},
             {'knowledge':{'enabled':'false'}},{'knowledge':{'documentIds':['../x']}},
             {'messages':[{'role':'assistant','content':'wrong'}]},
             {'messages':[{'role':'user','content':''}]}]
        for patch in bad:
            with self.subTest(patch=patch),self.assertRaises(DeepSeekError):self.ask(**patch)

    def test_model_error_releases_session_lock_and_does_not_save_partial_answer(self):
        created=self.agent.create({'title':'测试会话'})['conversation']['id']
        class Failing:
            def chat(self,body):raise DeepSeekError('模拟模型不可用',503)
        self.agent.model=Failing()
        with self.assertRaises(DeepSeekError):self.ask(knowledge={'mode':'general'},conversationId=created)
        self.assertEqual(self.agent.active,set())
        self.assertEqual(self.agent.get(created)['conversation']['messages'],[])
        self.agent.model=self.model
        result=self.ask(knowledge={'mode':'general'},conversationId=created)
        self.assertEqual(result['conversationId'],created)

    def test_same_session_concurrency_is_rejected_until_original_finishes(self):
        session=self.agent.create({'title':'并发测试'})['conversation']['id']
        started=threading.Event();release=threading.Event();errors=[]
        class Slow:
            def chat(self,body):
                started.set();release.wait(3)
                return {'reply':'完成','model':'mock','usage':{},'finishReason':'stop'}
        self.agent.model=Slow()
        def run():
            try:self.ask(knowledge={'mode':'general'},conversationId=session)
            except Exception as exc:errors.append(exc)
        thread=threading.Thread(target=run);thread.start();self.assertTrue(started.wait(2))
        try:
            with self.assertRaises(DeepSeekError) as error:self.ask(knowledge={'mode':'general'},conversationId=session)
            self.assertEqual(error.exception.status,409)
        finally:release.set();thread.join(3)
        self.assertEqual(errors,[]);self.assertFalse(self.agent.active)


if __name__=='__main__':unittest.main()
