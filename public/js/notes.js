import {api,notify,applyAssetURLs} from './api.js';
export function initNotes(state,book,panels){
  const button=document.getElementById('selection-note');
  let fragments=[];
  document.addEventListener('pointerup',event=>{
    if(state.editing||button.contains(event.target)||!book.contains(event.target))return;
    setTimeout(()=>{
      const selection=getSelection();if(!selection.rangeCount||selection.isCollapsed){button.hidden=true;return;}
      const range=selection.getRangeAt(0);
      if(!book.contains(range.commonAncestorContainer)){button.hidden=true;return;}
      fragments=[];
      for(const block of book.querySelectorAll('p,h1,h2,h3,li,blockquote')){
        if(!range.intersectsNode(block)||block.querySelector('p,li,blockquote'))continue;
        const part=range.cloneRange();
        const blockRange=document.createRange();blockRange.selectNodeContents(block);
        if(part.compareBoundaryPoints(Range.START_TO_START,blockRange)<0)part.setStart(block,0);
        if(part.compareBoundaryPoints(Range.END_TO_END,blockRange)>0)part.setEnd(block,block.childNodes.length);
        const quote=part.toString();if(!quote.trim())continue;
        const before=document.createRange();before.selectNodeContents(block);before.setEnd(part.startContainer,part.startOffset);
        fragments.push({blockId:block.id,start:before.toString().length,quote,revision:state.revision});
      }
      if(!fragments.length){button.hidden=true;return;}
      const rect=range.getBoundingClientRect();button.hidden=false;
      button.style.left=`${Math.max(80,Math.min(innerWidth-190,rect.left+rect.width/2-65))}px`;
      button.style.top=`${Math.max(8,Math.min(innerHeight-60,rect.top-52))}px`;
    },0);
  });
  button.onpointerdown=e=>e.preventDefault();
  button.onclick=async()=>{
    button.disabled=true;
    try{
      let result;
      for(const fragment of fragments)result=await api('notes',{method:'POST',data:fragment});
      if(result){state.notes=result.notes;book.innerHTML=result.content;applyAssetURLs(book);panels.render();getSelection().removeAllRanges();notify('Цитата сохранена в заметках.');}
      button.hidden=true;
    }catch(e){notify(e.message,12000);}
    finally{button.disabled=false;}
  };
  document.addEventListener('pointerdown',e=>{if(!button.contains(e.target))button.hidden=true;});
  window.addEventListener('scroll',()=>button.hidden=true,{passive:true});
}
