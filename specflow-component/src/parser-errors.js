'use strict';
function parserErrorSummary(error){
 const text=String(error?.message||error||'解析失败');
 if(/ENOSPC|No space left|磁盘空间不足/i.test(text))return '磁盘空间不足。请释放资料盘和系统盘空间后继续重试。';
 if(/ENAMETOOLONG|WinError 206|filename.*too long|路径.*过长/i.test(text))return '解析工作路径过长。请升级后继续重试，或将交付包放在较短目录。';
 if(/EACCES|EPERM|PermissionError|WinError 5|拒绝访问/i.test(text))return '无法写入解析文件。请检查文件夹权限及安全软件拦截后继续重试。';
 if(error?.code==='PARSER_STALLED'||error?.code==='PARSER_CLEANUP_FAILED')return text;
 const lines=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split(/[\r\n]+/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('SPECFLOW_PROGRESS')&&!/\d+%.*\|/.test(s));
 return (lines.findLast(s=>/\b(?:\w*Error|\w*Exception):/.test(s))||lines.at(-1)||'解析未能完成，请查看完整错误后继续重试。').slice(0,400);
}
module.exports={parserErrorSummary};
