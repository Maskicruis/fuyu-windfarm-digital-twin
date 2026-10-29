'use strict';
// Thin host adapter. Parsing, retrieval, citations and streaming remain in original SpecFlow.
const Stream=require('../ui-modules/stream-client');
class SpecFlowKnowledgeClient{
 constructor(baseUrl){const u=new URL(baseUrl);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('Use a local component service or your own authenticated gateway.');this.base=u.origin;}
 async request(route,options={}){const r=await fetch(this.base+route,options);if(!r.ok)throw Error('SpecFlow HTTP '+r.status);return r;}
 async capabilities(){return (await this.request('/api/v1/capabilities')).json();}
 async uploadPdf(filename,bytes,groupId=''){return(await this.request('/api/v1/jobs',{method:'POST',headers:{'Content-Type':'application/pdf','X-File-Name':encodeURIComponent(filename),'X-Group-Id':groupId},body:bytes})).json();}
 async askStream(payload,onEvent,{signal}={}){let done=false;const response=await this.request('/api/v1/ask/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});if(!/text\/event-stream/i.test(response.headers.get('content-type')||''))throw Error('Expected SSE');await Stream.json(response,event=>{if(event.type==='error')throw Error(event.error||'Model stream failed');if(event.type==='done')done=true;onEvent(event);});if(!done)throw Error('Incomplete model stream');}
 citationUrl(citation){const doc=String(citation.docId||citation.documentId||'');if(!/^doc_[a-zA-Z0-9-]+$/.test(doc))throw Error('Invalid citation document');const query=new URLSearchParams({openCitation:'1',doc,page:String(Math.max(1,Number(citation.page)||1))});if(citation.itemId)query.set('item',citation.itemId);if(citation.ref)query.set('ref',citation.ref);if(Array.isArray(citation.bbox))query.set('bbox',citation.bbox.join(','));if(Array.isArray(citation.bboxNormalized))query.set('nbbox',citation.bboxNormalized.join(','));return this.base+'/?'+query;}
}
module.exports={SpecFlowKnowledgeClient};
