const paths={
  home:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  receipt:'M6 3h12v18l-3-2-3 2-3-2-3 2ZM9 7h6M9 11h6M9 15h3',
  wallet:'M3 6h16v14H3ZM3 6V4h14v2M15 11h6v5h-6ZM17 13h1',
  more:'M5 5h4v4H5ZM15 5h4v4h-4ZM5 15h4v4H5ZM15 15h4v4h-4Z',
  chart:'M4 20V4M4 20h16M8 16v-5M13 16V7M18 16v-8',
  project:'M3 7h7l2-3h9v16H3Z',
  people:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  plus:'M12 5v14M5 12h14',
  refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 2M4 17l2 2a7 7 0 0 0 12-2',
};
export function icon(name) {return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.more}"/></svg>`;}
export const moduleIcons={dashboard:'home',expenses:'receipt',advances:'wallet',finance:'chart',projects:'project',clients:'people',personnel:'people'};
export const moduleCopy={
  dashboard:['Tu operación, al día','Revisa tus pendientes y continúa con lo importante.'],
  expenses:['Rendiciones','Tus comprobantes, revisiones y sustentos en un solo lugar.'],
  advances:['Anticipos','Solicita fondos y sigue el estado de tu rendición.'],
  finance:['Presupuesto y liquidación','Compara el presupuesto, el gasto y los saldos de cada proyecto.'],
  projects:['Proyectos','Organiza responsables, clientes y conceptos de cada evento.'],
};
let navigate,create,menuOpen=false,lastFocus;
const $=s=>document.querySelector(s);
const mobile=()=>matchMedia('(max-width: 850px)').matches;
export function closeMenu() {
  const wasOpen=menuOpen;menuOpen=false;document.body.classList.remove('nav-open');
  $('#menuToggle').setAttribute('aria-expanded','false');$('#sidebar').inert=mobile();
  $('#sidebar').removeAttribute('role');$('#sidebar').removeAttribute('aria-modal');
  $('#appMain').inert=false;$('#mobileNav').inert=false;
  if(wasOpen && lastFocus?.isConnected)lastFocus.focus();
}
function openMenu() {
  if(!mobile())return;
  lastFocus=document.activeElement;menuOpen=true;document.body.classList.add('nav-open');
  $('#sidebar').inert=false;$('#sidebar').setAttribute('role','dialog');$('#sidebar').setAttribute('aria-modal','true');
  $('#appMain').inert=true;$('#mobileNav').inert=true;
  $('#menuToggle').setAttribute('aria-expanded','true');$('#closeMenu').focus();
}
export function initializeUi({onNavigate,onCreate}) {
  navigate=onNavigate;create=onCreate;
  $('#menuToggle').innerHTML=icon('more')+'<span>Menú</span>';
  $('#refreshBtn').innerHTML=icon('refresh')+'<span>Actualizar</span>';
  $('#menuToggle').addEventListener('click',()=>menuOpen?closeMenu():openMenu());
  $('#closeMenu').addEventListener('click',closeMenu);$('#navBackdrop').addEventListener('click',closeMenu);
  matchMedia('(max-width: 850px)').addEventListener('change',closeMenu);
  document.addEventListener('keydown',event=>{
    if(!menuOpen)return;
    if(event.key==='Escape'){event.preventDefault();closeMenu();}
    if(event.key==='Tab') {
      const focusable=[...$('#sidebar').querySelectorAll('button,a[href]')].filter(el=>el.getClientRects().length && !el.disabled);
      const first=focusable[0],last=focusable.at(-1);
      if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
    }
  });
  const observer=new MutationObserver(()=>decorateTables());
  observer.observe(document.body,{subtree:true,childList:true});
  closeMenu();
}
export function renderMobileNavigation(user,module) {
  const names={dashboard:'Inicio',expenses:'Rendiciones',advances:'Anticipos'};
  const allowed=new Set(user.modules || []);
  $('#mobileNav').innerHTML=['dashboard','expenses','advances'].filter(key=>allowed.has(key)).map(key=>`<button type="button" data-go="${key}" ${module===key?'aria-current="page"':''}>${icon(moduleIcons[key])}<span>${names[key]}</span></button>`).join('')+`<button type="button" data-more ${!['dashboard','expenses','advances'].includes(module)?'aria-current="page"':''}>${icon('more')}<span>Más</span></button>`;
  $('#mobileNav').querySelectorAll('[data-go]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.go)));
  $('#mobileNav [data-more]').addEventListener('click',openMenu);
  $('#quickActions').classList.toggle('hidden',module!=='dashboard');
  $('#quickActions').innerHTML=[['expenses','receipt','Registrar gasto','Sube tu comprobante'],['advances','wallet','Solicitar anticipo','Prepara tu próximo evento']].filter(([key])=>allowed.has(key)).map(([key,type,title,copy])=>`<button type="button" data-create="${key}"><span class="quick-icon">${icon(type)}</span><span><strong>${title}</strong><small>${copy}</small></span><span class="quick-arrow" aria-hidden="true">↗</span></button>`).join('');
  $('#quickActions').querySelectorAll('[data-create]').forEach(button=>button.addEventListener('click',()=>create(button.dataset.create)));
}
const priorities={
  dashboard:[0,1,3,4,5,7],expenses:[0,3,5,7,9],advances:[1,3,4,6,8],projects:[0,1,2,9,13],
};
export function decorateTables() {
  document.querySelectorAll('.field').forEach(field=>{
    const label=field.querySelector('label'),control=field.querySelector('input,select,textarea');
    if(label && control && !label.htmlFor && control.name) {
      if(!control.id)control.id='field-'+(control.form?.id || 'input')+'-'+control.name;
      label.htmlFor=control.id;
    }
  });
  document.querySelectorAll('table').forEach(table=>{
    const labels=[...table.querySelectorAll('thead th')].map(th=>th.textContent.trim());
    if(!labels.length)return;
    table.querySelectorAll('tbody tr').forEach(row=>{
      const cells=[...row.children].filter(td=>td.tagName==='TD' && !td.classList.contains('mobile-details-control'));
      if(cells.length!==labels.length)return;
      const core=table.id==='recordsTable',keep=priorities[table.dataset.module];
      cells.forEach((cell,i)=>{cell.dataset.label=labels[i];cell.classList.toggle('mobile-secondary',Boolean(core&&keep&&!keep.includes(i)));});
      cells.forEach((cell,i)=>{
        if(labels[i]==='Acciones')cell.classList.add('actions');
        if(!cell.classList.contains('actions') && !cell.querySelector(':scope > .cell-value')) {
          const content=document.createElement('div');content.className='cell-value';
          while(cell.firstChild)content.append(cell.firstChild);
          cell.append(content);
        }
      });
      if(core&&keep&&!row.querySelector('.mobile-details-control')) {
        const cell=document.createElement('td');cell.className='mobile-details-control';cell.colSpan=labels.length;
        const button=document.createElement('button');button.type='button';button.className='details-toggle';button.textContent='Ver más datos';button.setAttribute('aria-expanded','false');
        button.addEventListener('click',()=>{const expanded=row.classList.toggle('mobile-expanded');button.setAttribute('aria-expanded',String(expanded));button.textContent=expanded?'Ver menos datos':'Ver más datos';});
        cell.append(button);row.append(cell);
      }
    });
  });
}
