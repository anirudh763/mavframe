import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from './browser.mjs';
const base=process.env.MAVFRAME_BASE_URL || 'http://127.0.0.1:3003';
const sample=readFileSync(new URL('../../docs/sample/scenario-heartbeat.tlog',import.meta.url));
let browser;
before(async()=>{browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});});
after(async()=>browser?.close());
async function open(){const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});const page=await context.newPage();page.errors=[];page.on('pageerror',error=>page.errors.push(String(error)));await page.goto(base+'/workbench');await page.waitForFunction(()=>!document.querySelector('#load-sample').disabled);await page.waitForFunction(()=>!!WorkspaceStore.state.session);return {context,page};}
const upload=(page,name)=>page.locator('#file').setInputFiles({name,mimeType:'application/octet-stream',buffer:sample});
async function holdHashes(page){await page.evaluate(()=>{const digest=crypto.subtle.digest.bind(crypto.subtle);window.heldHashes=[];crypto.subtle.digest=(...args)=>new Promise((resolve,reject)=>heldHashes.push(()=>digest(...args).then(resolve,reject)));});}
async function logout(page){await page.locator('.canonical-nav a[href="/settings"]').click();page.once('dialog',dialog=>dialog.accept());await page.locator('#screen-settings server-workspace').getByRole('button',{name:'Log out of server',exact:true}).click();await page.locator('#screen-settings .server-save-status').filter({hasText:'Logged out.'}).waitFor();await page.locator('.canonical-nav a[href="/workbench"]').click();}
const parsed=(page,name)=>page.waitForFunction(name=>document.querySelector('#status').textContent===name+' loaded.'&&!document.querySelector('#file').disabled,name);

test('Cancel releases a held hash; its late completion cannot unlock or replace a newer parse',async()=>{
 const {context,page}=await open();await holdHashes(page);await upload(page,'old-hash.tlog');await page.waitForFunction(()=>heldHashes.length===1);await page.locator('#cancel').click();
 assert.equal(await page.locator('#file').isDisabled(),false,'Cancel releases the current operation without waiting for the digest');
 await upload(page,'new-hash.tlog');await page.waitForFunction(()=>heldHashes.length===2);await page.evaluate(()=>heldHashes[0]());
 await page.waitForFunction(()=>heldHashes.length===2);assert.equal(await page.locator('#file').isDisabled(),true);assert.match(await page.locator('#status').textContent(),/^Parsing new-hash.tlog/);
 await page.evaluate(()=>heldHashes[1]());await parsed(page,'new-hash.tlog');assert.match(await page.locator('#source').textContent(),/^new-hash.tlog/);assert.deepEqual(page.errors,[]);await context.close();
});

for(const outcome of ['resolve','reject'])test('old file read '+outcome+' after logout cannot clear a new parse or reveal its old filename',async()=>{
 const {context,page}=await open();await page.evaluate(()=>{const read=File.prototype.arrayBuffer;File.prototype.arrayBuffer=function(){if(this.name!=='old-reader.tlog')return read.call(this);return new Promise((resolve,reject)=>{window.releaseOldRead=()=>read.call(this).then(resolve,reject);window.rejectOldRead=()=>reject(Error('controlled read rejection'));});};});
 await upload(page,'old-reader.tlog');await page.waitForFunction(()=>!!window.releaseOldRead);await logout(page);await holdHashes(page);await upload(page,'new-reader.tlog');await page.waitForFunction(()=>heldHashes.length===1);
 await page.evaluate(outcome=>outcome==='resolve'?releaseOldRead():rejectOldRead(),outcome);await page.evaluate(()=>new Promise(requestAnimationFrame));
 assert.equal(await page.locator('#file').isDisabled(),true);assert.match(await page.locator('#status').textContent(),/^Parsing new-reader.tlog/);
 await page.evaluate(()=>heldHashes[0]());await parsed(page,'new-reader.tlog');assert.match(await page.locator('#source').textContent(),/^new-reader.tlog/);assert.deepEqual(page.errors,[]);await context.close();
});

test('old sample response after logout cannot mark a newer parse idle',async()=>{
 const {context,page}=await open();let release,seen;const pending=new Promise(resolve=>release=resolve),requested=new Promise(resolve=>seen=resolve);
 await page.route('**/sample/sample-flight.tlog',async route=>{seen();await pending;await route.fulfill({status:200,contentType:'application/octet-stream',body:sample});});
 await page.locator('#load-sample').click();await requested;await logout(page);await holdHashes(page);await upload(page,'new-sample-owner.tlog');await page.waitForFunction(()=>heldHashes.length===1);release();
 await page.waitForResponse('**/sample/sample-flight.tlog');assert.equal(await page.locator('#file').isDisabled(),true);assert.match(await page.locator('#status').textContent(),/^Parsing new-sample-owner.tlog/);
 await page.evaluate(()=>heldHashes[0]());await parsed(page,'new-sample-owner.tlog');assert.deepEqual(page.errors,[]);await context.close();
});

test('legacy browser logout directly clears hidden canonical capture labels',async()=>{
 const {context,page}=await open();await upload(page,'private-legacy-label.tlog');await parsed(page,'private-legacy-label.tlog');await page.locator('.canonical-nav a[href="/reports"]').click();await page.locator('.canonical-nav a[href="/overview"]').click();
 assert.match(await page.locator('#reports-current').textContent(),/private-legacy-label/);assert.match(await page.locator('#overview-empty').textContent(),/private-legacy-label/);
 await page.evaluate(()=>{location.hash='#/capture';});await page.locator('#account-menu > summary').click();page.once('dialog',dialog=>dialog.accept());await page.locator('#logout-button').click();await page.locator('#screen-landing').waitFor();
 assert.equal(await page.locator('#reports-current').textContent(),'Load a capture in Workbench to export a report.');assert.equal(await page.locator('#overview-empty').textContent(),'No capture loaded.');assert.deepEqual(page.errors,[]);await context.close();
});

test('canceling a real large capture yields safely to a new synthetic sample',async()=>{
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>{const NativeChannel=MessageChannel;window.MessageChannel=class extends NativeChannel{constructor(){super();const post=this.port2.postMessage.bind(this.port2);this.port2.postMessage=(...args)=>{if(window.holdLargeChunk&&document.querySelector('#progress')?.value>0)window.releaseLargeChunk=()=>post(...args);else post(...args);};}};});
 await page.goto(base+'/workbench');await page.waitForFunction(()=>!document.querySelector('#file').disabled);await upload(page,'before-large.tlog');await parsed(page,'before-large.tlog');const previous=await page.locator('#source').textContent();
 const capture=readFileSync(new URL('../../docs/sample/sample-flight.tlog',import.meta.url));await page.evaluate(()=>window.holdLargeChunk=true);await page.locator('#file').setInputFiles({name:'large-cancel.tlog',mimeType:'application/octet-stream',buffer:Buffer.concat(Array(400).fill(capture))});await page.waitForFunction(()=>!!window.releaseLargeChunk);
 await page.locator('#cancel').click();assert.equal(await page.locator('#source').textContent(),previous);assert.equal(await page.locator('#file').isDisabled(),false);
 await page.evaluate(()=>window.holdLargeChunk=false);await page.locator('#load-sample').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Parsing sample-flight.tlog'));await page.evaluate(()=>releaseLargeChunk());await parsed(page,'sample-flight.tlog');assert.match(await page.locator('#source').textContent(),/^sample-flight.tlog/);assert.match(await page.locator('#m-frames').textContent(),/^1,497/);assert.deepEqual(errors,[]);await context.close();
});

test('canceling a held custom-dialect recheck restores definitions before the next parse',async()=>{
 const {context,page}=await open();await upload(page,'before-dialect.tlog');await parsed(page,'before-dialect.tlog');await holdHashes(page);await page.locator('#custom-dialect-panel').evaluate(element=>element.open=true);
 const xml='<mavlink><messages><message id="60000" name="CANCELED_DIALECT"><field type="uint8_t" name="value"/></message></messages></mavlink>';
 await page.locator('#custom-dialect-file').setInputFiles({name:'canceled.xml',mimeType:'application/xml',buffer:Buffer.from(xml)});await page.waitForFunction(()=>heldHashes.length===1);await page.locator('#cancel').click();
 assert.equal(await page.locator('#clear-custom-dialect').isDisabled(),true);assert.match(await page.locator('#custom-dialect-name').textContent(),/No custom dialect/);
 await upload(page,'after-dialect.tlog');await page.waitForFunction(()=>heldHashes.length===2);await page.evaluate(()=>heldHashes[0]());assert.equal(await page.locator('#file').isDisabled(),true);await page.evaluate(()=>heldHashes[1]());await parsed(page,'after-dialect.tlog');
 await page.waitForFunction(()=>WorkspaceStore.state.current?.title==='after-dialect.tlog');assert.equal(await page.evaluate(()=>WorkspaceStore.state.current.payload.custom_definitions),false);assert.deepEqual(page.errors,[]);await context.close();
});
