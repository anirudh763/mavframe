/* Same-origin persistence UI. Copied into each app; browser-only hosts make no API calls. */
(() => {
  if (typeof window === 'undefined') return;
  const enabled = !!document.querySelector('meta[name="server-persistence"][content="enabled"]');
  const state = {enabled, session:null, workspace:null, workspaces:[], runs:[], snapshots:[], current:null, status:enabled?'Connecting…':'Server storage is unavailable on this host.', dirty:false, busy:false};
  const listeners = new Set();
  let bridge = {}, starting = null, currentKey = '', saving = false, generation = 0;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('server-workspace:'+location.origin) : null;
  const emit = () => listeners.forEach(fn=>fn(state));
  const note = text => {state.status=text;emit();};
  function installSession(session){
    const previous=state.session;
    const sameOwner=previous?.principal_id&&previous.principal_id===session.principal_id;
    const migrated=previous?.role==='guest'&&previous.principal_id&&session.migrated_from===previous.principal_id;
    if(previous&&previous.csrf_token!==session.csrf_token&&!sameOwner&&!migrated){state.current=null;state.runs=[];state.snapshots=[];state.workspaces=[];state.dirty=false;currentKey='';bridge.onLogout?.();}
    state.session=session;state.workspace=session.workspace;
  }
  async function api(path, options={}) {
    if (!enabled) throw Error('Server storage is unavailable on this host. Keep a local export.');
    const headers = {...options.headers};
    if (options.body !== undefined && !(options.body instanceof Blob)) {headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);}
    if (options.method && options.method!=='GET') headers['X-CSRF-Token']=state.session?.csrf_token||'';
    let response;
    try {response=await fetch('/api/'+path,{signal:AbortSignal.timeout(30000),...options,headers,credentials:'same-origin',cache:'no-store'});}
    catch {throw Error('Server unavailable. Your current input is retained; retry when connected.');}
    let value;try{value=await response.json();}catch{throw Error('The server returned an unreadable response. Retry without clearing your work.');}
    if (!response.ok) {const error=Error(value.error?.message||value.error||'Request failed; retry.');error.status=response.status;throw error;}
    return value;
  }
  async function refresh() {
    if (!state.session || !state.workspace) return;
    const ticket=generation,session=state.session,workspaceId=state.workspace.id;
    const [workspaces,runs,snapshots]=await Promise.all([
      api('workspaces?limit=50'),api('runs?workspace_id='+encodeURIComponent(workspaceId)+'&limit=50'),api('sync?workspace_id='+encodeURIComponent(workspaceId)+'&limit=50')
    ]);
    if(ticket!==generation||session!==state.session||workspaceId!==state.workspace?.id)return;
    state.workspaces=workspaces.items;state.runs=runs.items;state.snapshots=snapshots.items;
    state.workspace=workspaces.items.find(w=>w.id===state.workspace.id)||state.workspace;
    emit();
  }
  async function init(create=true) {
    if (!enabled) {emit();return;}
    if (starting) return starting;
    const ticket=++generation;
    starting=(async()=>{
      try {
        const session=await api(create?'session/guest':'session',create?{method:'POST',body:{}}:{});
        if(ticket!==generation)return;
        installSession(session);
        let remembered;try{remembered=sessionStorage.getItem('server-workspace-id');}catch{/* Optional per-tab selection; the server session remains authoritative. */}
        if(remembered){try{const workspace=await api('workspaces/'+encodeURIComponent(remembered));if(ticket!==generation)return;state.workspace=workspace;}catch(error){if(ticket!==generation)return;if(error.status!==404)throw error;try{sessionStorage.removeItem('server-workspace-id');}catch{}}}
        state.status='Connected · '+(session.role==='account'?'account':'guest workspace');await refresh();
      }catch(error){if(ticket===generation){state.status=error.message;emit();}}
    })().finally(()=>{starting=null;});
    return starting;
  }
  async function save() {
    if (saving) return;
    const current=bridge.readCurrent?.()||state.current;
    const artifacts=bridge.readArtifacts?.()||[];
    if (!current) {note('Run a check or enter a record in Workbench before saving.');return;}
    if (!state.session) {const expected=generation+(starting?0:1);await init();if(generation!==expected)return;}
    if (!state.workspace) return;
    saving=state.busy=true;state.dirty=true;note('Saving…');
    const ownerTicket=state.session.csrf_token;
    const ticket=generation;
    const workspaceId=state.workspace.id;
    const isCurrent=()=>ticket===generation&&ownerTicket===state.session?.csrf_token&&workspaceId===state.workspace?.id;
    const saveKey=JSON.stringify(current);
    try {
      const text=JSON.stringify({...current,workspace_id:workspaceId});
      if(new TextEncoder().encode(text).length>65536)throw Error('The record exceeds 64 KiB. Export the source locally and save a smaller summary.');
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join('');
      if(!isCurrent())return;
      const record=JSON.parse(text);
      const artifact_ids=[];
      for(const [index,item]of artifacts.entries()){
        if(item.blob.size>32*1024*1024)throw Error('The source exceeds the 32 MiB server limit. Keep a local source export.');
        const artifact=await api('artifacts?workspace_id='+encodeURIComponent(workspaceId)+'&name='+encodeURIComponent(item.name),{method:'POST',body:item.blob,headers:{'Content-Type':'application/octet-stream','Idempotency-Key':digest+'-artifact-'+index}});if(!isCurrent())return;artifact_ids.push(artifact.id);
      }
      const run=await api('runs',{method:'POST',body:{...record,artifact_ids},headers:{'Idempotency-Key':digest}});
      if(!isCurrent())return;
      const latest=bridge.readCurrent?.()||state.current;
      state.dirty=!!latest&&JSON.stringify(latest)!==saveKey;state.status=state.dirty?'Saved previous run. New changes are unsynced.':'Saved · '+run.title;await refresh();channel?.postMessage('records');
      return run;
    }catch(error){if(isCurrent())state.status=(error.status===409?'Conflict. ':'Unsynced changes. ')+error.message;}
    finally{saving=false;if(ticket===generation){state.busy=false;emit();}}
  }
  async function select(id) {
    if(state.dirty&&!confirm('Switch workspace while keeping your current unsaved input in this tab?'))return;
    const ticket=generation;const session=await api('session/workspace',{method:'POST',body:{workspace_id:id}});if(ticket!==generation)return;
    installSession(session);try{sessionStorage.setItem('server-workspace-id',id);}catch{}await refresh();note('Workspace selected. Current input remains in this tab.');
  }
  async function snapshot() {
    if(!state.workspace)return;
    const ticket=generation,workspaceId=state.workspace.id;
    state.busy=true;note('Creating snapshot…');
    try{await refresh();if(ticket!==generation||workspaceId!==state.workspace?.id)return;const snapshot=await api('sync',{method:'POST',body:{workspace_id:workspaceId,expected_revision:state.workspace.revision}});if(ticket!==generation)return;await refresh();note(snapshot.status==='completed'?'Snapshot created.':'Snapshot needs attention.');}
    catch(error){if(ticket===generation)note((error.status===409?'Conflict. ':'Retry required. ')+error.message);}
    finally{if(ticket===generation){state.busy=false;emit();}}
  }
  async function restore(snapshot) {
    if(!confirm('Restore this snapshot into a new workspace? Current workspaces and input will be kept.'))return;
    const ticket=generation;state.busy=true;note('Restoring snapshot…');
    try{const result=await api('sync/'+snapshot.id+'/restore',{method:'POST',body:{sha256:snapshot.sha256,schema_version:1}});if(ticket!==generation)return;await select(result.workspace.id);if(ticket===generation)note('Snapshot restored into a new workspace.');}
    catch(error){if(ticket===generation)note('Restore failed. '+error.message);}
    finally{if(ticket===generation){state.busy=false;emit();}}
  }
  async function authenticate(mode,username,password) {
    if(state.busy)return false;
    const ticket=++generation;
    state.busy=true;note(mode==='signup'?'Creating account…':'Signing in…');
    try{const session=await api('session/'+mode,{method:'POST',body:{username,password}});if(ticket!==generation)return false;installSession(session);try{sessionStorage.removeItem('server-workspace-id');}catch{}await refresh();note('Signed in. Authorized guest work was retained.');channel?.postMessage('session');return true;}
    catch(error){if(ticket===generation)note(error.message);return false;}
    finally{if(ticket===generation){state.busy=false;emit();}}
  }
  function clearSession(message){generation++;state.session=state.workspace=state.current=null;state.runs=[];state.snapshots=[];state.workspaces=[];state.dirty=state.busy=false;currentKey='';try{sessionStorage.removeItem('server-workspace-id');}catch{}bridge.onLogout?.();note(message);}
  async function logout() {
    if(state.dirty&&!confirm('Log out? Download or save your unsynced work first.'))return;
    const ticket=++generation;
    try{await api('session/logout',{method:'POST',body:{}});if(ticket!==generation)return;clearSession('Logged out. This session is revoked.');channel?.postMessage('logout');}
    catch(error){note(error.message);}
  }
  async function exportRun(run,format) {
    const ticket=generation;try{const record=await api('exports',{method:'POST',body:{run_id:run.id,format}});if(ticket!==generation)return;const blob=new Blob([record.content],{type:format==='json'?'application/json':format==='csv'?'text/csv':'text/markdown'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='run-'+run.id+'.'+(format==='markdown'?'md':format);link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);note('Export saved from persisted run.');}
    catch(error){if(ticket===generation)note('Export failed. '+error.message);}
  }
  async function openRun(run) {
    if(state.dirty&&!confirm('Replace your unsaved input with this saved run? Save or download changes first.'))return;
    const ticket=generation,workspaceId=state.workspace?.id;
    const isCurrent=()=>ticket===generation&&workspaceId===state.workspace?.id;
    try {
      const saved=await api('runs/'+encodeURIComponent(run.id));
      if(!isCurrent())return;
      const files=[];
      for(const id of saved.artifact_ids||[]){
        const response=await fetch('/api/artifacts/'+encodeURIComponent(id),{signal:AbortSignal.timeout(30000),credentials:'same-origin',cache:'no-store'});
        if(!isCurrent())return;
        if(!response.ok)throw Error('The saved source is unavailable. Keep the stored report and retry.');
        const blob=await response.blob();
        if(!isCurrent())return;
        files.push(blob);
      }
      if(!isCurrent())return;
      await bridge.restore?.(saved,files,isCurrent);
      if(isCurrent())note('Saved input opened. Re-run the domain check before relying on a new result.');
    }catch(error){if(isCurrent())note('Open failed. '+error.message);}
  }
  channel?.addEventListener('message',async({data})=>{
    if(data==='logout'){clearSession('Logged out in another tab. Current session is revoked.');}
    else if(data==='session')await init(false);
    else if(data==='records'&&state.session)try{await refresh();}catch(error){note(error.message);}
  });
  window.addEventListener('online',()=>{if(state.dirty)note('Unsynced changes. Reconnected; choose Save current run to upload.');});
  const store=window.WorkspaceStore={state,init,api,refresh,save,select,snapshot,restore,authenticate,logout,exportRun,
    register(adapter){bridge=adapter;emit();},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    capture(current,{autosave=false}={}){const key=JSON.stringify(current);state.current=current;state.dirty=!!current;if(key!==currentKey){currentKey=key;note(current?'Unsynced changes.':'No current record.');if(autosave&&enabled)save();}},
    markDirty(){if(state.current){state.dirty=true;note('Unsynced changes.');}},
  };
  function node(tag,text,attrs={}){const element=document.createElement(tag);if(text!==null)element.textContent=text;for(const[key,value]of Object.entries(attrs))element.setAttribute(key,value);return element;}
  function button(text,action){const item=node('button',text,{type:'button',class:'button btn secondary'});item.addEventListener('click',()=>Promise.resolve(action()).catch(error=>note(error.message)));return item;}
  class ServerWorkspace extends HTMLElement {
    connectedCallback(){
      if(this.built)return;this.built=true;this.classList.add('server-workspace');
      this.heading=node('h2',this.getAttribute('view')==='reports'?'Saved runs':this.getAttribute('view')==='overview'?'Workspace status':'Server workspace');
      this.status=node('p','',{role:'status','aria-live':'polite','aria-atomic':'true',class:'server-save-status'});
      this.append(this.heading,this.status);this.controls=node('div',null,{class:'server-workspace-actions'});this.append(this.controls);
      this.retry=button('Connect guest workspace',()=>init());this.controls.append(this.retry);
      this.saveButton=button('Save current run',save);this.controls.append(this.saveButton);
      this.snapshotButton=button('Create snapshot',snapshot);this.controls.append(this.snapshotButton);
      this.logOut=button('Log out of server',logout);this.controls.append(this.logOut);
      this.select=node('select',null,{'aria-label':'Server workspace'});this.select.addEventListener('change',()=>select(this.select.value).catch(error=>note(error.message)));this.controls.append(this.select);
      this.summary=node('p','');this.append(this.summary);this.list=node('div',null,{class:'server-runs'});this.append(this.list);
      if(this.getAttribute('view')==='settings')this.buildSettings();
      this.unsubscribe=store.subscribe(()=>this.update());this.update();if(enabled&&!state.session)init();
    }
    disconnectedCallback(){this.unsubscribe?.();this.unsubscribe=null;this.built=false;this.optionKey=this.runKey=this.snapshotKey=null;this.replaceChildren();}
    buildSettings(){
      const hint=node('p','Snapshots stay on this server’s persistent volume. Download an export before relying on a single device.');this.append(hint);
      this.auth=node('details',null);this.auth.append(node('summary','Account on this server'));
      const form=node('form',null);this.auth.append(form);
      const user=node('input',null,{name:'username',type:'email',autocomplete:'username',required:'',maxlength:'100'});const userLabel=node('label','Email');userLabel.append(user);
      const password=node('input',null,{name:'password',type:'password',autocomplete:'current-password',required:'',minlength:'12',maxlength:'128'});const passLabel=node('label','Password');passLabel.append(password);
      const mode=node('select',null,{'aria-label':'Account action'});mode.append(node('option','Sign in',{value:'login'}),node('option','Create account',{value:'signup'}));mode.onchange=()=>password.autocomplete=mode.value==='signup'?'new-password':'current-password';
      const submit=node('button','Continue',{type:'submit',class:'button btn primary'});form.append(userLabel,passLabel,mode,submit,node('p','This is an account on this server. No external identity verification or email recovery is configured.'));
      form.addEventListener('submit',async event=>{event.preventDefault();if(await authenticate(mode.value,user.value,password.value))password.value='';});this.append(this.auth);
      this.snapshots=node('div',null,{class:'server-snapshots'});this.append(node('h3','Snapshots'),this.snapshots);
    }
    update(){
      const workbench=this.getAttribute('view')==='workbench';this.heading.hidden=workbench;this.summary.hidden=workbench;
      if(this.status.textContent!==state.status)this.status.textContent=state.status;this.saveButton.disabled=!enabled||state.busy||!state.session||!(state.current||bridge.readCurrent?.());this.snapshotButton.disabled=!state.workspace||state.busy;
      this.logOut.hidden=!state.session;this.retry.hidden=!!state.session||!enabled;this.select.hidden=!state.workspace||workbench;this.controls.hidden=!enabled;
      this.select.disabled=state.busy;
      this.saveButton.hidden=this.getAttribute('view')==='overview';this.snapshotButton.hidden=this.getAttribute('view')!=='settings';this.logOut.hidden=!state.session||this.getAttribute('view')!=='settings';
      const options=state.workspaces.map(w=>[w.id,w.name||w.title]);if(JSON.stringify(options)!==this.optionKey){this.optionKey=JSON.stringify(options);this.select.replaceChildren(...options.map(([id,name])=>node('option',name,{value:id})));}if(state.workspace)this.select.value=state.workspace.id;
      this.summary.textContent=state.session?`${state.session.role==='account'?'Account':'Guest'} · ${state.workspace?.name||state.workspace?.title||'Workspace'} · ${state.runs.length} saved runs shown`:'Your browser drafts are retained. Connect a guest workspace to save on this server.';
      if(this.auth){this.auth.hidden=!state.session?.auth_enabled||state.session.role==='account';if(this.auth.hidden)this.auth.querySelector('[name=password]').value='';}
      if(this.getAttribute('view')==='reports'){
        const key=JSON.stringify([state.runs,!!bridge.restore]);if(key!==this.runKey){this.runKey=key;this.list.replaceChildren();if(!state.runs.length)this.list.append(node('p','No saved runs in this workspace.'));
          for(const run of state.runs){const section=node('section',null,{class:'server-run'});section.append(node('h3',run.title),node('p',run.kind+' · '+run.source+' · '+new Date(run.created_at).toLocaleString()));
            const actions=node('div',null,{class:'server-workspace-actions'});for(const format of ['json','markdown','csv'])actions.append(button('Download '+format.toUpperCase(),()=>exportRun(run,format)));
            for(const [index,id]of (run.artifact_ids||[]).entries())actions.append(node('a','Download source artifact '+(index+1),{href:'/api/artifacts/'+encodeURIComponent(id),class:'button btn secondary'}));
            if(bridge.restore)actions.append(button('Open saved input',()=>openRun(run)));section.append(actions);
            const detail=node('details',null);detail.append(node('summary','Stored evidence'),node('pre',JSON.stringify(run.payload,null,2)));section.append(detail);this.list.append(section);}
        }
      }
      if(this.snapshots){const key=JSON.stringify(state.snapshots);if(key!==this.snapshotKey){this.snapshotKey=key;this.snapshots.replaceChildren();if(!state.snapshots.length)this.snapshots.append(node('p','No snapshots yet.'));for(const item of state.snapshots){const row=node('div',null,{class:'server-snapshot'});row.append(node('p',item.status+' · '+new Date(item.created_at).toLocaleString()));if(item.status==='completed')row.append(button('Restore as new workspace',()=>restore(item)));this.snapshots.append(row);}}}
    }
  }
  customElements.define('server-workspace',ServerWorkspace);
})();
