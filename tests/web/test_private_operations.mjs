import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

class MemoryStorage extends Map {
  getItem(key) { return this.has(key) ? this.get(key) : null; }
  setItem(key,value) { this.set(key,String(value)); }
  removeItem(key) { this.delete(key); }
}
let sequence=0;
const profileURL=process.env.PROFILE_MODULE ? pathToFileURL(process.env.PROFILE_MODULE) : new URL('../../docs/js/local-profile.js',import.meta.url);
async function fresh() {
  globalThis.window={localStorage:new MemoryStorage(),sessionStorage:new MemoryStorage()};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name,options,work)=>work()}}});
  return import(profileURL.href+'?private-test='+(++sequence));
}
const passphrase='Private operation test passphrase';
const persisted=()=>JSON.stringify([...window.localStorage]);
async function fixture() {
  const service=await fresh();await service.signup('private-fixture@example.test',passphrase);await service.saveWorkspace('Retained fixture view',{screen:'frames',check:'crc'},'dark');
  return {service,backup:await service.createEncryptedBackup(passphrase)};
}

test('logout revokes a decrypted stage so a stale stage cannot create a local profile',async()=>{
  const {backup}=await fixture();const service=await fresh();const stage=await service.previewEncryptedBackup(backup,passphrase);service.logout();const before=persisted();
  await assert.rejects(service.commitEncryptedBackup(stage.stageId,'restore'),/expired|session changed/);assert.equal(persisted(),before);
});

test('private invalidation clears stages while preserving stored profiles and the local session',async()=>{
  const {service,backup}=await fixture();const stage=await service.previewEncryptedBackup(backup,passphrase);const before=persisted(),session=JSON.stringify(service.getSession());
  service.invalidatePrivateOperations();await assert.rejects(service.commitEncryptedBackup(stage.stageId,'merge'),/expired|session changed/);
  assert.equal(persisted(),before);assert.equal(JSON.stringify(service.getSession()),session);assert.equal(service.loadWorkspace()[0].name,'Retained fixture view');
});

for(const action of ['decrypt','encrypt'])test('invalidation rejects a held '+action+' without returning backup data or staging work',async()=>{
  const {service:source,backup}=await fixture();const service=action==='decrypt'?await fresh():source;
  const original=crypto.subtle[action].bind(crypto.subtle);let seen,release;const started=new Promise(resolve=>seen=resolve);
  crypto.subtle[action]=async(...args)=>{const result=await original(...args);seen();return new Promise(resolve=>release=()=>resolve(result));};
  let pending;
  try {
    pending=action==='decrypt'?service.previewEncryptedBackup(backup,passphrase):service.createEncryptedBackup(passphrase);
    await started;const before=persisted();service.invalidatePrivateOperations();release();await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(persisted(),before);
  } finally {crypto.subtle[action]=original;release?.();await pending?.catch(()=>{});}
});

test('invalidation stops a staged restore queued behind the profile lock without changing saved bytes',async()=>{
  const {backup}=await fixture();const service=await fresh();const stage=await service.previewEncryptedBackup(backup,passphrase);let release;
  navigator.locks.request=(name,options,work)=>name.includes('profile-index')?new Promise((resolve,reject)=>release=()=>Promise.resolve().then(work).then(resolve,reject)):work();
  const pending=service.commitEncryptedBackup(stage.stageId,'restore'),before=persisted();service.invalidatePrivateOperations();release();
  await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(persisted(),before);
});

test('a native share rejected after invalidation never falls back to the clipboard',async()=>{
  const source=process.env.PWA_MODULE ? pathToFileURL(process.env.PWA_MODULE) : new URL('../../docs/js/pwa.js',import.meta.url);
  const {shareTextOrFile}=await import(source.href);let rejectShare,copies=0,current=true;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{share:()=>new Promise((resolve,reject)=>rejectShare=reject),clipboard:{writeText:async()=>copies++}}});
  const pending=shareTextOrFile({title:'Fixture',text:'Private fixture',isCurrent:()=>current});current=false;rejectShare(Error('controlled share rejection'));
  assert.equal((await pending).method,'cancelled');assert.equal(copies,0);
});
