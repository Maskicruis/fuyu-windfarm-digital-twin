from pathlib import Path
p=Path(__file__).with_name('admin.js')
t=p.read_text(encoding='utf-8')
t=t.replace("let list=nodes.filter(n=>treeFilter==='texts'?n.editableText:treeFilter==='components'?!n.editableText:true);if(query)list=list.filter", "let list=query?nodes:nodes.filter(n=>treeFilter==='texts'?n.editableText:treeFilter==='components'?(n.kind==='组件'||!n.parentId)&&!n.editableText:true);if(query)list=list.filter")
t=t.replace("let textPage=0,search='',contentSearch='',zoom='auto'", "const textDrafts=new Map();let textPage=0,search='',contentSearch='',zoom='auto'")
t=t.replace("input.value=node.text||'';input.rows=", "const draftKey=currentKey+'|'+node.id;input.value=textDrafts.has(draftKey)?textDrafts.get(draftKey):(node.text||'');input.oninput=()=>textDrafts.set(draftKey,input.value);input.rows=")
t=t.replace("apply.onclick=()=>send('patch',{id:node.id,patch:{text:input.value}});", "apply.onclick=()=>{textDrafts.delete(draftKey);send('patch',{id:node.id,patch:{text:input.value}});};")
p.write_text(t,encoding='utf-8')
