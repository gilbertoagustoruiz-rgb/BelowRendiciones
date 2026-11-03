export async function initializePwa({notify,onReconnect}) {
  const $=s=>document.querySelector(s);
  let installPrompt,registration,reloading=false;
  const standalone=()=>matchMedia('(display-mode: standalone)').matches || navigator.standalone===true;
  const updateConnection=()=>{
    $('#connectionBanner').classList.toggle('hidden',navigator.onLine);
    document.body.classList.toggle('is-offline',!navigator.onLine);
  };
  updateConnection();
  window.addEventListener('offline',updateConnection);
  window.addEventListener('online',()=>{updateConnection();onReconnect();});
  const updateInstall=()=>$('#installApp').classList.toggle('hidden',standalone());
  updateInstall();matchMedia('(display-mode: standalone)').addEventListener('change',updateInstall);
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;});
  window.addEventListener('appinstalled',()=>{installPrompt=null;updateInstall();$('#installHelp').close();notify('Below ya está instalada en tu dispositivo.');});
  $('#closeInstallHelp').addEventListener('click',()=>$('#installHelp').close());
  $('#installApp').addEventListener('click',async()=>{
    if(installPrompt) {
      const prompt=installPrompt;installPrompt=null;
      try {await prompt.prompt();await prompt.userChoice;}
      catch {$('#installHelp').showModal();}
    } else $('#installHelp').showModal();
  });
  $('#updateApp').addEventListener('click',()=>{
    if(document.querySelector('dialog[open]')) {notify('Cierra o guarda el formulario antes de actualizar la app.');return;}
    reloading=true;
    if(registration?.waiting)registration.waiting.postMessage({type:'ACTIVATE_UPDATE'});
    else location.reload();
  });
  if(!('serviceWorker' in navigator) || !window.isSecureContext)return;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(reloading)location.reload();
  });
  try {
    registration=await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});
    const showUpdate=()=>{if(registration.waiting && navigator.serviceWorker.controller)$('#updateBanner').classList.remove('hidden');};
    showUpdate();
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;
      worker?.addEventListener('statechange',()=>{if(worker.state==='installed')showUpdate();});
    });
  } catch(error) {console.warn('La instalación PWA no está disponible:',error.message);}
}
