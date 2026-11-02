'use strict';
// Standalone page numbers are layout metadata, never anchors for following text.
function classifyLine(text,box){
 if(!Array.isArray(box)||box.length<4)return 'text';
 const [left,top,right]=box;
 return /^[\s—–-]*\d{1,4}[\s—–-]*$/.test(String(text))&&top>.88&&left>.35&&right<.65&&right-left<.12?'page_number':'text';
}
module.exports={classifyLine};
