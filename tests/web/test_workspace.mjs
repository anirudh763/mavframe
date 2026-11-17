// Run against the locally deployed persistence build with MAVFRAME_BASE_URL.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {chromium, AXE_SOURCE} from './browser.mjs';
const base = process.env.MAVFRAME_BASE_URL || 'http://127.0.0.1:3003';
const out = new URL('../../artifacts/verification/canonical-persistence-20261116/', import.meta.url);
let browser;
before(async () => { mkdirSync(out, {recursive:true}); browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}); });
after(async () => browser?.close());
const waitParsed = (page, name) => page.waitForFunction(name => document.querySelector('#status').textContent === name+' loaded.' && !document.querySelector('#load-sample').disabled, name);

test('canonical routes, refresh, keyboard drawer, 200% text and axe at five widths', async () => {
  const page = await browser.newPage({serviceWorkers:'block'}); const errors=[]; page.on('pageerror', e=>errors.push(String(e)));
  const matrix=[];
  for (const width of [320,375,768,1024,1440]) for (const route of ['overview','workbench','reports','settings']) {
    await page.setViewportSize({width,height:1000});
    assert.equal((await page.goto(base+'/'+route)).status(),200);
    await page.getByRole('heading',{level:1,name:route,exact:false}).waitFor();
    await page.reload(); await page.getByRole('heading',{level:1,name:route,exact:false}).waitFor();
    await page.evaluate(AXE_SOURCE);
    const result=await page.evaluate(async()=>({violations:(await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa','best-practice']}})).violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1}));
    assert.deepEqual(result.violations,[],route+' '+width); assert.equal(result.overflow,false,route+' '+width);
    matrix.push({route,width,...result});
    if ([375,1440].includes(width)) {await page.screenshot({path:new URL(route+'-'+width+'.png',out).pathname,fullPage:true});writeFileSync(new URL(route+'-'+width+'-aria.txt',out),await page.locator('body').ariaSnapshot());}
  }
  await page.goto(base+'/'); await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
  await page.setViewportSize({width:375,height:900});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.locator('#menu-btn').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#sheet').getAttribute('aria-modal'),'true');
  for(let i=0;i<18;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('#sheet')),true);}
  await page.keyboard.press('Escape'); assert.equal(await page.evaluate(()=>document.activeElement.id),'menu-btn');
  await page.keyboard.press('Enter'); await page.locator('.canonical-nav a[href="/reports"]').focus(); await page.keyboard.press('Enter');
  await page.waitForURL('**/reports'); assert.equal(await page.evaluate(()=>document.activeElement.id),'h-reports');
  await page.goBack(); await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
  await page.setViewportSize({width:720,height:1000}); await page.goto(base+'/settings');await page.evaluate(()=>document.documentElement.style.fontSize='200%');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),true);
  assert.deepEqual(errors,[]); writeFileSync(new URL('canonical-matrix.json',out),JSON.stringify(matrix,null,2)); await page.close();
});

const xml='<mavlink><messages><message id="60000" name="SAVED_CUSTOM"><field type="uint16_t" name="count"/></message></messages></mavlink>';
const entry='<mavlink><include>extra.xml</include></mavlink>';
test('real custom XML artifacts save, download and restore through C/Wasm; logout rejects late hashes',async()=>{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}}); const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base+'/workbench');await page.locator('#load-sample').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#load-sample').disabled);
  await page.locator('#custom-dialect-panel').evaluate(el=>el.open=true);
  await page.locator('#custom-dialect-includes').setInputFiles({name:'extra.xml',mimeType:'application/xml',buffer:Buffer.from(xml)});
  await page.locator('#custom-dialect-file').setInputFiles({name:'selected.xml',mimeType:'application/xml',buffer:Buffer.from(entry)});
  await page.waitForFunction(()=>document.querySelector('#custom-dialect-status').textContent.startsWith('Loaded 1 custom'));
  const bytes=await page.evaluate(async xml=>{
    const {parseCustomDialectXml}=await import('/js/custom-dialect.js');const extra=parseCustomDialectXml(xml).messages[60000].crc_extra;
    const bytes=[253,2,0,0,1,1,1,0x60,0xea,0,0x34,0x12];let crc=0xffff;
    for(const value of [...bytes.slice(1),extra]){let tmp=(value^(crc&255))&255;tmp=(tmp^(tmp<<4))&255;crc=((crc>>8)^(tmp<<8)^(tmp<<3)^(tmp>>4))&0xffff;}
    return [...bytes,crc&255,crc>>8];
  },xml);
  await page.locator('#file').setInputFiles({name:'owned-custom.raw',mimeType:'application/octet-stream',buffer:Buffer.from(bytes)});await waitParsed(page,'owned-custom.raw');
  assert.match(await page.locator('#capture-result').textContent(),/SAVED_CUSTOM/);
  const panel=page.locator('#screen-capture server-workspace');await page.waitForFunction(()=>WorkspaceStore.state.session && !document.querySelector('#screen-capture server-workspace .server-workspace-actions button:nth-child(2)').disabled);await panel.getByRole('button',{name:'Save current run',exact:true}).click();await panel.locator('.server-save-status').filter({hasText:'Saved ·'}).waitFor();
  const session=await (await context.request.get(base+'/api/session')).json(); const runs=await (await context.request.get(base+'/api/runs?workspace_id='+session.workspace.id)).json();const saved=runs.items.find(run=>run.title==='owned-custom.raw');
  assert.equal(saved.payload.summary.valid_frames,1);assert.equal(saved.payload.custom_definitions,true);assert.equal(saved.artifact_ids.length,2);
  assert.deepEqual([...await (await context.request.get(base+'/api/artifacts/'+saved.artifact_ids[0])).body()],bytes);
  const artifact=await (await context.request.get(base+'/api/artifacts/'+saved.artifact_ids[1])).text();const sources=await page.evaluate(async text=>(await import('/js/dialect-artifact.js')).decodeDialectArtifact(text),artifact);assert.equal(sources.source,entry);assert.deepEqual(sources.includes,[['extra.xml',xml]]);
  // Force server rows to arrive before the app registers its restore adapter.
  let releaseAdapter; const adapterReady = new Promise(resolve=>releaseAdapter=resolve);
  await page.route('**/js/app.js', async route=>{await adapterReady;await route.continue();});
  await page.reload({waitUntil:'commit'});await page.waitForFunction(id=>window.WorkspaceStore?.state.runs.some(run=>run.id===id),saved.id);
  releaseAdapter();await page.waitForFunction(()=>!document.querySelector('#load-sample').disabled);await page.unroute('**/js/app.js');await page.locator('.canonical-nav a[href="/reports"]').click();
  await page.locator('.server-run').filter({has:page.getByRole('heading',{name:'owned-custom.raw',exact:true})}).getByRole('button',{name:'Open saved input',exact:true}).click();await page.waitForURL('**/workbench');await waitParsed(page,'owned-custom.raw');
  assert.match(await page.locator('#capture-result').textContent(),/SAVED_CUSTOM/);assert.match(await page.locator('#custom-dialect-name').textContent(),/selected.xml/);
  // Hold the actual digest so logout runs between parsing and report completion.
  await page.evaluate(()=>{const digest=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=(...args)=>new Promise((resolve,reject)=>window.releaseSavedDigest=()=>digest(...args).then(resolve,reject));});
  await page.locator('#file').setInputFiles({name:'late-private.raw',mimeType:'application/octet-stream',buffer:Buffer.from(bytes)});await page.waitForFunction(()=>typeof window.releaseSavedDigest==='function');
  await page.locator('.canonical-nav a[href="/settings"]').click();page.once('dialog',dialog=>dialog.accept());await page.locator('#screen-settings server-workspace').getByRole('button',{name:'Log out of server',exact:true}).click();await page.locator('#screen-settings .server-save-status').filter({hasText:'Logged out.'}).waitFor();
  await page.evaluate(()=>window.releaseSavedDigest());await page.waitForFunction(()=>document.querySelector('#status').textContent==='');
  assert.equal(await page.locator('#scenario-source').textContent(),'');assert.equal(await page.locator('#scenario-findings').textContent(),'');assert.equal(await page.locator('#share-preview').textContent(),'');assert.equal(await page.evaluate(()=>WorkspaceStore.state.current),null);
  await page.locator('.canonical-nav a[href="/workbench"]').click();assert.equal(await page.locator('#capture-result').isVisible(),false);assert.equal(await page.locator('#screen-capture server-workspace button').filter({hasText:'Save current run'}).isDisabled(),true);
  assert.deepEqual(errors,[]);await context.close();
});


test('custom-definition container preserves over64 includes and quote-heavy4MiB XML with shared bounds', async () => {
  const page = await browser.newPage({serviceWorkers:'block'});await page.goto(base+'/workbench');
  const result = await page.evaluate(async () => {
    const {encodeDialectArtifact,decodeDialectArtifact}=await import('/js/dialect-artifact.js');
    const {parseCustomDialectXml}=await import('/js/custom-dialect.js');
    const includes=Array.from({length:65},(_,i)=>['extra-'+i+'.xml', '<mavlink><messages><message id="'+(60100+i)+'" name="CUSTOM_'+i+'"><field type="uint8_t" name="value"/></message></messages></mavlink>']);
    const sources={entryName:'entry.xml',source:'<mavlink>'+includes.map(([name])=>'<include>'+name+'</include>').join('')+'</mavlink>',includes};
    const restored=decodeDialectArtifact(encodeDialectArtifact(sources));
    const dialect=parseCustomDialectXml(restored.source,undefined,{entryName:restored.entryName,sources:new Map(restored.includes)});
    const quoteXml='<mavlink><description>'+ '\"'.repeat(900000) +'</description><messages><message id="60000" name="QUOTE"><field type="uint8_t" name="value"/></message></messages></mavlink>';
    const quoteSources={entryName:'quote.xml',source:quoteXml,includes:Array.from({length:3},(_,i)=>['unused-'+i+'.xml',quoteXml])};
    const quoted=encodeDialectArtifact(quoteSources); const quoteRestored=decodeDialectArtifact(quoted);
    let oversized=false;try{encodeDialectArtifact({entryName:'large.xml',source:'x'.repeat(1048577),includes:[]});}catch{oversized=true;}
    return {includeCount:restored.includes.length,messages:dialect.messageCount,exact:JSON.stringify(restored)===JSON.stringify(sources),quotesExact:JSON.stringify(quoteRestored)===JSON.stringify(quoteSources),jsonQuoteBytes:new TextEncoder().encode(JSON.stringify(quoteSources)).length,oversized};
  });
  assert.equal(result.includeCount,65);assert.equal(result.messages,65);assert.equal(result.exact,true);assert.equal(result.quotesExact,true);assert.ok(result.jsonQuoteBytes>5*1024*1024);assert.equal(result.oversized,true);await page.close();
});

test('logout while a public capture download is pending cannot reload bytes or hidden reports', async()=>{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}}); const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  let release;const pending=new Promise(resolve=>release=resolve);let seen;const requested=new Promise(resolve=>seen=resolve);
  await page.route('**/sample/real-flight-redacted.tlog',async route=>{seen();await pending;await route.fulfill({status:200,contentType:'application/octet-stream',body:readFileSync(new URL('../../docs/sample/real-flight-redacted.tlog',import.meta.url))});});
  await page.goto(base+'/#/');await page.waitForFunction(()=>!document.querySelector('#load-sample').disabled);await page.locator('#hero-real-sample').click();await requested;
  await page.locator('.canonical-nav a[href="/settings"]').click();const panel=page.locator('#screen-settings server-workspace');await panel.getByRole('button',{name:'Log out of server',exact:true}).click();await panel.locator('.server-save-status').filter({hasText:'Logged out.'}).waitFor();release();
  await page.waitForFunction(()=>!document.querySelector('#hero-real-sample').disabled);
  const privateDOM=await page.evaluate(()=>({source:document.querySelector('#source').textContent,frames:document.querySelector('#m-frames').textContent,hex:document.querySelector('#hex').textContent,print:document.querySelector('#print-report-page').textContent,printMode:document.body.classList.contains('print-report-mode'),status:document.querySelector('#status').textContent}));
  assert.deepEqual(privateDOM,{source:'',frames:'–',hex:'',print:'',printMode:false,status:''});assert.deepEqual(errors,[]);await context.close();
});
