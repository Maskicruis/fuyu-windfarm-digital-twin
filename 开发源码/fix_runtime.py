from pathlib import Path
p=Path(__file__).with_name('runtime.js');t=p.read_text(encoding='utf-8')
t=t.replace("n.className===el.className", "(n.getAttribute('class')||'')===(el.getAttribute('class')||'')")
t=t.replace("if(n===el)break;if(n.tagName", "if(n===el)break;if(n.dataset?.v9Text)continue;if(n.tagName")
t=t.replace("e.origin!==location.origin", "e.origin!==expectedOrigin")
t=t.replace("const baseObjects=new Map", "const baseAssets=new Map(assets.map(a=>[a.id,{...a}]));\nconst baseObjects=new Map")
t=t.replace("function applyData(){for(const [unit,items]", "function applyData(){for(const a of assets){const b=baseAssets.get(a.id);if(b)for(const f of ['name','process','status'])a[f]=b[f];}for(const [unit,items]")
p.write_text(t,encoding='utf-8')
