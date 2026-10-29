/* Twin Knowledge SDK v1. No 3D engine or framework dependency. */
(function (global) {
 'use strict';
 const protocol='twin-knowledge/v1';
 function origin(value){const u=new URL(value);if(!/^https?:$/.test(u.protocol)||u.username||u.password)throw Error('组件地址须为 HTTP(S) 且不包含凭据');return u.origin;}
 function serializable(value){const raw=JSON.stringify(value);if(!raw||raw.length>24000)throw Error('上下文过长');return JSON.parse(raw);}
 class Widget {
  constructor(options={}) {
   this.options=options;this.origin=origin(options.baseUrl||location.origin);this.channel=crypto.randomUUID();this.ready=false;this.context={};
   this.container=options.container||document.body;this.frame=document.createElement('iframe');
   const url=new URL('/plugin/widget.html',this.origin);url.searchParams.set('parentOrigin',location.origin);url.searchParams.set('channel',this.channel);
   this.frame.src=url.href;this.frame.title='知识与智能体组件';this.frame.setAttribute('allow','clipboard-write');
   Object.assign(this.frame.style,{position:options.container?'relative':'fixed',right:options.container?'auto':'24px',bottom:options.container?'auto':'86px',width:options.width||'440px',height:options.height||'min(720px, calc(100vh - 120px))',maxWidth:'calc(100vw - 32px)',border:'1px solid #32758a',borderRadius:'16px',boxShadow:'0 20px 80px #00121c66',zIndex:'2147483000',background:'#0c1f30',display:options.open?'block':'none'});
   this.button=document.createElement('button');this.button.type='button';this.button.textContent=options.label||'✦ 施工智能体';
   Object.assign(this.button.style,{position:options.container?'relative':'fixed',right:'24px',bottom:'24px',border:'1px solid #57cde5',borderRadius:'25px',padding:'13px 23px',color:'#d9f7ff',background:'linear-gradient(120deg,#0c3c59,#146d83)',font:'600 14px Microsoft YaHei,sans-serif',cursor:'pointer',zIndex:'2147483001',boxShadow:'0 8px 30px #001a3066'});
   this.button.onclick=()=>this.setOpen(this.frame.style.display==='none');
   this.receive=event=>{const m=event.data;if(event.source!==this.frame.contentWindow||event.origin!==this.origin||!m||m.protocol!==protocol||m.channel!==this.channel)return;if(m.type==='hello'){this.frame.contentWindow.postMessage({protocol,channel:this.channel,type:'host.init'},this.origin);}else if(m.type==='ready'){this.ready=true;this.setContext(this.context);options.onReady?.(m.payload);}else if(m.type==='focus.request'){const p=m.payload;if(p&&typeof p.objectId==='string'&&p.objectId.length<=160)options.onFocusRequest?.(serializable(p));}else if(m.type==='close.request')this.setOpen(false);else if(m.type==='error')options.onError?.(String(m.payload?.message||'组件连接失败'));};
   global.addEventListener('message',this.receive);this.container.append(this.frame,this.button);
  }
  setOpen(open){this.frame.style.display=open?'block':'none';this.button.setAttribute('aria-expanded',String(!!open));}
  setContext(context){this.context=serializable(context||{});if(this.ready)this.frame.contentWindow.postMessage({protocol,channel:this.channel,type:'context.set',payload:this.context},this.origin);}
  openSettings(){this.setOpen(true);if(this.ready)this.frame.contentWindow.postMessage({protocol,channel:this.channel,type:'settings.open'},this.origin);}
  destroy(){global.removeEventListener('message',this.receive);this.frame.remove();this.button.remove();this.ready=false;}
 }
 class Client {
  constructor({baseUrl=location.origin,token=''}={}){this.base=origin(baseUrl)+'/api/plugin/v1';this.token=token;}
  async request(path,{method='GET',body,signal,headers={}}={}){const response=await fetch(this.base+path,{method,signal,headers:{...(this.token?{Authorization:'Bearer '+this.token}:{}),...(body&&typeof body==='object'&&!(body instanceof Blob)?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:body instanceof Blob?body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw Error(value.error||'组件接口失败 '+response.status);return value;}
  manifest(){return this.request('/manifest');}
  search(query,signal){return this.request('/knowledge/search?'+new URLSearchParams(query),{signal});}
  upload(file,metadata={},signal){return this.request('/knowledge/documents?'+new URLSearchParams({...metadata,filename:file.name}),{method:'POST',body:file,headers:{'Content-Type':file.type||'application/octet-stream'},signal});}
  async stream(body,{signal,onEvent}={}){const response=await fetch(this.base+'/chat/stream',{method:'POST',signal,headers:{'Content-Type':'application/json',...(this.token?{Authorization:'Bearer '+this.token}:{})},body:JSON.stringify(body)});if(!response.ok){let data={};try{data=await response.json();}catch{}throw Error(data.error||'组件流式接口失败 '+response.status);}if(!/text\/event-stream/i.test(response.headers?.get('Content-Type')||''))throw Error('组件未返回流式响应');if(!response.body)throw Error('浏览器未提供流式读取能力');const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',terminal=false,total=0;try{while(true){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.byteLength;if(total>3*1024*1024)throw Error('流式内容过大');buffer+=decoder.decode(chunk.value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let i;while((i=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,i);buffer=buffer.slice(i+2);const raw=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');if(!raw)continue;const event=JSON.parse(raw);if(terminal)continue;if(event.type==='error')throw Error(event.error||'流式回答中断');if(event.type==='done')terminal=true;onEvent?.(event);}}if(!terminal)throw Error('流式连接提前结束，回答未完成');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
 }
 global.TwinKnowledge=Object.freeze({version:'1.0.0',protocol,mount:options=>new Widget(options),Client});
})(window);
