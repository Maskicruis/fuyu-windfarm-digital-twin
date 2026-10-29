"""Extract SpecFlow's original file/LLM UI and remove unrelated workbench features.

Chat rendering, stream decoding, image handling and PDF/source navigation are
copied from the reference. No previously-created Python widget UI is used.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import shutil

ROOT=Path(__file__).resolve().parent.parent
DEFAULT_REFERENCE=ROOT.parent/'开发参考/specflow-engineering-studio'
TARGET=ROOT/'specflow-component'
RETAINED_MODULES=('chat-images.js','chat-images.css','stream-client.js','chat-view.js','chat-view.css')


def element_range(text,tag,attribute,value):
    start=re.search(r'<'+tag+r'\b[^>]*\b'+attribute+r'="'+re.escape(value)+r'"[^>]*>',text)
    if not start:
        raise ValueError(f'Expected element missing: {tag} {attribute}={value}')
    depth=0
    for token in re.finditer(r'</?'+tag+r'\b[^>]*>',text[start.start():]):
        depth += -1 if token.group().startswith('</') else 1
        if depth==0:
            return start.start(),start.start()+token.end()
    raise ValueError(f'Unclosed element: {value}')


def remove_element(text,tag,attribute,value):
    a,b=element_range(text,tag,attribute,value)
    return text[:a]+text[b:]


def function_block(script,name):
    # All reference top-level functions end with a column-zero closing brace.
    match=re.search(r'^(?:async )?function '+re.escape(name)+r'\(',script,re.M)
    if not match:
        raise ValueError('Expected function missing: '+name)
    end=re.search(r'^}\r?\n',script[match.start():],re.M)
    if not end:
        raise ValueError('Expected function terminator missing: '+name)
    return script[match.start():match.start()+end.end()]


def replace_function(script,name,body):
    return script.replace(function_block(script,name),body,1)


def remove_functions(script,start,end):
    a=re.search(r'^(?:async )?function '+re.escape(start)+r'\(',script,re.M).start()
    b=re.search(r'^(?:async )?function '+re.escape(end)+r'\(',script,re.M).start()
    return script[:a]+script[b:]


def split_selectors(value):
    output=[];start=0;depth=0;quote='';escaped=False
    for i,c in enumerate(value):
        if quote:
            if escaped:escaped=False
            elif c=='\\':escaped=True
            elif c==quote:quote=''
        elif c in ('"',"'"):quote=c
        elif c in '([':depth+=1
        elif c in ')]':depth-=1
        elif c==',' and depth==0:output.append(value[start:i]);start=i+1
    output.append(value[start:])
    return output


RETIRED_SELECTOR=re.compile(r'[.#](?:engineering(?:-|\b)|tools(?:-|\b)|studio(?:-|\b)|project(?:-|\b)|checklist(?:-|\b)|check-(?!mark)|folder-|metric-|tool-|road-|slope-|spec-monitor|monitor-|harness|title-update|update-)')


def trim_css(css):
    """Remove retired selectors/declarations, including nested media rules."""
    css=re.sub(r'/\*[\s\S]*?\*/','',css)
    out=[];i=0
    while i<len(css):
        opening=css.find('{',i)
        if opening<0:break
        header=css[i:opening].strip();depth=1;j=opening+1;quote='';escaped=False
        while j<len(css) and depth:
            c=css[j]
            if quote:
                if escaped:escaped=False
                elif c=='\\':escaped=True
                elif c==quote:quote=''
            elif c in ('"',"'"):quote=c
            elif c=='{':depth+=1
            elif c=='}':depth-=1
            j+=1
        if depth:raise ValueError('Unbalanced CSS')
        body=css[opening+1:j-1]
        if header.startswith(('@media','@supports','@layer','@container')):
            body=trim_css(body)
            if body:out.append(header+'{'+body+'}')
        elif header.startswith('@'):
            if not re.search(r'road|slope|harness|monitor',header,re.I):out.append(header+'{'+body+'}')
        else:
            selectors=[part.strip() for part in split_selectors(header) if part.strip() and not RETIRED_SELECTOR.search(part)]
            if selectors:out.append(','.join(selectors)+'{'+body+'}')
        i=j
    return '\n'.join(out)


def extract(reference):
    TARGET.mkdir(exist_ok=True)
    original=(reference/'ui.html').read_text('utf-8')
    script_match=re.search(r'<script>\r?\nvar DOCS=[\s\S]*?</script>',original)
    if not script_match:raise ValueError('SpecFlow main script not found')
    script=script_match.group()[len('<script>'): -len('</script>')]
    before=original[:script_match.start()]
    after=original[script_match.end():]
    retained_functions={name:function_block(script,name) for name in ('citationAttrs','citationLink','citationSourceLink','answerHtml','citationCard','appendUserTurn','appendAssistantTurn','askQuestion','openCitation','openCitationFromLocation')}
    pdf_module=re.search(r'<script type="module">[\s\S]*?</script>',after).group()

    for tag,attribute,value in (
        ('section','id','designSection'),('section','id','toolsSection'),
        ('section','data-settings-pane','workspace'),('section','data-settings-pane','integration'),('section','data-settings-pane','updates'),
        ('div','id','specMonitorDialog'),('div','class','engine-card spec-monitor-summary'),
        ('button','id','balanceTitleButton'),('button','id','updateTitleButton'),
        ('button','data-page','design'),('button','data-page','tools'),
        ('button','data-settings-tab','workspace'),('button','data-settings-tab','integration'),('button','data-settings-tab','updates'),
    ):
        before=remove_element(before,tag,attribute,value)
    before=before.replace('<div class="nav-label">工程助手</div>','<div class="nav-label">知识与文档</div>')
    before=before.replace('<div class="nav-divider"></div><div class="nav-label">设计工具</div>','')
    before=before.replace('class="nav-item" data-page="assistant"','class="nav-item active" data-page="assistant"')
    before=before.replace('class="workspace-page assistant-page"','class="workspace-page assistant-page active"')
    before=before.replace('data-page="assistant" aria-label="知识库问答"','data-page="assistant" aria-label="知识库问答"')
    before=before.replace('<span class="nav-key">Ctrl 2</span>','<span class="nav-key">Ctrl 1</span>',1)
    before=before.replace('<span class="nav-key">Ctrl 3</span>','<span class="nav-key">Ctrl 2</span>',1)
    before=before.replace('</nav>\n    <section class="recent-section"','<button class="nav-item" data-scroll="settingsSection" aria-label="设置"><span>设置</span><span class="nav-key">API · MinerU</span></button></nav>\n    <section class="recent-section"',1)
    before=before.replace('连接、解析、模型与应用更新','资料存储、解析与模型接口')
    before=before.replace('class="settings-tab" data-act="settingsTab" data-settings-tab="parser"','class="settings-tab active" data-act="settingsTab" data-settings-tab="parser"')
    before=before.replace('class="settings-pane" data-settings-pane="parser"','class="settings-pane active" data-settings-pane="parser"')
    before=before.replace('<title>SpecFlow 知识库</title>','<title>SpecFlow 知识组件</title>')
    before=before.replace('SpecFlow Engineering Studio','SpecFlow Knowledge Component').replace('Rail · New Energy','Files · Parsing · LLM').replace('Rail &amp; new-energy workspace','Files · Parsing · LLM')
    before=before.replace('<link rel="stylesheet" href="/app/workspace.css">','')
    # The model-status button uses the same original styling; it is not an account-balance feature.
    before=before.replace('title-balance','title-model')
    before=re.sub(r'<style>([\s\S]*?)</style>',lambda match:'<style>'+trim_css(match.group(1))+'</style>',before,count=1)
    after=after.replace('<script src="/app/workspace.js"></script>','')

    script=script.replace(', UPDATE_STATUS=null, CONNECTOR_STATUS=null','')
    script=script.replace("modelButton.className='title-tool title-balance '","modelButton.className='title-tool title-model '")
    script=remove_functions(script,'renderConnectorStatus','updateFileMeta')
    # Retain the original desktop bridge only for files, runtime and window controls.
    init='''function initDesktop(){
  if(!DESKTOP) return;
  document.body.classList.add('desktop-app');
  var settingsPanel=document.getElementById('settingsSection'); if(settingsPanel) document.body.appendChild(settingsPanel);
  DESKTOP.app.info().then(function(info){var status=document.getElementById('desktopRuntime');if(status)status.textContent=(info.fallback?'端口 '+info.configuredPort+' 被占用 · 临时端口 ':'本地服务 · 端口 ')+info.port;}).catch(function(){var status=document.getElementById('desktopRuntime');if(status)status.textContent='本地服务已连接';});
  loadLlmState();
}
'''
    # Insert before updateFileMeta (the retired connector/update block included old initDesktop).
    script=script.replace('function updateFileMeta(){',init+'function updateFileMeta(){',1)
    script=replace_function(script,'showPage', '''function showPage(name){
  var page=['assistant','database'].indexOf(name)>=0?name:'assistant';
  document.querySelectorAll('[data-workspace-page]').forEach(function(el){ el.classList.toggle('active',el.getAttribute('data-workspace-page')===page); });
  document.querySelectorAll('.nav-item[data-page]').forEach(function(el){ el.classList.toggle('active',el.getAttribute('data-page')===page); });
  try{ localStorage.setItem('specflow-page',page); }catch(e){}
}
''')
    script=replace_function(script,'selectSettingsTab', '''function selectSettingsTab(name){
  var allowed=['parser','model']; var next=allowed.indexOf(name)>=0?name:'parser'; ACTIVE_SETTINGS_TAB=next;
  document.querySelectorAll('[data-settings-tab]').forEach(function(button){ button.classList.toggle('active',button.getAttribute('data-settings-tab')===next); });
  document.querySelectorAll('[data-settings-pane]').forEach(function(pane){ pane.classList.toggle('active',pane.getAttribute('data-settings-pane')===next); });
  try{ localStorage.setItem('specflow-settings-tab',next); }catch(e){}
}
''')
    script=script.replace("jump.id==='updateTitleButton'?'updates':jump.id==='modelTitleButton'?'model':", "jump.id==='modelTitleButton'?'model':")
    retired_action_lines=("act==='installConnector'","act==='refreshConnector'","act==='openConnectorProfile'","act==='checkUpdate'","act==='downloadUpdate'","act==='installUpdate'","act==='openRelease'")
    script='\n'.join(line for line in script.split('\n') if not any(marker in line for marker in retired_action_lines) and "document.getElementById('autoCheckUpdates').addEventListener" not in line)
    script=script.replace("if(e.ctrlKey&&e.key==='1'){ e.preventDefault(); showPage('design'); return; }", "if(e.ctrlKey&&e.key==='1'){ e.preventDefault(); showPage('assistant'); return; }")
    script=script.replace("if(e.ctrlKey&&e.key==='2'){ e.preventDefault(); showPage('assistant'); return; }", "if(e.ctrlKey&&e.key==='2'){ e.preventDefault(); showPage('database'); return; }")
    script='\n'.join(line for line in script.split('\n') if "if(e.ctrlKey&&e.key==='3')" not in line and "if(e.ctrlKey&&e.key==='4')" not in line)
    script=script.replace("localStorage.getItem('specflow-page')||'design'", "localStorage.getItem('specflow-page')||'assistant'").replace("catch(e){ showPage('design'); }", "catch(e){ showPage('assistant'); }")
    script=script.replace("localStorage.getItem('specflow-settings-tab')||'workspace'", "localStorage.getItem('specflow-settings-tab')||'parser'").replace("catch(e){ selectSettingsTab('workspace'); }", "catch(e){ selectSettingsTab('parser'); }")
    for name,value in retained_functions.items():
        if function_block(script,name)!=value:
            raise ValueError('Core original function changed: '+name)
    html=before+'<script>'+script+'</script>'+after
    if re.search(r'workspace\.js|workspace\.css|data-studio-act|specMonitor|balanceTitleButton|updateTitleButton|data-settings-pane="(?:workspace|integration|updates)"',html):
        raise ValueError('Retired UI reference remains')
    (TARGET/'ui.html').write_text(html,'utf-8')
    (TARGET/'ui-modules').mkdir(exist_ok=True)
    hashes={}
    for name in RETAINED_MODULES:
        source=reference/'ui-modules'/name;target=TARGET/'ui-modules'/name
        shutil.copy2(source,target)
        digest=hashlib.sha256(source.read_bytes()).hexdigest()
        assert hashlib.sha256(target.read_bytes()).hexdigest()==digest
        hashes['ui-modules/'+name]=digest
    theme=trim_css((reference/'ui-modules/brand-theme.css').read_text('utf-8').replace('title-balance','title-model'))
    (TARGET/'ui-modules/brand-theme.css').write_text(theme,'utf-8')
    (TARGET/'lib').mkdir(exist_ok=True)
    for source in (reference/'lib').iterdir():
        if source.is_file():
            shutil.copy2(source,TARGET/'lib'/source.name)
            hashes['lib/'+source.name]=hashlib.sha256(source.read_bytes()).hexdigest()
    for name in ('PDFJS_LICENSE.txt','PDFJS_NOTICE.txt'):
        source=ROOT/'lib'/name
        if source.exists():shutil.copy2(source,TARGET/'lib'/name)
    (TARGET/'build').mkdir(exist_ok=True)
    shutil.copy2(reference/'build/specflow-mark.svg',TARGET/'build/specflow-mark.svg')
    provenance={'reference':'Maskicruis/specflow-engineering-studio','reference_commit':'b076c50fe5df28c628f97b5eafa052c1dff0188b',
        'retained_module_sha256':hashes,
        'retained_inline_function_sha256':{name:hashlib.sha256(code.encode()).hexdigest() for name,code in retained_functions.items()},
        'pdf_reader_module_sha256':hashlib.sha256(pdf_module.encode()).hexdigest(),
        'changes':['Removed project/design/checklist/tools/website-monitor/Harness/update/balance markup, state, handlers and modules.','Default navigation has only assistant/database; settings has parser/model only.','Unused feature selectors removed; original chat/image/stream modules and original PDF reader retained.']}
    assert pdf_module in html
    (TARGET/'ui-provenance.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2),'utf-8')
    print(json.dumps({'ui_bytes':len(html.encode()),'retained_original_modules':len(hashes),'core_inline_functions_unchanged':len(retained_functions),'pdf_reader_unchanged':True},ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--reference',type=Path,default=DEFAULT_REFERENCE)
    extract(parser.parse_args().reference)
