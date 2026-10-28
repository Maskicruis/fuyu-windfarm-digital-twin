from pathlib import Path
p=Path(__file__).with_name('runtime.js');t=p.read_text(encoding='utf-8')
t=t.replace("kind:el===widget.el?'组件':svg?'图形':", "kind:el===widget.el?'组件':svg?'图形':")
t=t.replace("(el.getAttribute('aria-label')||el.getAttribute('title')||el.tagName.toLowerCase())", "(el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||(el.textContent||'').trim().slice(0,32)||el.tagName.toLowerCase())")
t=t.replace("document.addEventListener('click',e=>{if(editing&&targetFrom(e)){e.preventDefault();e.stopImmediatePropagation();}},true);", "document.addEventListener('click',e=>{if(editing&&targetFrom(e)){e.preventDefault();e.stopImmediatePropagation();}else if(!editing)schedule();},true);")
p.write_text(t,encoding='utf-8')
