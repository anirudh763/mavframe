import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from './browser.mjs';
const base=process.env.MAVFRAME_BASE_URL||'http://127.0.0.1:3003';
const passphrase='Auxiliary fixture passphrase';
let browser;
before(async()=>browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}));
after(async()=>browser?.close());
async function open(){
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}}),page=await context.newPage();page.errors=[];page.on('pageerror',error=>page.errors.push(String(error)));
 await page.addInitScript(()=>{window.auxiliaryTasks=[];const add=EventTarget.prototype.addEventListener;EventTarget.prototype.addEventListener=function(type,listener,...options){if(type==='click'&&['backup-preview','backup-export','backup-restore','backup-merge'].includes(this.id)&&typeof listener==='function'){const callback=listener;listener=function(...args){const pending=callback.apply(this,args);if(pending?.then)auxiliaryTasks.push(pending);return pending;};}return add.call(this,type,listener,...options);};});
 await page.goto(base+'/workbench');await page.waitForFunction(()=>!document.querySelector('#file').disabled&&window.WorkspaceStore?.state.session);
 const backup=await page.evaluate(async passphrase=>{const service=await import('/js/local-profile.js');await service.signup('auxiliary-fixture@example.test',passphrase);await service.saveWorkspace('Retained auxiliary fixture',{screen:'frames'},'light');const backup=await service.createEncryptedBackup(passphrase);location.hash='#/profile';return backup;},passphrase);
 await page.locator('#screen-profile').waitFor();return {context,page,backup};
}
async function storedHash(page){return page.evaluate(async()=>{const value=JSON.stringify(Object.keys(localStorage).filter(key=>/^mavframe_(profiles|profile_|workspace_|preferences_)/.test(key)).sort().map(key=>[key,localStorage.getItem(key)]));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');});}
async function serverLogout(page){if(await page.locator('#screen-profile').isVisible())await page.locator('#screen-profile > a').click();await page.locator('.canonical-nav a[href="/settings"]').click();page.once('dialog',dialog=>dialog.accept());await page.locator('#screen-settings server-workspace').getByRole('button',{name:'Log out of server',exact:true}).click();await page.locator('#screen-settings .server-save-status').filter({hasText:'Logged out.'}).waitFor();}
const profile=async page=>{await page.evaluate(()=>location.hash='#/profile');await page.locator('#screen-profile').waitFor();};
async function holdCrypto(page,method){await page.evaluate(method=>{const original=crypto.subtle[method].bind(crypto.subtle);crypto.subtle[method]=async(...args)=>{const result=await original(...args);return new Promise(resolve=>window.releaseAuxiliaryCrypto=()=>resolve(result));};},method);}
async function selectBackup(page,backup){await page.locator('#backup-passphrase').fill(passphrase);await page.locator('#backup-file').setInputFiles({name:'auxiliary-backup.json',mimeType:'application/json',buffer:Buffer.from(backup)});}

test('server logout clears private auxiliary forms, prepared links and decrypted stages without deleting profiles',async()=>{
 const {context,page,backup}=await open();const before=await storedHash(page);const stage=await page.evaluate(async({backup,passphrase})=>(await import('/js/local-profile.js')).previewEncryptedBackup(backup,passphrase),{backup,passphrase});
 await selectBackup(page,backup);await page.locator('#backup-preview').click();await page.locator('#backup-preview-box').waitFor();
 await page.evaluate(()=>{for(const id of ['sync-project','sync-anon-key','sync-email','sync-password','team-email','team-use','feedback-description','feedback-steps','auth-email','auth-password'])document.getElementById(id).value='private fixture';document.getElementById('sync-consent').checked=true;document.getElementById('feedback-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 await serverLogout(page);
 const values=await page.evaluate(()=>Object.fromEntries(['backup-passphrase','backup-file','sync-project','sync-anon-key','sync-email','sync-password','team-email','team-use','feedback-description','feedback-steps','auth-email','auth-password'].map(id=>[id,document.getElementById(id).value])));
 for(const[id,value]of Object.entries(values))assert.equal(value,'',id);
 assert.equal(await page.locator('#backup-preview-text').textContent(),'');assert.equal(await page.locator('#sync-collections').textContent(),'');assert.equal(await page.locator('#feedback-destination').getAttribute('href'),'#');assert.equal(await page.locator('#sync-consent').isChecked(),false);
 const stale=await page.evaluate(async stageId=>{try{await(await import('/js/local-profile.js')).commitEncryptedBackup(stageId,'merge');return false;}catch{return true;}},stage.stageId);assert.equal(stale,true);assert.equal(await storedHash(page),before);assert.deepEqual(page.errors,[]);await context.close();
});

test('a held backup file read cannot decrypt or publish its preview after server logout',async()=>{
 const {context,page,backup}=await open();const before=await storedHash(page);await selectBackup(page,backup);
 await page.evaluate(()=>{const text=File.prototype.text;File.prototype.text=function(){return new Promise((resolve,reject)=>window.releaseBackupRead=()=>text.call(this).then(resolve,reject));};});
 await page.locator('#backup-preview').click();await page.waitForFunction(()=>!!window.releaseBackupRead);await serverLogout(page);await page.evaluate(async()=>{releaseBackupRead();await Promise.allSettled(auxiliaryTasks);});
 await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(await page.locator('#backup-preview-text').textContent(),'');assert.equal(await page.locator('#backup-status').textContent(),'');assert.equal(await storedHash(page),before);assert.deepEqual(page.errors,[]);await context.close();
});

for(const method of ['decrypt','encrypt'])test('a held backup '+method+' cannot stage or download after server logout',async()=>{
 const {context,page,backup}=await open();const before=await storedHash(page),downloads=[];page.on('download',file=>downloads.push(file));await holdCrypto(page,method);
 await selectBackup(page,backup);await page.locator(method==='decrypt'?'#backup-preview':'#backup-export').click();await page.waitForFunction(()=>!!window.releaseAuxiliaryCrypto);await serverLogout(page);await page.evaluate(async()=>{releaseAuxiliaryCrypto();await Promise.allSettled(auxiliaryTasks);});await page.evaluate(()=>new Promise(requestAnimationFrame));
 assert.equal(downloads.length,0);assert.equal(await page.locator('#backup-preview-text').textContent(),'');assert.equal(await page.locator('#backup-status').textContent(),'');assert.equal(await page.locator('#backup-error').textContent(),'');assert.equal(await storedHash(page),before);assert.deepEqual(page.errors,[]);await context.close();
});

async function cloudFixture(page,remote=false){
 await page.route('**/cloud-*/**',async route=>{const url=new URL(route.request().url()),id='11111111-1111-4111-8111-111111111111';let value;
  if(url.pathname.includes('/auth/'))value={access_token:'controlled-test-token',user:{id}};
  else if(remote&&url.searchParams.get('collection')==='eq.saved_views')value=[{owner_id:id,collection:'saved_views',revision:1,payload:[{name:'Remote auxiliary fixture',savedAt:'2026-11-16',theme:'light',context:{screen:'capture'}}]}];
  else value=[];await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
 });
}
async function connect(page,name){await page.locator('#sync-project').fill(base+'/cloud-'+name);await page.locator('#sync-anon-key').fill('public-test-key');await page.locator('#sync-email').fill('cloud-fixture@example.test');await page.locator('#sync-password').fill('controlled cloud password');await page.locator('#sync-consent').check();await page.locator('#sync-connect').click();}

test('a late rejected cloud connection cannot disconnect a new provider or refill cleared errors',async()=>{
 const {context,page}=await open();await cloudFixture(page);await page.evaluate(()=>{const fetchOriginal=fetch;window.fetch=async(...args)=>{const response=await fetchOriginal(...args);if(String(args[0]).includes('/cloud-old/auth/')){const original=response.body.getReader.bind(response.body);response.body.getReader=()=>{const reader=original();let first=true;return{read:async()=>{const value=await reader.read();if(!first)return value;first=false;return new Promise((resolve,reject)=>window.rejectOldCloud=()=>reject(Error('controlled old cloud error')));},cancel:()=>reader.cancel(),releaseLock:()=>reader.releaseLock()};};}return response;};});
 await connect(page,'old');await page.waitForFunction(()=>!!window.rejectOldCloud);await serverLogout(page);await profile(page);await connect(page,'new');await page.waitForFunction(()=>document.querySelector('#sync-status').textContent.startsWith('Connected'));
 await page.evaluate(()=>rejectOldCloud());await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(await page.locator('#sync-error').isVisible(),false);await page.locator('#sync-now').click();await page.waitForFunction(()=>document.querySelector('#sync-status').textContent==='Sync check finished. Pending local changes are labeled and are not reported as uploaded.');assert.equal(await page.locator('#sync-error').isVisible(),false);assert.deepEqual(page.errors,[]);await context.close();
});

test('queued cloud settings cannot modify retained local profiles after server logout',async()=>{
 const {context,page}=await open();const before=await storedHash(page);await cloudFixture(page,true);await connect(page,'remote');await page.waitForFunction(()=>document.querySelector('#sync-status').textContent.startsWith('Connected'));await page.locator('#sync-now').click();await page.getByRole('button',{name:'Use cloud version',exact:true}).waitFor();
 await page.evaluate(()=>{const original=navigator.locks.request.bind(navigator.locks);navigator.locks.request=(name,options,work)=>name.includes(':workspace:')?new Promise((resolve,reject)=>window.releaseCloudLock=()=>Promise.resolve().then(work).then(resolve,reject)):original(name,options,work);});
 await page.getByRole('button',{name:'Use cloud version',exact:true}).click();await page.waitForFunction(()=>!!window.releaseCloudLock);await serverLogout(page);await page.evaluate(()=>releaseCloudLock().catch(()=>{}));assert.equal(await storedHash(page),before);assert.equal(await page.locator('#sync-collections').textContent(),'');assert.equal(await page.locator('#sync-status').textContent(),'');assert.deepEqual(page.errors,[]);await context.close();
});

for(const operation of ['report','print','share'])test('pending '+operation+' output cannot publish after server logout',async()=>{
 const {context,page}=await open();await page.locator('#screen-profile > a').click();await page.locator('#load-sample').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='sample-flight.tlog loaded.'&&!document.querySelector('#file').disabled);
 const downloads=[];page.on('download',file=>downloads.push(file));await page.evaluate(()=>{window.printCalls=0;window.print=()=>printCalls++;const digest=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=(...args)=>new Promise((resolve,reject)=>window.releaseReportHash=()=>digest(...args).then(resolve,reject));});
 await page.locator(operation==='report'?'[data-capture-export=json]':operation==='print'?'#print-report':'#share-report').click();await page.waitForFunction(()=>!!window.releaseReportHash);await serverLogout(page);await page.evaluate(()=>releaseReportHash());await page.evaluate(()=>new Promise(requestAnimationFrame));
 assert.equal(downloads.length,0);assert.equal(await page.evaluate(()=>printCalls),0);assert.equal(await page.locator('#share-dialog').isVisible(),false);assert.equal(await page.locator('#print-report-page').textContent(),'');assert.equal(await page.locator('#capture-export-status').textContent(),'');assert.deepEqual(page.errors,[]);await context.close();
});
