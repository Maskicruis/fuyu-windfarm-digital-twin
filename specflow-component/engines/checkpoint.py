"""SpecFlow adapter for MinerU 3.4.5 processing windows. JSON only, no pickle.

The cache key includes the complete PDF bytes, parser flags and adapter version.
Commit images before atomically replacing state. Resume preserves original page
indexes and replays final document postprocessing, not partial answers.
"""
from pathlib import Path
import hashlib, json, os, shutil, uuid, re

VERSION = 'mineru-3.4.5-specflow-window-v1'

def event(**fields):
    print('SPECFLOW_PROGRESS ' + json.dumps(fields, ensure_ascii=False), flush=True)

def _json_value(value):
    if hasattr(value, 'tolist'): return value.tolist()
    if hasattr(value, 'item'): return value.item()
    raise TypeError('Unsupported checkpoint value: ' + type(value).__name__)

def restore(context, parse_method, formula_enable, table_enable):
    root = os.environ.get('KB_PARSER_CHECKPOINT_DIR')
    if not root: return
    flags = json.dumps([VERSION, parse_method, formula_enable, table_enable, context['lang'], context['page_count']])
    # MinerU rebuilds PDF bytes during preprocessing; object IDs/timestamps may
    # change across runs. The host hashes the immutable original, not that copy.
    original = os.environ.get('KB_PARSER_SOURCE_SHA256','')
    identity = original.encode() if re.fullmatch(r'[a-f0-9]{64}',original) else context['pdf_bytes']
    digest = hashlib.sha256(identity + flags.encode()).hexdigest()
    directory = Path(root) / digest
    directory.mkdir(parents=True, exist_ok=True)
    context['_specflow_cache'] = directory
    image_root = Path(context['image_writer']._parent_dir)
    try:
        state = json.loads((directory/'state.json').read_text('utf8'))
        completed = state['completed']
        if state['version'] != VERSION or state['total'] != context['page_count']: return
        if not isinstance(completed, int) or not 0 <= completed <= context['page_count']: return
        infos = state['middle_json']['pdf_info']
        if len(infos) != completed or len(state['model_list']) != completed: return
        if [p.get('page_idx') for p in infos] != list(range(completed)): return
        # An incomplete snapshot is never used as the next window's starting point.
        for entry in state['images']:
            file = Path(entry['name'])
            if file.is_absolute() or '..' in file.parts: return
            cached = directory/'images'/file
            if not cached.is_file() or cached.stat().st_size != entry['bytes']: return
        for entry in state['images']:
            target = image_root/entry['name']; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(directory/'images'/entry['name'], target)
        context['middle_json'] = state['middle_json']
        context['model_list'] = state['model_list']
        context['next_page_idx'] = completed
        event(event='resume', completed=completed, total=context['page_count'])
    except FileNotFoundError: pass
    except Exception as error:
        event(event='checkpoint-warning', message='检查点无效，从原件重新解析：'+str(error))

def save(context):
    directory = context.get('_specflow_cache')
    completed = context['next_page_idx']
    if directory:
        try:
            image_root = Path(context['image_writer']._parent_dir)
            images = []
            for source in image_root.rglob('*'):
                if not source.is_file(): continue
                name = source.relative_to(image_root).as_posix()
                target = directory/'images'/name
                if not target.is_file() or target.stat().st_size != source.stat().st_size:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    temporary = target.with_name(target.name+'.tmp')
                    shutil.copy2(source, temporary); os.replace(temporary, target)
                images.append({'name':name, 'bytes':source.stat().st_size})
            state = {'version':VERSION, 'completed':completed, 'total':context['page_count'],
                     'middle_json':context['middle_json'], 'model_list':context['model_list'], 'images':images}
            temporary = directory/('state.'+uuid.uuid4().hex+'.tmp')
            try:
                with temporary.open('w', encoding='utf8') as stream:
                    json.dump(state, stream, ensure_ascii=False, default=_json_value)
                    stream.flush(); os.fsync(stream.fileno())
                os.replace(temporary, directory/'state.json')
            finally: temporary.unlink(missing_ok=True)
            event(event='checkpoint', completed=completed, total=context['page_count'])
        except Exception as error:
            event(event='checkpoint-warning', message='无法保存检查点：'+str(error))
    event(event='pages', completed=completed, total=context['page_count'])

def finalizing(context):
    event(event='finalizing', completed=context['page_count'], total=context['page_count'])
