"""Local, persistent engineering-document knowledge library.

Originals, canonical source anchors and parse jobs remain separate from UI
configuration. Parsing runs in one background worker; no upload is sent to a
third party. MinerU is an optional, user-configured local executable.
"""
from __future__ import annotations

from collections import Counter
import datetime as dt
import hashlib
import html
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import queue
import re
import sqlite3
import subprocess
import threading
import time
import uuid
import zipfile
import xml.etree.ElementTree as ET


MAX_UPLOAD = 40 * 1024 * 1024
MAX_TEXT = 2_000_000
MAX_CHUNKS = 10000
UNITS = frozenset(('ALL', 'WT', 'RD', 'CL', 'SS'))
ID_RE = re.compile(r'^[a-f0-9]{32}$')
PROCESS_RE = re.compile(r'^(WT|RD|CL|SS)-[0-9]{2}$')
PROCESS_LIMITS = {'WT':24,'RD':17,'CL':21,'SS':30}
KNOWN_MINERU = Path(r'C:\Users\Administrator\AppData\Local\knowledge-base-tool\mineru-venv\Scripts\mineru.exe')
MIMES = {'.txt':'text/plain', '.md':'text/markdown', '.pdf':'application/pdf',
         '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp'}


class KnowledgeError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class EngineNeeded(KnowledgeError):
    pass


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def text(value, maximum, label, *, empty=True):
    if type(value) is not str or len(value) > maximum or any(ord(c)<32 and c not in '\n\r\t' for c in value):
        raise KnowledgeError(label+'格式或长度无效')
    value = value.strip()
    if not empty and not value:
        raise KnowledgeError('请填写'+label)
    return value


def one(query, key, default=''):
    value = query.get(key, default)
    if isinstance(value, list):
        if len(value) != 1:
            raise KnowledgeError('筛选参数重复：'+key)
        value = value[0]
    return value


def tokens(value):
    result = []
    for part in re.findall(r'[a-z0-9_]+|[\u3400-\u9fff]+', value.lower()):
        if re.fullmatch(r'[\u3400-\u9fff]+', part):
            result.extend(part)
            result.extend(part[i:i+2] for i in range(len(part)-1))
        else:
            result.append(part)
    return result


def bbox_ratio(value):
    if not isinstance(value, (list, tuple)) or len(value)!=4:
        return None
    if any(type(v) not in (int,float) or not math.isfinite(v) for v in value):
        return None
    divisor = 1 if max(abs(v) for v in value)<=1.5 else 1000
    box = [max(0, min(1, v/divisor)) for v in value]
    if box[2]<=box[0] or box[3]<=box[1]:
        return None
    return box


def plain_html(value):
    return html.unescape(re.sub(r'<[^>]*>', ' ', str(value))).strip()


def mineru_chunks(payload):
    """Normalize legacy / V2 MinerU blocks without manufacturing page boxes."""
    if isinstance(payload, dict):
        if isinstance(payload.get('items'), list):
            payload = payload['items']
        elif isinstance(payload.get('pages'), list):
            payload = [p.get('items', p.get('blocks', [])) if isinstance(p,dict) else p for p in payload['pages']]
        else:
            raise KnowledgeError('MinerU 结构化结果中没有内容条目')
    if not isinstance(payload,list):
        raise KnowledgeError('MinerU 结构化结果格式无效')
    result = []
    total = 0
    def add(item, page_hint=None):
        nonlocal total
        if not isinstance(item,dict): return
        kind = str(item.get('type', 'text')).lower()
        if kind in ('header','footer','page_number','page-header','page-footer','aside_text','page_footnote'): return
        page_idx = item.get('page_idx', item.get('page_index', page_hint))
        page = page_idx+1 if type(page_idx) is int and 0<=page_idx<10000 else None
        content = item.get('content')
        data = content if isinstance(content,dict) else {}
        def list_text(value):
            if isinstance(value,str):return value
            if not isinstance(value,list):return ''
            values=[]
            for entry in value:
                if isinstance(entry,str):values.append(entry)
                elif isinstance(entry,dict):
                    values.append(next((entry[k] for k in ('text','content','markdown') if isinstance(entry.get(k),str)),''))
            return '\n'.join(v for v in values if v.strip())
        candidates = [item.get('text'), content if isinstance(content,str) else None,
                      item.get('equation'), item.get('code_body'), item.get('chart_body')]
        if isinstance(content,dict):
            candidates.extend(content.get(k) for k in ('text','markdown','latex','code','table_body','html'))
        candidates.extend(item.get(k) for k in ('table_body','html'))
        main = next((v for v in candidates if isinstance(v,str) and v.strip()), '')
        if kind=='list':
            main=list_text(item.get('list_items')) or list_text(data.get('items')) or main
        if kind=='table':
            table_values=[item.get('table_body'),item.get('html'),data.get('table_body'),data.get('html'),data.get('content')]
            main=next((v for v in table_values if isinstance(v,str) and v.strip()),main)
        captions = []
        for key in ('table_caption','image_caption','chart_caption','table_footnote','image_footnote','chart_footnote'):
            value=list_text(item.get(key, []))
            if value:captions.append(value)
        for key in ('caption','footnote'):
            value=list_text(data.get(key,[]))
            if value:captions.append(value)
        value = '\n'.join([*captions, plain_html(main) if '<' in main else main]).strip()
        if not value: return
        total += len(value)
        if total>MAX_TEXT or len(result)>=MAX_CHUNKS:
            raise KnowledgeError('解析内容超过本机索引上限，请拆分文件')
        box = bbox_ratio(item.get('bbox', item.get('bboxNormalized')))
        # Keep the original block's identity even when a long block is split.
        block_id = f'p{page or 0:04d}-i{len(result):06d}'
        for start in range(0,len(value),1500):
            result.append({'text':value[start:start+1600], 'page':page,
                           'locator':('第'+str(page)+'页 · ' if page else '')+'内容块 '+block_id,
                           'bboxNormalized':box,'type':kind,'itemId':block_id})
    for page_hint, item in enumerate(payload):
        if isinstance(item,list):
            for row in item: add(row,page_hint)
        else: add(item)
    if not result:
        raise KnowledgeError('MinerU 未提取到可检索文字；请核查原件、解析环境和语言设置')
    return result


class KnowledgeStore:
    def __init__(self, root, *, runner=None, autostart=True):
        self.root = Path(root).resolve()
        self.directory = self.root/'data'/'knowledge'
        if not self.directory.resolve().is_relative_to(self.root):
            raise KnowledgeError('知识库目录必须位于当前项目内')
        self.originals = self.directory/'originals'
        self.work = self.directory/'parsed'
        self.originals.mkdir(parents=True,exist_ok=True)
        self.work.mkdir(parents=True,exist_ok=True)
        if any(not path.resolve().is_relative_to(self.root) for path in (self.originals,self.work)):
            raise KnowledgeError('知识库文件目录不得链接到项目以外的位置')
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.directory/'knowledge.sqlite3',check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,createdAt TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS documents(
            id TEXT PRIMARY KEY,filename TEXT NOT NULL,label TEXT NOT NULL,mime TEXT NOT NULL,
            bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,unit TEXT NOT NULL,groupId TEXT NOT NULL DEFAULT '',
            objectId TEXT NOT NULL DEFAULT '',process TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',
            pages INTEGER,chunkCount INTEGER NOT NULL DEFAULT 0,engine TEXT NOT NULL DEFAULT '',
            createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,parsedAt TEXT,archived INTEGER NOT NULL DEFAULT 0,jobVersion INTEGER NOT NULL DEFAULT 1);
          CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,documentId TEXT NOT NULL REFERENCES documents(id),
            ordinal INTEGER NOT NULL,page INTEGER,locator TEXT NOT NULL,text TEXT NOT NULL,bbox TEXT,itemId TEXT,type TEXT);
          CREATE INDEX IF NOT EXISTS chunk_document ON chunks(documentId,ordinal);
          CREATE INDEX IF NOT EXISTS document_scope ON documents(unit,groupId,archived,status);
        ''')
        self.db.commit()
        self.runner = runner or subprocess.run
        self.jobs = queue.Queue()
        self.stop = threading.Event()
        self.thread = None
        with self.lock, self.db:
            # An interrupted parse is retried from its retained original file.
            self.db.execute("UPDATE documents SET status='queued',error='服务重启，已重新排队',updatedAt=? WHERE status='parsing' AND archived=0",(stamp(),))
            pending = self.db.execute("SELECT id,jobVersion FROM documents WHERE status='queued' AND archived=0 ORDER BY createdAt").fetchall()
        for row in pending: self.jobs.put((row['id'],row['jobVersion']))
        if autostart:
            self.thread = threading.Thread(target=self._worker,name='fuyu-document-parser',daemon=True)
            self.thread.start()

    def close(self):
        self.stop.set()
        self.jobs.put(None)
        if self.thread: self.thread.join(timeout=2)
        if not self.thread or not self.thread.is_alive():
            with self.lock: self.db.close()

    def settings(self):
        defaults = {'engine':'auto','mineruExecutable':str(KNOWN_MINERU) if KNOWN_MINERU.is_file() else '', 'timeoutSeconds':600}
        with self.lock:
            saved = self.db.execute('SELECT value FROM settings WHERE id=1').fetchone()
        if saved: defaults.update(json.loads(saved['value']))
        defaults['mineruAvailable'] = bool(defaults['mineruExecutable'] and Path(defaults['mineruExecutable']).is_file())
        defaults['pdfTextAvailable'] = importlib.util.find_spec('pypdf') is not None
        defaults['formats'] = sorted(MIMES)
        return defaults

    def update_settings(self, body):
        if type(body) is not dict or set(body)-{'engine','mineruExecutable','timeoutSeconds'}:
            raise KnowledgeError('解析设置包含未支持的字段')
        current = self.settings()
        if 'engine' in body and body['engine'] not in ('auto','native','mineru'):
            raise KnowledgeError('解析引擎请选择 auto、native 或 mineru')
        if 'mineruExecutable' in body:
            value = text(body['mineruExecutable'],1000,'MinerU 路径')
            if value:
                path = Path(value)
                if not path.is_absolute() or not path.is_file() or path.suffix.lower() not in ('.exe',''):
                    raise KnowledgeError('请配置已安装的本地 mineru.exe 绝对路径')
            body = {**body,'mineruExecutable':value}
        if 'timeoutSeconds' in body and (type(body['timeoutSeconds']) is not int or not 30<=body['timeoutSeconds']<=1800):
            raise KnowledgeError('解析超时请输入 30–1800 秒的整数')
        saved = {k:body.get(k,current[k]) for k in ('engine','mineruExecutable','timeoutSeconds')}
        with self.lock,self.db:
            self.db.execute('INSERT OR REPLACE INTO settings(id,value) VALUES(1,?)',(json.dumps(saved,ensure_ascii=False),))
        return self.settings()

    def status(self):
        with self.lock:
            counts = {r['status']:r['n'] for r in self.db.execute('SELECT status,COUNT(*) n FROM documents WHERE archived=0 GROUP BY status')}
            archived = self.db.execute('SELECT COUNT(*) FROM documents WHERE archived=1').fetchone()[0]
            chunks = self.db.execute('SELECT COUNT(*) FROM chunks c JOIN documents d ON c.documentId=d.id WHERE d.archived=0 AND d.status=\'ready\'').fetchone()[0]
        config = self.settings()
        return {'documents':sum(counts.values()),'ready':counts.get('ready',0),'queued':counts.get('queued',0),
                'parsing':counts.get('parsing',0),'failed':counts.get('failed',0),'needsEngine':counts.get('needs_engine',0),
                'archived':archived,'chunks':chunks,'counts':counts,'workerRunning':bool(self.thread and self.thread.is_alive()),
                'parser':config,'retrieval':'本地中文词项 BM25','originalsLocal':True}

    def groups(self):
        with self.lock:
            rows = self.db.execute('SELECT g.*,COUNT(d.id) documentCount FROM groups g LEFT JOIN documents d ON d.groupId=g.id AND d.archived=0 GROUP BY g.id ORDER BY g.createdAt,g.id').fetchall()
        return {'groups':[dict(r) for r in rows]}

    def create_group(self, body):
        if type(body) is not dict or set(body)-{'name'}: raise KnowledgeError('分组参数无效')
        name = text(body.get('name'),80,'分组名称',empty=False)
        with self.lock,self.db:
            existing = self.db.execute('SELECT * FROM groups WHERE name=? COLLATE NOCASE',(name,)).fetchone()
            if existing: return {'group':dict(existing)}
            group = {'id':uuid.uuid4().hex,'name':name,'createdAt':stamp()}
            self.db.execute('INSERT INTO groups(id,name,createdAt) VALUES(:id,:name,:createdAt)',group)
        return {'group':group}

    def _meta(self, body, *, partial=False):
        if type(body) is not dict or set(body)-{'label','unit','groupId','objectId','process','archived','archiveStatus'}:
            raise KnowledgeError('资料登记包含未支持的字段')
        result = {}
        for name,maximum in (('label',200),('unit',3),('groupId',40),('objectId',40),('process',20)):
            if name in body: result[name] = text(body[name],maximum,name)
        if 'unit' in result and result['unit'] not in UNITS: raise KnowledgeError('单位工程无效')
        if 'objectId' in result and result['objectId'] and not re.fullmatch(r'[A-Za-z0-9_.:-]{1,40}',result['objectId']): raise KnowledgeError('对象编号无效')
        if 'process' in result and result['process']:
            match=PROCESS_RE.fullmatch(result['process'])
            if not match or not 1<=int(result['process'][-2:])<=PROCESS_LIMITS[match.group(1)]:
                raise KnowledgeError('工序编号无效')
        if result.get('groupId'):
            with self.lock:
                if not self.db.execute('SELECT 1 FROM groups WHERE id=?',(result['groupId'],)).fetchone(): raise KnowledgeError('指定分组不存在')
        if 'archived' in body:
            if type(body['archived']) is not bool: raise KnowledgeError('归档标记格式无效')
            result['archived'] = int(body['archived'])
        if 'archiveStatus' in body:
            if body['archiveStatus'] not in ('active','archived'): raise KnowledgeError('归档标记无效')
            flag = int(body['archiveStatus']=='archived')
            if 'archived' in result and result['archived']!=flag: raise KnowledgeError('归档标记冲突')
            result['archived'] = flag
        return result

    def _public(self, row):
        d = dict(row)
        d.pop('jobVersion',None)
        d['archived'] = bool(d['archived'])
        d['parseStatus'] = d['status']
        if d['archived']: d['status'] = 'archived'
        d['archiveStatus'] = 'archived' if d['archived'] else 'active'
        d['chunks'] = d['chunkCount']
        d['sourceUrl'] = '/api/knowledge/documents/'+d['id']+'/source'
        return d

    def _row(self, document_id):
        if type(document_id) is not str or not ID_RE.fullmatch(document_id): raise KnowledgeError('资料编号无效',404)
        row = self.db.execute('SELECT * FROM documents WHERE id=?',(document_id,)).fetchone()
        if not row: raise KnowledgeError('资料不存在',404)
        return row

    def document(self, document_id):
        with self.lock: return self._public(self._row(document_id))

    def list_documents(self, query=None):
        query = query or {}
        if type(query) is not dict: raise KnowledgeError('筛选参数无效')
        clauses,params = self._scope(query, archived=True)
        needle = str(one(query,'q',one(query,'search',''))).strip()
        with self.lock:
            rows = self.db.execute('SELECT d.* FROM documents d WHERE '+' AND '.join(clauses)+' ORDER BY d.createdAt DESC,d.id',params).fetchall()
        documents = [self._public(r) for r in rows if not needle or needle.casefold() in (r['label']+' '+r['filename']+' '+r['objectId']+' '+r['process']).casefold()]
        return {'documents':documents,'stats':{'total':len(documents),'ready':sum(d['status']=='ready' for d in documents),'queued':sum(d['status'] in ('queued','parsing') for d in documents)}}

    def _scope(self, query, *, archived=False):
        clauses,params = ['1=1'],[]
        show = one(query,'includeArchived',False)
        if not archived or show not in (True,'true','1',1): clauses.append('d.archived=0')
        unit = one(query,'unit','ALL')
        if unit not in UNITS: raise KnowledgeError('单位工程筛选无效')
        if unit!='ALL': clauses.append("d.unit IN (?, 'ALL')");params.append(unit)
        group = one(query,'groupId','')
        if group not in ('','all',None):
            clauses.append('d.groupId=?');params.append('' if group in ('ungrouped','__ungrouped__') else group)
        ids = query.get('documentIds',query.get('docIds',None))
        if ids is not None:
            if type(ids) is str:
                ids = ids.split(',') if ids else []
            if type(ids) is not list or len(ids)>100 or any(type(i) is not str or not ID_RE.fullmatch(i) for i in ids): raise KnowledgeError('资料范围无效')
            if not ids: clauses.append('0=1')
            else: clauses.append('d.id IN ('+','.join('?' for _ in ids)+')');params.extend(ids)
        for field in ('objectId','process'):
            value = one(query,field,'')
            if value and value!='all':
                value=text(value,40,field)
                clauses.append('(d.'+field+"='' OR d."+field+'=?)');params.append(value)
        return clauses,params

    def upload(self, rawbytes, filename, mime='', meta=None):
        if type(rawbytes) is not bytes or not 0<len(rawbytes)<=MAX_UPLOAD: raise KnowledgeError('文件须为非空文件且不超过 40 MiB',413)
        filename = text(filename,255,'文件名',empty=False).replace('\\','/').rsplit('/',1)[-1]
        suffix = Path(filename).suffix.lower()
        if suffix not in MIMES: raise KnowledgeError('支持 PDF、TXT、MD、DOCX、XLSX、PNG、JPEG 和 WEBP')
        if suffix=='.pdf' and not rawbytes[:1024].lstrip().startswith(b'%PDF-'): raise KnowledgeError('PDF 文件签名无效')
        if suffix in ('.docx','.xlsx') and not rawbytes.startswith(b'PK\x03\x04'): raise KnowledgeError('Office 文件格式无效')
        if suffix in ('.txt','.md'):
            self._decode(rawbytes)
        if suffix=='.png' and not rawbytes.startswith(b'\x89PNG\r\n\x1a\n'): raise KnowledgeError('PNG 文件签名无效')
        if suffix in ('.jpg','.jpeg') and not rawbytes.startswith(b'\xff\xd8\xff'): raise KnowledgeError('JPEG 文件签名无效')
        if suffix=='.webp' and not (rawbytes[:4]==b'RIFF' and rawbytes[8:12]==b'WEBP'): raise KnowledgeError('WEBP 文件签名无效')
        values = {'label':filename,'unit':'ALL','groupId':'','objectId':'','process':'',**self._meta(meta or {})}
        if not values['label']: values['label']=filename
        if values['process'] and (values['unit']=='ALL' or not values['process'].startswith(values['unit']+'-')): raise KnowledgeError('关联工序须属于所选单位工程')
        digest = hashlib.sha256(rawbytes).hexdigest()
        with self.lock,self.db:
            duplicate = self.db.execute('SELECT * FROM documents WHERE sha256=? AND unit=? AND groupId=? AND objectId=? AND process=? AND archived=0',(digest,values['unit'],values['groupId'],values['objectId'],values['process'])).fetchone()
            if duplicate: return {'document':self._public(duplicate),'duplicate':True}
            document_id = uuid.uuid4().hex
            path = self.originals/(document_id+suffix)
            path.write_bytes(rawbytes)
            now = stamp()
            try:
                self.db.execute('''INSERT INTO documents(id,filename,label,mime,bytes,sha256,unit,groupId,objectId,process,status,createdAt,updatedAt)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',(document_id,filename,values['label'],MIMES[suffix],len(rawbytes),digest,values['unit'],values['groupId'],values['objectId'],values['process'],'queued',now,now))
            except Exception:
                path.unlink(missing_ok=True)
                raise
            document = self._public(self._row(document_id))
        self.jobs.put((document_id,1))
        return {'document':document,'duplicate':False}

    def source(self, document_id):
        with self.lock:
            row = self._row(document_id)
            path = (self.originals/(row['id']+Path(row['filename']).suffix.lower())).resolve()
            if not path.is_relative_to(self.originals.resolve()) or not path.is_file(): raise KnowledgeError('原件文件不存在',404)
            return path,row['mime'],row['filename']

    def content(self, document_id, page=None):
        document = self.document(document_id)
        params=[document_id]
        extra=''
        if page is not None and page!='':
            try: page=int(page)
            except (ValueError,TypeError): raise KnowledgeError('页码无效')
            if page<1 or page>10000: raise KnowledgeError('页码无效')
            extra=' AND page=?';params.append(page)
        with self.lock:
            rows=self.db.execute('SELECT * FROM chunks WHERE documentId=?'+extra+' ORDER BY ordinal',params).fetchall()
        return {'document':document,'chunks':[self._chunk(row,document) for row in rows],'pages':document['pages']}

    def _chunk(self, row, document):
        result=dict(row)
        result['bboxNormalized']=json.loads(result.pop('bbox')) if result['bbox'] else None
        result['bbox']=result['bboxNormalized']
        result.update({'label':document['label'],'title':document['label'],'unit':document['unit'],'objectId':document['objectId'],
                       'process':document['process'],'sourceUrl':document['sourceUrl']+(('#page='+str(result['page'])) if result['page'] else '')})
        return result

    def update_document(self, document_id, body):
        clean=self._meta(body,partial=True)
        pending=None
        with self.lock,self.db:
            current=dict(self._row(document_id));values={**current,**clean}
            if not values['label']: raise KnowledgeError('资料名称不能为空')
            if values['process'] and (values['unit']=='ALL' or not values['process'].startswith(values['unit']+'-')): raise KnowledgeError('关联工序须属于所选单位工程')
            if 'archived' in clean and clean['archived']!=current['archived'] and current['status'] in ('queued','parsing'):
                # Invalidate a running/queued generation. Restoring must enqueue
                # a fresh generation rather than leave a permanent parsing flag.
                clean.update(status='queued',jobVersion=current['jobVersion']+1,
                             error='已归档，解析已暂停' if clean['archived'] else '')
                if not clean['archived']:pending=(document_id,clean['jobVersion'])
            if clean:
                clean['updatedAt']=stamp()
                self.db.execute('UPDATE documents SET '+','.join(k+'=?' for k in clean)+' WHERE id=?',(*clean.values(),document_id))
            result=self._public(self._row(document_id))
        if pending:self.jobs.put(pending)
        return result

    def reparse(self, document_id):
        with self.lock,self.db:
            row=self._row(document_id)
            if row['archived']: raise KnowledgeError('请先恢复已归档资料，再重新解析')
            if row['status'] in ('queued','parsing'): return self._public(row)
            version=row['jobVersion']+1
            self.db.execute("UPDATE documents SET status='queued',error='',jobVersion=?,updatedAt=? WHERE id=?",(version,stamp(),document_id))
            document=self._public(self._row(document_id))
        self.jobs.put((document_id,version))
        return document

    def search(self, body):
        if type(body) is not dict: raise KnowledgeError('检索参数无效')
        question=text(body.get('query',body.get('q','')),2000,'检索问题',empty=False)
        limit=body.get('limit',body.get('topK',6))
        if type(limit) is not int or not 1<=limit<=12: raise KnowledgeError('检索数量应为 1–12')
        terms=Counter(tokens(question))
        clauses,params=self._scope(body)
        clauses.append("d.status='ready'")
        with self.lock:
            rows=self.db.execute('SELECT c.*,d.label,d.filename,d.unit,d.objectId,d.process,d.groupId FROM chunks c JOIN documents d ON c.documentId=d.id WHERE '+' AND '.join(clauses)+' ORDER BY d.id,c.ordinal LIMIT 40000',params).fetchall()
        if not rows or not terms: return {'hits':[],'query':question,'total':0,'retrieval':'bm25','scope':{k:v for k,v in body.items() if k!='query'}}
        counters=[Counter(tokens(r['text'])) for r in rows]
        average=sum(sum(c.values()) for c in counters)/len(counters) or 1
        frequency={term:sum(term in c for c in counters) for term in terms}
        meaningful=[term for term in terms if not (len(term)==1 and '\u3400'<=term<='\u9fff')]
        scored=[]
        for row,counter in zip(rows,counters):
            # A lone common Chinese character is insufficient evidence for a
            # multi-character question. Retain unigrams for ranking/one-character
            # queries, but require a real word/bigram when the query has one.
            if meaningful and not any(counter.get(term) for term in meaningful):continue
            length=sum(counter.values())
            score=0
            for term in terms:
                tf=counter.get(term,0)
                if not tf: continue
                idf=math.log(1+(len(rows)-frequency[term]+.5)/(frequency[term]+.5))
                weight=.18 if len(term)==1 and '\u3400'<=term<='\u9fff' else 1
                score+=weight*idf*(tf*2.2)/(tf+1.2*(.25+.75*length/average))
            if question.casefold() in row['text'].casefold(): score+=2
            if score>0:
                hit=self._chunk(row,{'label':row['label'],'unit':row['unit'],'objectId':row['objectId'],'process':row['process'],'sourceUrl':'/api/knowledge/documents/'+row['documentId']+'/source'})
                hit['score']=round(score,6)
                scored.append(hit)
        scored.sort(key=lambda h:(-h['score'],h['documentId'],h['ordinal']))
        return {'hits':scored[:limit],'query':question,'total':len(scored),'retrieval':'bm25'}

    def _worker(self):
        while not self.stop.is_set():
            try: job=self.jobs.get(timeout=.5)
            except queue.Empty: continue
            if job is None: self.jobs.task_done();break
            try: self._process(*job)
            finally: self.jobs.task_done()

    def _process(self,document_id,version):
        with self.lock,self.db:
            row=self._row(document_id)
            if row['archived'] or row['jobVersion']!=version or row['status']!='queued': return
            self.db.execute("UPDATE documents SET status='parsing',error='',updatedAt=? WHERE id=?",(stamp(),document_id))
        try:
            path,mime,filename=self.source(document_id)
            chunks,pages,engine=self._parse(path,document_id,self.settings())
            if not chunks: raise KnowledgeError('没有提取到可检索文字，请核查原件或使用 MinerU 解析')
            if len(chunks)>MAX_CHUNKS or sum(len(c['text']) for c in chunks)>MAX_TEXT: raise KnowledgeError('解析结果过大，请拆分文件')
            with self.lock,self.db:
                current=self._row(document_id)
                if current['jobVersion']!=version or current['archived']: return
                self.db.execute('DELETE FROM chunks WHERE documentId=?',(document_id,))
                for i,chunk in enumerate(chunks):
                    self.db.execute('INSERT INTO chunks(id,documentId,ordinal,page,locator,text,bbox,itemId,type) VALUES(?,?,?,?,?,?,?,?,?)',
                      (document_id+'-'+str(i),document_id,i,chunk.get('page'),chunk['locator'],chunk['text'],json.dumps(chunk.get('bboxNormalized')) if chunk.get('bboxNormalized') else None,chunk.get('itemId',str(i)),chunk.get('type','text')))
                self.db.execute("UPDATE documents SET status='ready',error='',pages=?,chunkCount=?,engine=?,parsedAt=?,updatedAt=? WHERE id=?",(pages,len(chunks),engine,stamp(),stamp(),document_id))
        except Exception as exc:
            status='needs_engine' if isinstance(exc,EngineNeeded) else 'failed'
            if isinstance(exc,KnowledgeError): message=str(exc)
            elif isinstance(exc,subprocess.TimeoutExpired): message='本地解析超时，请检查 MinerU 环境或拆分文件后重试'
            else: message='文件解析失败，请检查文件格式、完整性和解析环境后重试'
            with self.lock,self.db:
                self.db.execute('UPDATE documents SET status=?,error=?,updatedAt=? WHERE id=? AND jobVersion=? AND archived=0',(status,message,stamp(),document_id,version))

    @staticmethod
    def _decode(raw):
        if b'\x00' in raw: raise KnowledgeError('文本文件含有二进制内容，请使用 UTF-8 文本')
        try: value=raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            try: value=raw.decode('gb18030')
            except UnicodeDecodeError: raise KnowledgeError('文本编码无法识别，请另存为 UTF-8 后导入') from None
        if len(value)>MAX_TEXT: raise KnowledgeError('文字数量超过本机索引上限，请拆分文件')
        return value

    @staticmethod
    def _split(value,locator,page=None,kind='text'):
        value=value.strip()
        if not value:return []
        return [{'text':value[start:start+1600],'locator':locator,'page':page,'bboxNormalized':None,'type':kind} for start in range(0,len(value),1500)]

    def _parse(self,path,document_id,settings):
        suffix=path.suffix.lower()
        if suffix in ('.txt','.md'):
            value=self._decode(path.read_bytes());lines=value.splitlines();chunks=[];buffer=[];size=0;first=1
            for n,line in enumerate(lines,1):
                if size+len(line)>1400 and buffer:
                    chunks.extend(self._split('\n'.join(buffer),f'第 {first}–{n-1} 行'));buffer=[];size=0;first=n
                buffer.append(line);size+=len(line)+1
            chunks.extend(self._split('\n'.join(buffer),f'第 {first}–{len(lines)} 行'))
            return chunks,None,'native-text'
        if suffix in ('.docx','.xlsx'): return self._office(path,suffix)
        if settings['engine']=='mineru' or suffix in ('.png','.jpg','.jpeg','.webp'):
            if settings['engine']=='native': raise EngineNeeded('图片或扫描件需要本地 MinerU；请在设置 → 资料解析配置引擎')
            return self._mineru(path,document_id,settings)
        if suffix=='.pdf':
            try: from pypdf import PdfReader
            except ImportError:
                if settings['engine']=='auto' and settings['mineruAvailable']: return self._mineru(path,document_id,settings)
                raise EngineNeeded('PDF 文字解析需要 pypdf 或本地 MinerU；请安装 requirements.txt 或配置 MinerU') from None
            try:
                reader=PdfReader(str(path),strict=False)
                if reader.is_encrypted and not reader.decrypt(''): raise KnowledgeError('PDF 已加密，请提供可读取的文件')
                if len(reader.pages)>1000: raise KnowledgeError('PDF 超过 1000 页，请按卷拆分导入')
                chunks=[];total=0;empty=0
                for n,page in enumerate(reader.pages,1):
                    value=(page.extract_text() or '').strip();total+=len(value)
                    if total>MAX_TEXT: raise KnowledgeError('PDF 文字量超过本机索引上限，请拆分文件')
                    if len(value)<8:empty+=1
                    chunks.extend(self._split(value,'第 '+str(n)+' 页',n))
                if empty:
                    if settings['engine']=='auto' and settings['mineruAvailable']: return self._mineru(path,document_id,settings)
                    raise EngineNeeded('PDF 包含无法提取文字的扫描页；请配置本地 MinerU 后重试，以免遗漏页面')
                return chunks,len(reader.pages),'native-pdf'
            except (KnowledgeError,EngineNeeded):raise
            except Exception:raise KnowledgeError('PDF 无法读取，请检查文件完整性或改用本地 MinerU') from None
        raise KnowledgeError('不支持的文件格式')

    def _office(self,path,suffix):
        try:
            archive=zipfile.ZipFile(path)
        except zipfile.BadZipFile: raise KnowledgeError('Office 压缩包无效') from None
        with archive:
            infos=archive.infolist()
            if len(infos)>10000 or sum(i.file_size for i in infos)>48*1024*1024 or any(i.file_size>16*1024*1024 or i.flag_bits&1 for i in infos): raise KnowledgeError('Office 展开内容超过安全解析上限或已加密')
            if any(i.filename.startswith(('/','\\')) or '..' in Path(i.filename.replace('\\','/')).parts for i in infos): raise KnowledgeError('Office 压缩包含非法路径')
            def xml(name):
                raw=archive.read(name)
                if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():raise KnowledgeError('Office XML 含不支持的外部实体声明')
                return ET.fromstring(raw)
            if suffix=='.docx':
                try: root=xml('word/document.xml')
                except (KeyError,ET.ParseError):raise KnowledgeError('DOCX 正文结构无效') from None
                ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                body=root.find('w:body',ns);chunks=[]
                if body is None:raise KnowledgeError('DOCX 没有正文')
                paragraph=0;table=0
                for el in body:
                    local=el.tag.rsplit('}',1)[-1]
                    if local=='p':
                        paragraph+=1;value=''.join(el.itertext()) if not el.findall('.//w:t',ns) else ''.join(n.text or '' for n in el.findall('.//w:t',ns))
                        chunks.extend(self._split(value,f'段落 {paragraph}'))
                    elif local=='tbl':
                        table+=1
                        rows=[' | '.join(''.join(n.text or '' for n in cell.findall('.//w:t',ns)) for cell in row.findall('w:tc',ns)) for row in el.findall('w:tr',ns)]
                        chunks.extend(self._split('\n'.join(rows),f'表格 {table}',kind='table'))
                return chunks,None,'native-docx'
            ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            try:
                workbook=xml('xl/workbook.xml');rels=xml('xl/_rels/workbook.xml.rels')
            except (KeyError,ET.ParseError):raise KnowledgeError('XLSX 工作簿结构无效') from None
            targets={r.attrib.get('Id'):r.attrib.get('Target','') for r in rels if r.attrib.get('TargetMode')!='External'}
            shared=[]
            if 'xl/sharedStrings.xml' in archive.namelist():
                shared=[''.join(n.text or '' for n in si.findall('.//s:t',ns)) for si in xml('xl/sharedStrings.xml').findall('s:si',ns)]
            chunks=[];cells=0;total=0
            for sheet in workbook.findall('s:sheets/s:sheet',ns):
                rid=sheet.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
                target=targets.get(rid,'').replace('\\','/')
                if not target or '..' in Path(target).parts:raise KnowledgeError('XLSX 工作表引用无效')
                name=target.lstrip('/') if target.startswith('/') else 'xl/'+target
                try: root=xml(name)
                except (KeyError,ET.ParseError):raise KnowledgeError('XLSX 工作表内容无效') from None
                for row in root.findall('s:sheetData/s:row',ns):
                    values=[];refs=[]
                    for cell in row.findall('s:c',ns):
                        cells+=1
                        if cells>200000:raise KnowledgeError('XLSX 单元格过多，请拆分文件')
                        ref=cell.attrib.get('r','')
                        if not re.fullmatch(r'[A-Z]{1,4}[1-9][0-9]{0,6}',ref):continue
                        kind=cell.attrib.get('t');v=cell.find('s:v',ns)
                        value=v.text or '' if v is not None else ''
                        if kind=='s':
                            try:value=shared[int(value)]
                            except (ValueError,IndexError):raise KnowledgeError('XLSX 共享字符串引用无效') from None
                        elif kind=='inlineStr':value=''.join(t.text or '' for t in cell.findall('.//s:t',ns))
                        if value:
                            refs.append(ref);values.append(ref+': '+value);total+=len(value)
                        if total>MAX_TEXT:raise KnowledgeError('XLSX 文字量超过本机索引上限')
                    if values:chunks.extend(self._split(' | '.join(values),sheet.attrib.get('name','工作表')+'!'+refs[0]+(':'+refs[-1] if len(refs)>1 else ''),kind='table'))
            return chunks,None,'native-xlsx'

    def _mineru(self,path,document_id,settings):
        executable=settings['mineruExecutable']
        if not executable or not Path(executable).is_file():raise EngineNeeded('请在设置 → 资料解析填写已安装的 mineru.exe 路径，然后重试')
        output=self.work/(document_id+'-'+uuid.uuid4().hex[:12]);output.mkdir()
        env=os.environ.copy();env['MINERU_MODEL_SOURCE']='modelscope';env['NO_PROXY']=','.join(filter(None,[env.get('NO_PROXY',''),'localhost','127.0.0.1']))
        args=[executable,'-p',str(path),'-o',str(output),'-b','pipeline','-m','auto','-t','true','-f','false','-l','ch']
        with (output/'engine.log').open('wb') as log:
            result=self.runner(args,stdout=log,stderr=subprocess.STDOUT,timeout=settings['timeoutSeconds'],env=env,shell=False,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        if result.returncode:raise KnowledgeError('MinerU 解析失败，请检查本机模型、运行环境与文件；处理记录在知识库解析目录')
        files=sorted(output.rglob('*_content_list.json')) or sorted(output.rglob('*_content_list_v2.json'))
        if not files:raise KnowledgeError('MinerU 未生成可定位的结构化结果；请检查解析版本与输出')
        file=files[0]
        if not file.resolve().is_relative_to(output.resolve()) or file.stat().st_size>24*1024*1024:raise KnowledgeError('MinerU 结构化结果无效或过大')
        chunks=mineru_chunks(json.loads(file.read_text('utf-8-sig')))
        pages=max((c['page'] or 0 for c in chunks),default=0) or None
        if path.suffix.lower()=='.pdf':
            try:
                from pypdf import PdfReader
                pages=len(PdfReader(str(path),strict=False).pages)
            except Exception:
                pass
        return chunks,pages,'mineru'
