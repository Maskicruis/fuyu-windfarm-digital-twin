'use strict';
const LIMITS=Object.freeze({quietMs:5*60*1000,stalledMs:15*60*1000,checkEveryMs:5000});
const CSI=/\x1b\[[0-?]*[ -/]*[@-~]/g;
class ParserActivity {
 constructor(now=Date.now()){this.startedAt=now;this.lastOutputAt=now;this.lastAdvanceAt=now;this.completed=0;this.total=0;this.phase='启动离线解析引擎';this.currentStart=0;this.currentEnd=0;this.checkpointPages=0;}
 consume(text,now=Date.now()){
  if(!text.trim())return;
  this.lastOutputAt=now;
  for(const line of text.replace(CSI,'').split(/[\r\n]+/)){
   let m;
   if((m=line.match(/SPECFLOW_PROGRESS (\{.*\})/))){
    try{const e=JSON.parse(m[1]);if(e.total>0)this.total=e.total;
     if(['pages','checkpoint','resume','finalizing'].includes(e.event))this.advance(e.completed,now);
     if(e.event==='checkpoint'||e.event==='resume')this.checkpointPages=e.completed;
     if(e.event==='resume')this.phase='从检查点继续';
     if(e.event==='finalizing')this.phase='整理全文与生成原文坐标';
     if(e.event==='checkpoint-warning')this.checkpointWarning=String(e.message).slice(0,300);
    }catch{}
   }
   if((m=line.match(/total_pages=(\d+)/)))this.total=Number(m[1]);
   if((m=line.match(/Pipeline processing window batch (\d+)\/(\d+): (\d+)\/(\d+) pages, batch_pages=(\d+)/))){
    this.total=Number(m[4]);this.currentEnd=Number(m[3]);this.currentStart=this.currentEnd-Number(m[5])+1;this.advance(this.currentStart-1,now);this.phase='处理页面';
   }
   if((m=line.match(/Processing pages:.*?\|\s*(\d+)\/(\d+)/))){this.total=Number(m[2]);this.advance(Number(m[1]),now);}
   const phases=[['Layout Predict','版面识别'],['OCR-det','检测文字区域'],['OCR-rec Predict','识别正文文字'],['Table orientation','判断表格方向'],['Table structure','识别表格结构'],['Table Predict','识别表格'],['Seal Predict','识别印章']];
   for(const [key,label] of phases)if(line.includes(key)){this.phase=label;const percentage=line.match(/(\d{1,3})%/);this.phasePercent=percentage?Math.min(100,Number(percentage[1])):null;}
  }
 }
 advance(pages,now){if(Number.isFinite(pages)&&pages>this.completed){this.completed=pages;this.lastAdvanceAt=now;}}
 snapshot(now=Date.now()){return {startedAt:this.startedAt,lastOutputAt:this.lastOutputAt,lastAdvanceAt:this.lastAdvanceAt,completed:this.completed,total:this.total,currentStart:this.currentStart,currentEnd:this.currentEnd,phase:this.phase,phasePercent:this.phasePercent??null,checkpointPages:this.checkpointPages,checkpointWarning:this.checkpointWarning||'',elapsedSeconds:Math.floor((now-this.startedAt)/1000),quietSeconds:Math.floor((now-this.lastOutputAt)/1000)};}
 timeout(now=Date.now(),limits=LIMITS){if(now-this.lastOutputAt>=limits.quietMs)return '解析引擎连续 '+Math.round(limits.quietMs/60000)+' 分钟没有输出';if(now-this.lastAdvanceAt>=limits.stalledMs)return '连续 '+Math.round(limits.stalledMs/60000)+' 分钟没有完成新的页面';return '';}
}
module.exports={ParserActivity,LIMITS};
