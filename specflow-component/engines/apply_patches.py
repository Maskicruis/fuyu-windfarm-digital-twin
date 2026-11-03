"""Reproducible compatibility patch for fast-langdetect 0.2.5 / FastText on Windows.

FastText's narrow-character file API cannot open a Unicode Windows path. Python
can change to that directory; FastText then opens only the ASCII model filename.
The lock serializes model loaders and finally restores the caller's directory.
The original library and its license remain in the resource distribution.
"""
from pathlib import Path
import argparse

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

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('engine', type=Path)
    print(patch_engine(parser.parse_args().engine))
