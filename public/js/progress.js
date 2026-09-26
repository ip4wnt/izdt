// Индикатор положения в книге на панели слева: процент пройденного пути по книге.
// Считается по самой книге (#book), а не по странице, поэтому одинаков в читалке и в редакторе.
export function initProgress(book){
  const el=document.getElementById('reading-progress'),value=el.querySelector('.progress-value');
  let queued=false,last=null;
  const update=()=>{
    queued=false;
    const rect=book.getBoundingClientRect();
    if(rect.height<=0)return;
    // 0 % — начало книги у верхнего края экрана, 100 % — её конец у нижнего края.
    const range=rect.height-innerHeight;
    const percent=range>0?Math.round(Math.min(1,Math.max(0,-rect.top/range))*100):100;
    if(percent===last)return;
    last=percent;value.textContent=String(percent);
    el.title=`Прочитано ${percent} % книги`;el.setAttribute('aria-label',`Положение в книге: ${percent} процентов`);
  };
  const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(update);}};
  addEventListener('scroll',schedule,{passive:true});addEventListener('resize',schedule);
  new ResizeObserver(schedule).observe(book);
  update();
  return {update:schedule};
}
