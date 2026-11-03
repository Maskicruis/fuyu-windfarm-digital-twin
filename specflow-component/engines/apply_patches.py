"""Reproducible compatibility patch for fast-langdetect 0.2.5 / FastText on Windows.

FastText's narrow-character file API cannot open a Unicode Windows path. Python
can change to that directory; FastText then opens only the ASCII model filename.
The lock serializes model loaders and finally restores the caller's directory.
The original library and its license remain in the resource distribution.
"""
from pathlib import Path
import argparse, shutil, json, hashlib

MARKER = '# SpecFlow: Windows Unicode FastText model path compatibility'
ORIGINAL = '        return fasttext.load_model(str(model_path))'
REPLACEMENT = '''        # SpecFlow: Windows Unicode FastText model path compatibility
        if os.name == "nt":
            with _specflow_model_path_lock:
                absolute_path = Path(model_path).resolve()
                previous_directory = os.getcwd()
                try:
                    os.chdir(absolute_path.parent)
                    return fasttext.load_model(absolute_path.name)
                finally:
                    os.chdir(previous_directory)
        return fasttext.load_model(str(model_path))'''

def patch_engine(engine):
    file = Path(engine) / 'python/Lib/site-packages/fast_langdetect/ft_detect/infer.py'
    original = file.read_text(encoding='utf8')
    if MARKER in original:
        return file
    if original.count(ORIGINAL) != 1 or 'import fasttext\n' not in original:
        raise RuntimeError('Unsupported fast-langdetect source; review compatibility patch')
    patched = original.replace('import fasttext\n', 'import fasttext\nimport threading\n_specflow_model_path_lock = threading.RLock()\n', 1)
    file.write_text(patched.replace(ORIGINAL, REPLACEMENT, 1), encoding='utf8')
    return file

def patch_pipeline(engine):
    folder = Path(engine)/'python/Lib/site-packages/mineru/backend/pipeline'
    file = folder/'pipeline_analyze.py'
    source = file.read_text(encoding='utf8')
    marker = '# SpecFlow resumable windows v1'
    if marker not in source:
        replacements = [
            ('import os\n', 'import os\n# SpecFlow resumable windows v1\nfrom . import _specflow_checkpoint as sf_checkpoint\n'),
            ("    if context['closed']:\n        return\n", "    if context['closed']:\n        return\n    sf_checkpoint.finalizing(context)\n"),
            ("            total_pages += page_count\n", "            sf_checkpoint.restore(context, parse_method, formula_enable, table_enable)\n            total_pages += page_count\n"),
            ('        processed_pages = 0\n', "        processed_pages = sum(c['next_page_idx'] for c in doc_contexts)\n        for context in doc_contexts:\n            if context['next_page_idx'] == context['page_count'] and not context['closed']:\n                _finalize_processing_window_context(context, on_doc_ready, client_side_output_generation)\n"),
            ('            batch_index = 0\n', '            batch_index = processed_pages // window_size\n'),
            ('                        result_offset += take_count\n', '                        result_offset += take_count\n                        sf_checkpoint.save(context)\n'),
        ]
        for before, after in replacements:
            if source.count(before) != 1: raise RuntimeError('Unsupported MinerU processing window source: '+before)
            source = source.replace(before, after, 1)
        file.write_text(source, encoding='utf8')
    helper=folder/'_specflow_checkpoint.py'
    candidate=Path(__file__).with_name('checkpoint.py')
    if not helper.exists() or helper.read_bytes()!=candidate.read_bytes():shutil.copy2(candidate,helper)
    return [file,helper]

def prepare(engine):
    engine=Path(engine)
    files=[patch_engine(engine),*patch_pipeline(engine)]
    entry=Path(__file__).with_name('run_mineru.py');target=engine/entry.name
    if not target.exists() or target.read_bytes()!=entry.read_bytes():shutil.copy2(entry,target)
    files.append(target)
    marker={'version':'1.3.1','files':{p.relative_to(engine).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
    (engine/'component-patches.json').write_text(json.dumps(marker,indent=2),encoding='utf8')
    return marker

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('engine', type=Path)
    print(json.dumps(prepare(parser.parse_args().engine)))
