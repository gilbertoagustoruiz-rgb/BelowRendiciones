import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function worker() {
  const listeners={},assets=[],deleted=[],responses=new Map();let claimed=false,skipped=false;
  const caches={
    async open(){return {async addAll(paths){assets.push(...paths);for(const path of paths)responses.set(path,new Response(path));}};},
    async match(path){return responses.get(path);},
    async keys(){return ['below-static-old','below-static-v1.8.0-mobile1','below-static-v1.9.0','below-static-v1.10.0','below-static-v1.11.0','unrelated-cache'];},
    async delete(key){deleted.push(key);},
  };
  vm.runInNewContext(await readFile('public/sw.js','utf8'),{URL,caches,fetch:async()=>{throw new Error('Offline');},self:{
    location:{origin:'https://below.example'},addEventListener(type,fn){listeners[type]=fn;},
    clients:{async claim(){claimed=true;}},skipWaiting(){skipped=true;},
  }});
  async function send(type,extra={}) {
    let waited,response;
    listeners[type]({...extra,waitUntil(value){waited=value;},respondWith(value){response=value;}});
    await waited;return response ? await response : undefined;
  }
  return {assets,deleted,send,claimed:()=>claimed,skipped:()=>skipped};
}
test('manifest e iconos permiten instalación y todos los recursos públicos existen',async()=>{
  const manifest=JSON.parse(await readFile('public/manifest.webmanifest','utf8'));
  assert.equal(manifest.display,'standalone');assert.equal(manifest.scope,'/');assert.equal(manifest.id,'/');
  for(const size of [192,512]) {
    const icon=manifest.icons.find(icon=>icon.sizes===`${size}x${size}`);assert(icon);
    const bytes=await readFile('public'+icon.src);assert.equal(bytes.subarray(1,4).toString(),'PNG');
    assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
  }
  const sw=await worker();await sw.send('install');
  for(const asset of sw.assets){assert(!asset.startsWith('/api/'));assert((await readFile('public'+asset)).length>0);}
  assert.equal(sw.skipped(),false);
});
test('la PWA excluye API, documentos, operaciones y orígenes externos de su caché',async()=>{
  const sw=await worker();await sw.send('install');
  for(const path of ['/api/auth/me','/api/workflow/dashboard','/api/expenses/1/file','/api/workflow/movement-files/1','/api/finance/projects/1/report.pdf','/api/finance/projects/1/report.xlsx','/uploads/evidencia.pdf','/unknown']) {
    assert.equal(await sw.send('fetch',{request:{url:'https://below.example'+path,method:'GET',mode:'navigate'}}),undefined);
  }
  assert.equal(await sw.send('fetch',{request:{url:'https://below.example/api/expenses',method:'POST'}}),undefined);
  assert.equal(await sw.send('fetch',{request:{url:'https://other.example/app.js',method:'GET'}}),undefined);
});
test('abre la interfaz sin red y conserva la versión de sus recursos hasta aceptar actualización',async()=>{
  const sw=await worker();await sw.send('install');
  const navigation=await sw.send('fetch',{request:{url:'https://below.example/?view=expenses',method:'GET',mode:'navigate'}});
  assert.equal(await navigation.text(),'/index.html');
  const script=await sw.send('fetch',{request:{url:'https://below.example/app.js',method:'GET',mode:'cors'}});
  assert.equal(await script.text(),'/app.js');
  await sw.send('message',{data:{type:'UNKNOWN'}});assert.equal(sw.skipped(),false);
  await sw.send('message',{data:{type:'ACTIVATE_UPDATE'}});assert.equal(sw.skipped(),true);
});
test('actualizar elimina únicamente versiones anteriores de la caché pública de Below',async()=>{
  const sw=await worker();await sw.send('activate');
  assert.deepEqual(sw.deleted,['below-static-old','below-static-v1.8.0-mobile1','below-static-v1.9.0','below-static-v1.10.0']);assert.equal(sw.claimed(),true);
});
