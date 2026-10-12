import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, save, result, run } from './common.mjs';
import { snapshot, compare } from './workspace.mjs';
import { validatePayload, images } from './payload.mjs';
import { GitHub, collect, definition } from './github.mjs';
import { preflight, metadataPlan } from './preflight.mjs';
import { record } from './record.mjs';
import { refresh } from './refresh.mjs';
import { recoverCreate } from './recover-create.mjs';
import { verifyRecording, reconcileImages } from './verify-recording.mjs';
import { main } from './add-issue.mjs';

const target = { host: 'github.com', repo: 'owner/repo' };
const rootUrl = 'https://github.com/owner/repo';
const perm = { confirmed: true, evidence: 'Verified account capability', credentialEvidence: 'Verified credential scope without exposing token' };
const nativeUrl = id => `https://github.com/user-attachments/assets/00000000-0000-0000-0000-${String(id).padStart(12,'0')}`;
function git(repo, ...args) { const r = spawnSync('git', ['-C',repo,...args], { encoding:'utf8' }); assert.equal(r.status,0,r.stderr); return r.stdout; }
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'add-issue-test-')), repo = join(dir,'repo'); mkdirSync(repo);
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  git(repo,'init','--quiet'); git(repo,'config','user.email','test@example.invalid'); git(repo,'config','user.name','Test');
  writeFileSync(join(repo,'source.txt'),'initial'); git(repo,'add','source.txt'); git(repo,'commit','--quiet','-m','initial');
  const base = snapshot(repo);
  const c = { id:'candidate', classification:'Task', readiness:'ready', revision:base.head, evidence:'Source evidence at investigated revision', environment:'local',
    authorization:{kind:'human',origin:'current chat',request:'Record this task',context:'Direct human invocation'},
    restrictions:{draftOnly:false,diagnosisOnly:false,noRepair:false,noImplementation:true,noCodeChanges:true},
    workspace:{original:base,baseline:base,cleanupVerified:true},logs:'Not applicable to repository-supported task',runtime:'Not applicable',
    action:'new issue', issueUrl:null, title:'area: maintain behavior', body:'Exact approved body\nwith literal `$(echo secret)`.', comment:'',
    allowedActions:['new issue'], duplicate:{query:'scope-term',limit:20,complete:true,issues:[],evidence:'No matching outcome'},
    metadata:[],omissions:[],recordPermission:perm,images:[],noApprovedImages:true };
  const payload = {version:1,runId:'run',target,account:'tester',candidates:[c]};
  const context = {mode:'default',trustedAuthorization:true,recordingAuthorized:true,evidence:'Trusted current session',recordPermission:perm,permissions:{}};
  return {dir,repo,c,payload,context,statePath:join(dir,'private','ledger.json')};
}
class FakeGh {
  constructor() { this.issues = new Map(); this.next=1; this.calls=[]; this.nextComment=1; this.comments=[]; this.values=[]; this.labels=[{id:10,name:'maintenance',description:'Maintenance'}]; this.attach=true; this.type=true; this.pr={number:5,html_url:`${rootUrl}/pull/5`,head:{sha:'a'.repeat(40)},merged:true}; this.thread={isResolved:false,pullRequest:{url:this.pr.html_url,headRefOid:this.pr.head.sha,merged:true}}; }
  addIssue(body='existing',title='Existing') { const n=this.next++; const x={html_url:`${rootUrl}/issues/${n}`,number:n,node_id:`I_${n}`,title,body,state:'open',created_at:new Date().toISOString(),user:{login:'tester'},labels:[],assignees:[],milestone:null}; this.issues.set(n,x); return x; }
  transport = (program,args,options={}) => {
    assert.equal(program,'gh'); this.calls.push({args:[...args],input:options.input});
    const ok = x => ({ok:true,stdout:typeof x === 'string'?x:JSON.stringify(x)});
    const failure = (status) => ({ok:false,stdout:'',stderr:status ? `HTTP ${status}` : ''});
    if (this.unavailable?.(args)) return failure(403);
    if (args[0]==='issue' && args.includes('--help')) return ok(`Help\n${this.attach?'      --attach file\n':''}${this.type?'      --type name\n':''}`);
    if (args[0]==='issue') {
      const text = readFileSync(args[args.indexOf('--body-file')+1],'utf8');
      const attached=[]; for (let i=0;i<args.length;i++) if (args[i]==='--attach') attached.push(args[++i]);
      const lines=attached.filter((_,i)=>!this.partial || i===0).map((path,i)=>`![${path.split('#')[1]}](${nativeUrl(i+1)})`).join('\n');
      const body=text+(lines?'\n\n'+lines:''); let url;
      if (args[1]==='create') {
        const x=this.addIssue(body,args[args.indexOf('--title')+1]);
        for(let i=0;i<args.length;i++) if(args[i]==='--label') x.labels.push({name:args[++i]});
        url=x.html_url;
      } else { const n=Number(args[2]); const id=this.nextComment++; url=`${rootUrl}/issues/${n}#issuecomment-${id}`; this.comments.push({id,html_url:url,body,user:{login:'tester'}}); }
      if(this.loseNext){this.loseNext=false;return failure();} return {ok:!this.partial,stdout:url};
    }
    const method=args[args.indexOf('--method')+1], endpoint=args[args.indexOf('--method')+2];
    const body=options.input?JSON.parse(options.input):undefined;
    if(endpoint==='graphql') return ok({data:{node:this.thread}});
    if(endpoint==='user') return ok({login:this.account??'tester'});
    if(endpoint==='repos/owner/repo') return ok({full_name:'owner/repo',html_url:rootUrl,archived:false,has_issues:true,permissions:{push:true}});
    if(endpoint.startsWith('search/issues')) return ok({incomplete_results:false,total_count:this.search?.length??this.issues.size,items:this.search??[...this.issues.values()]});
    if(endpoint.startsWith('repos/owner/repo/issues?state=all') && method==='GET') return ok(this.recoveryInventory ?? [...this.issues.values()]);
    if(endpoint==='repos/owner/repo/issues' && method==='POST') {
      const x=this.addIssue(body.body,body.title); x.labels=(body.labels??[]).map(name=>({name})); x.assignees=(body.assignees??[]).map(login=>({login})); if(body.type)x.type={name:body.type};
      if(this.loseNext){this.loseNext=false;return failure();} return ok(x);
    }
    if(endpoint==='repos/owner/repo/issue-types') return ok([{id:1,name:'Task',enabled:true}]);
    if(endpoint.startsWith('repos/owner/repo/labels')) {
      const name=decodeURIComponent(endpoint.split('/')[4]??'').split('?')[0]; return name?ok(this.labels.find(x=>x.name===name)):ok(this.labels);
    }
    if(endpoint==='orgs/owner/issue-fields') return ok([{id:1,name:'Priority',data_type:'single_select',options:[{id:1,name:'High'}]},{id:2,name:'Other',data_type:'text'}]);
    if(endpoint==='repos/owner/repo/pulls/5') return ok(this.pr);
    const match=endpoint.match(/^repos\/owner\/repo\/issues\/(\d+)(.*)$/);
    if(match) {
      const x=this.issues.get(Number(match[1])); if(!x)return failure(404);
      const suffix=match[2];
      if(!suffix && method==='GET')return ok(x);
      if(!suffix && method==='PATCH'){if(body.type)x.type={name:body.type}; if(body.milestone)x.milestone={number:body.milestone};return ok(x);}
      if(suffix.startsWith('/comments'))return ok(this.comments.filter(a=>a.html_url.startsWith(x.html_url+'#')));
      if(suffix==='/labels' && method==='POST'){for(const name of body.labels)x.labels.push({name});if(this.loseMetadata){this.loseMetadata=false;return failure();}return ok(x.labels);}
      if(suffix==='/assignees' && method==='POST'){for(const login of body.assignees)x.assignees.push({login});return ok(x.assignees);}
      if(suffix.startsWith('/issue-field-values')) {
        if(method==='POST') { for(const item of body.issue_field_values){const prev=this.values.find(x=>x.issue_field_id===item.field_id); if(prev)prev.value=item.value;else this.values.push({issue_field_id:item.field_id,value:item.value});}return ok(this.values); }
        return ok(this.values);
      }
    }
    return failure(404);
  };
  client() { return new GitHub(target,{transport:this.transport,maxPages:2}); }
  writes() { return this.calls.filter(x=>x.args[0]==='issue'&&!x.args.includes('--help') || x.args[0]==='api'&&x.args[x.args.indexOf('--method')+1]!=='GET'&&x.args[x.args.indexOf('--method')+2]!=='graphql'); }
}
function input(s){return {version:1,payload:s.payload,context:s.context,statePath:s.statePath};}
function existing(s,gh,action='metadata update') {
  const issue=gh.addIssue(); s.c.action=action; s.c.issueUrl=issue.html_url; s.c.title=issue.title; s.c.body=''; s.c.allowedActions=[action];
  s.c.duplicate.issues=gh.client().duplicates(s.c.duplicate.query,20);s.c.duplicate.issue=gh.client().issue(issue.html_url);s.c.duplicate.comments=[]; return issue;
}
function label(s,required=true) {
  const m={id:'label',kind:'label',name:'maintenance',destination:s.c.issueUrl??rootUrl,value:'maintenance',observed:false,definition:definition({id:10,name:'maintenance',description:'Maintenance'}),required,overwrite:false,rationale:'Maintenance classification',permission:perm,...!required?{omissionPolicy:'skip-on-loss-or-conflict'}:{}};
  s.c.metadata.push(m);s.c.allowedActions.push('metadata:label');s.context.permissions.label=perm;return m;
}
function approvedImage(s,id='image',destination='body') {
  const path=join(s.dir,`${id}.png`);writeFileSync(path,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1AAAAAASUVORK5CYII=','base64'));
  const image={id,path,sha256:hash(readFileSync(path)),approval:'Human approved this image and text specification',surface:'screen',viewport:'1280x720',state:'loaded',caption:id,provenance:'Approved screenshot',generated:false,destination};
  s.c.images.push(image);s.c.noApprovedImages=false;s.c.allowedActions.push(`image:${id}`);return image;
}

test('workspace captures dirty/staged/untracked content, symlinks, detached HEAD and ignored inventory',t=>{
  const s=setup(t);writeFileSync(join(s.repo,'source.txt'),'staged');git(s.repo,'add','source.txt');writeFileSync(join(s.repo,'source.txt'),'unstaged');writeFileSync(join(s.repo,'new.txt'),'first');symlinkSync('source.txt',join(s.repo,'link'));writeFileSync(join(s.repo,'.gitignore'),'cache\n');writeFileSync(join(s.repo,'cache'),'old');
  git(s.repo,'checkout','--detach');const base=snapshot(s.repo,{inventory:['cache']});assert.equal(base.branch,null);assert.ok(base.staged.includes('staged'));assert.ok(base.unstaged.includes('unstaged'));assert.equal(compare(base).status,'verified');
  writeFileSync(join(s.repo,'new.txt'),'second');assert.equal(compare(base).status,'blocked');writeFileSync(join(s.repo,'new.txt'),'first');writeFileSync(join(s.repo,'cache'),'fresh');assert.equal(compare(base).status,'blocked');
  const repaired=snapshot(s.repo,{originalRef:base.ref,repairLedger:[{target:'cache',result:'verified'}],inventory:['cache']});assert.equal(compare(repaired).status,'verified');assert.equal(repaired.originalRef,base.ref);
});
test('payload validation rejects incomplete/action-mismatched/repair-pending/unapproved operations',t=>{
  const s=setup(t);assert.equal(validatePayload(s.payload).complete,true);
  for(const mutate of [c=>delete c.authorization.context,c=>c.action='duplicate comment',c=>c.readiness='repair pending',c=>c.allowedActions.push('deploy'),c=>c.workspace.cleanupVerified=false]) {const p=structuredClone(s.payload);mutate(p.candidates[0]);assert.throws(()=>validatePayload(p));}
  label(s);s.c.metadata[0].destination='another';assert.throws(()=>validatePayload(s.payload),/destination/);
});
test('missing/changed approved images block all writes',t=>{
  const s=setup(t),gh=new FakeGh(),i=approvedImage(s);writeFileSync(i.path,'changed');assert.equal(images(s.c.images).status,'blocked');assert.equal(record(input(s),{client:gh.client()}).status,'blocked');assert.equal(gh.writes().length,0);rmSync(i.path);assert.equal(images(s.c.images).status,'blocked');
});
test('Plan Mode, draft-only, diagnosis-only and unverified authorization never record',t=>{
  const s=setup(t),gh=new FakeGh();
  s.context.mode='plan';assert.equal(record(input(s),{client:gh.client()}).status,'blocked');s.context.mode='default';
  for(const key of ['draftOnly','diagnosisOnly']) {s.c.restrictions[key]=true;assert.equal(record(input(s),{client:gh.client()}).status,'blocked');s.c.restrictions[key]=false;}
  s.context.trustedAuthorization=false;assert.equal(record(input(s),{client:gh.client()}).status,'blocked');assert.equal(gh.writes().length,0);
});
test('collector separates inaccessible metadata from an empty successful result',t=>{
  const gh=new FakeGh();gh.labels=[];gh.unavailable=args=>args.includes('orgs/owner/issue-fields');
  const r=collect({version:1,target,discover:true},gh.client());assert.equal(r.status,'blocked');assert.deepEqual(r.observations.labels.value,[]);assert.equal(r.observations.issueFields.available,false);
});
test('new issue uses exact text, includes creation metadata, re-fetches and resumes without writing twice',t=>{
  const s=setup(t),gh=new FakeGh();label(s);const r=record(input(s),{client:gh.client()});assert.equal(r.status,'verified',JSON.stringify(r));assert.equal(gh.issues.get(1).body,s.c.body);assert.deepEqual(gh.issues.get(1).labels,[{name:'maintenance'}]);const writes=gh.writes().length;assert.equal(record(input(s),{client:gh.client()}).status,'verified');assert.equal(gh.writes().length,writes);
});
test('duplicate comment is singular and metadata-only/existing-issue add no comment',t=>{
  const s=setup(t),gh=new FakeGh();existing(s,gh,'duplicate comment');s.c.comment='Exact duplicate handoff';label(s);
  assert.equal(record(input(s),{client:gh.client()}).status,'verified');assert.equal(gh.comments.length,1);assert.equal(record(input(s),{client:gh.client()}).status,'verified');assert.equal(gh.comments.length,1);
  const s2=setup(t),gh2=new FakeGh();existing(s2,gh2);label(s2);assert.equal(record(input(s2),{client:gh2.client()}).status,'verified');assert.equal(gh2.comments.length,0);
  const s3=setup(t),gh3=new FakeGh();existing(s3,gh3,'existing issue');assert.equal(record(input(s3),{client:gh3.client()}).status,'verified');assert.equal(gh3.writes().length,0);
});
test('permission loss/definition conflict block required metadata and omit optional metadata',t=>{
  const s=setup(t),gh=new FakeGh();label(s);delete s.context.permissions.label;assert.equal(record(input(s),{client:gh.client()}).status,'blocked');assert.equal(gh.writes().length,0);
  s.statePath=join(s.dir,'optional-ledger.json');s.c.metadata[0].required=false;s.c.metadata[0].omissionPolicy='skip-on-loss-or-conflict';const r=record(input(s),{client:gh.client()});assert.equal(r.status,'verified');assert.equal(r.outcomes[0].omissions.length,1);
  const plan=metadataPlan(s.c,{label:{available:true,value:{definition:{different:true},value:false,capable:true}}},s.context);assert.equal(plan.omissions.length,1);
});
test('new duplicate, closed target, account change and source head/merged/thread changes stop writes',t=>{
  const s=setup(t),gh=new FakeGh();gh.addIssue();assert.equal(record(input(s),{client:gh.client()}).status,'needs-review');assert.equal(gh.writes().length,0);
  gh.issues.clear();gh.account='another';assert.equal(record(input(s),{client:gh.client()}).status,'blocked');gh.account='tester';
  s.statePath=join(s.dir,'source-ledger.json');s.c.source={head:gh.pr.head.sha,number:5,url:gh.pr.html_url,threadId:'thread'};gh.pr.head.sha='b'.repeat(40);assert.equal(record(input(s),{client:gh.client()}).status,'blocked');gh.pr.head.sha=s.c.source.head;gh.pr.merged=false;assert.equal(record(input(s),{client:gh.client()}).status,'blocked');gh.pr.merged=true;gh.thread.isResolved=true;const r=record(input(s),{client:gh.client()});assert.equal(r.outcomes[0].skip,true);assert.equal(gh.writes().length,0);
  const s2=setup(t),gh2=new FakeGh();const issue=existing(s2,gh2);label(s2);issue.state='closed';assert.equal(record(input(s2),{client:gh2.client()}).status,'needs-review');
});
test('uncertain creation needs a verified receipt and never recreates the issue',t=>{
  const s=setup(t),gh=new FakeGh();gh.loseNext=true;assert.equal(record(input(s),{client:gh.client()}).status,'uncertain');const writes=gh.writes().length;
  assert.equal(record(input(s),{client:gh.client()}).status,'uncertain');assert.equal(gh.writes().length,writes);
  s.context.receipts={create:{url:gh.issues.get(1).html_url,payloadHash:hash(s.payload),operationId:'candidate/create',evidence:'Recovered exact creation output in trusted session'}};
  assert.equal(record(input(s),{client:gh.client()}).status,'verified');assert.equal(gh.writes().length,writes);
});
test('metadata applied before response loss is reconciled through reads',t=>{
  const s=setup(t),gh=new FakeGh();existing(s,gh);label(s);gh.loseMetadata=true;assert.equal(record(input(s),{client:gh.client()}).status,'uncertain');const writes=gh.writes().length;assert.equal(record(input(s),{client:gh.client()}).status,'verified');assert.equal(gh.writes().length,writes);
});
function recoverySetup(t) {
  const s=setup(t),gh=new FakeGh();
  assert.throws(()=>record(input(s),{client:gh.client(),afterJournal:()=>{throw new Error('interrupted before launch');}}));
  const ledger=JSON.parse(readFileSync(s.statePath));ledger.candidates.candidate.ops.create.finishedAt=new Date().toISOString();save(s.statePath,ledger);
  s.context.creationRetry={confirmed:true,originalRecorderFinished:true,evidence:'Human explicitly requests retry; original recorder terminal state verified'};
  const request={...input(s),candidateId:s.c.id};
  const options={client:gh.client(),now:()=>Date.now()+180000};
  return {s,gh,request,options};
}
test('absent creation recovery preserves attempts and permits one fresh preflight and creation',t=>{
  const {s,gh,request,options}=recoverySetup(t);
  assert.equal(recoverCreate(request,options).retryReleased,true);
  const journal=JSON.parse(readFileSync(s.statePath));
  assert.equal(journal.candidates.candidate.creationAttempts[0].operation.status,'uncertain');
  assert.equal(journal.candidates.candidate.creationAttempts[0].recovery.completeReads,2);
  assert.equal(journal.candidates.candidate.ops.create,undefined);
  assert.equal(gh.writes().length,0);
  assert.equal(record(input(s),{client:gh.client()}).status,'verified');
  assert.equal(gh.issues.size,1);
  assert.throws(()=>recoverCreate(request,options),/Only an uncertain creation/);
});
test('creation recovery finds an existing receipt without another write even when search is empty',t=>{
  const {s,gh,request,options}=recoverySetup(t);
  const issue=gh.addIssue(s.c.body,s.c.title);gh.search=[];
  const r=recoverCreate(request,options);
  assert.equal(r.recoveredReceipt,true);assert.equal(r.issueUrl,issue.html_url);
  assert.equal(gh.writes().length,0);
  assert.equal(JSON.parse(readFileSync(s.statePath)).candidates.candidate.ops.create.status,'verified');
});
test('creation recovery blocks unavailable or bounded inventory, changed content, missing authorization and premature retry',t=>{
  const {s,gh,request,options}=recoverySetup(t),original=readFileSync(s.statePath,'utf8');
  delete s.context.creationRetry;assert.throws(()=>recoverCreate(request,options),/authorization/);
  s.context.creationRetry={confirmed:true,originalRecorderFinished:true,evidence:'Explicit human retry'};
  assert.throws(()=>recoverCreate(request,{...options,now:()=>Date.now()}),/two minutes/);
  gh.unavailable=args=>args.some(x=>x.startsWith('repos/owner/repo/issues?state=all'));
  assert.throws(()=>recoverCreate(request,options),/unavailable/);delete gh.unavailable;
  gh.recoveryInventory=Array.from({length:100},()=>({created_at:new Date().toISOString(),title:'Unrelated',user:{login:'tester'}}));
  assert.throws(()=>recoverCreate(request,options),/pagination bound/);delete gh.recoveryInventory;
  gh.addIssue('changed after creation',s.c.title);
  assert.equal(recoverCreate(request,options).status,'blocked');
  assert.equal(readFileSync(s.statePath,'utf8'),original);assert.equal(gh.writes().length,0);
});
test('creation recovery never treats an edited title or unrelated authored issue as proven absence',t=>{
  const {s,gh,request,options}=recoverySetup(t),original=readFileSync(s.statePath,'utf8');
  const issue=gh.addIssue(s.c.body,'Title edited after a lost response');
  assert.equal(recoverCreate(request,options).status,'blocked');
  issue.body='Both title and body edited';
  assert.equal(recoverCreate(request,options).status,'blocked');
  assert.equal(readFileSync(s.statePath,'utf8'),original);assert.equal(gh.writes().length,0);
});
test('creation recovery excludes later unrelated issues only with an audited completion bound',t=>{
  const {s,gh,request,options}=recoverySetup(t);
  gh.addIssue('Another task','Later unrelated issue').created_at=new Date(Date.now()+120000).toISOString();
  assert.equal(recoverCreate(request,options).retryReleased,true);assert.equal(gh.writes().length,0);
});
test('a delayed server creation remains recoverable outside the local command completion window',t=>{
  const {s,gh,request,options}=recoverySetup(t);
  const issue=gh.addIssue(s.c.body,s.c.title);issue.created_at=new Date(Date.now()+120000).toISOString();
  assert.equal(recoverCreate(request,options).recoveredReceipt,true);assert.equal(gh.writes().length,0);
});
test('a delayed creation with an edited title still blocks retry through its exact body',t=>{
  const {s,gh,request,options}=recoverySetup(t);
  const issue=gh.addIssue(s.c.body,'Edited after delayed completion');issue.created_at=new Date(Date.now()+120000).toISOString();
  assert.equal(recoverCreate(request,options).status,'blocked');assert.equal(gh.writes().length,0);
});
test('legacy creation completion uses the exact saved result and rejects altered or different attempt proof',t=>{
  const {s,gh,request,options}=recoverySetup(t);
  const ledger=JSON.parse(readFileSync(s.statePath));delete ledger.candidates.candidate.ops.create.finishedAt;save(s.statePath,ledger);
  const path=join(s.dir,'original-result.json');
  save(path,{version:1,payloadHash:hash(s.payload),outcomes:[{candidateId:s.c.id,operations:{create:ledger.candidates.candidate.ops.create}}]});
  s.context.creationRetry.completionResult={path,sha256:hash(readFileSync(path))};
  const original=readFileSync(s.statePath,'utf8');
  const proof=readFileSync(path);writeFileSync(path,'{}');
  assert.throws(()=>recoverCreate(request,options),/Completion result changed/);assert.equal(readFileSync(s.statePath,'utf8'),original);
  writeFileSync(path,proof);s.context.creationRetry.completionResult.sha256=hash(readFileSync(path));
  assert.equal(recoverCreate(request,options).retryReleased,true);
});
test('CLI failures expose only a bounded classification without raw stderr',()=>{
  const r=run(process.execPath,['-e','process.stderr.write("API rate limit exceeded secret-example");process.exit(1)']);
  assert.equal(r.failureCode,'rate-limit');assert.equal(r.ok,false);assert.equal(r.stderr,undefined);
  assert.equal(JSON.stringify(r).includes('secret-example'),false);
});
test('write-ahead journal survives interruption and locks/changed payload prevent new writes',t=>{
  const s=setup(t),gh=new FakeGh();assert.throws(()=>record(input(s),{client:gh.client(),afterJournal:()=>{throw new Error('process interrupted');}}),/interrupted/);assert.equal(gh.writes().length,0);assert.equal(record(input(s),{client:gh.client()}).status,'uncertain');
  const journal=JSON.parse(readFileSync(s.statePath));assert.equal(journal.candidates.candidate.ops.create.status,'uncertain');s.c.title='changed';assert.throws(()=>record(input(s),{client:gh.client()}),/another payload/);s.c.title='area: maintain behavior';mkdirSync(`${s.statePath}.lock`);assert.equal(record(input(s),{client:gh.client()}).status,'blocked');
});
test('image partial upload keeps its issue and attachments but remains failed without duplicate writes',t=>{
  const s=setup(t),gh=new FakeGh();approvedImage(s,'one');approvedImage(s,'two');gh.partial=true;
  const r=record(input(s),{client:gh.client()});assert.equal(r.status,'failed',JSON.stringify(r));assert.ok(r.outcomes[0].attachments.one);assert.equal(r.outcomes[0].attachments.two,undefined);assert.equal(gh.issues.size,1);const count=gh.writes().length;
  const recovery=record(input(s),{client:gh.client()});assert.equal(recovery.status,'blocked');assert.equal(gh.writes().length,count);
  const state=JSON.parse(readFileSync(s.statePath)).candidates.candidate;assert.deepEqual(state.ops['attachments:body'].browser.images.map(x=>x.id),['two']);
  gh.issues.get(1).body+=`\n\n![two](${nativeUrl(2)})`;
  assert.equal(record(input(s),{client:gh.client()}).status,'verified');assert.equal(gh.writes().length,count);
});
test('all image attachments reconcile to native URLs; nonnative/local URLs cannot complete',t=>{
  const s=setup(t),gh=new FakeGh();approvedImage(s);assert.equal(record(input(s),{client:gh.client()}).status,'verified');
  for(const url of ['file:///private/image.png','https://example.com/image.png','https://github.com/unrelated.png'])assert.equal(reconcileImages(s.c,{body:{url:`${rootUrl}/issues/1`,body:`![image](${url})`}},target.host).status,'failed');
});
test('attachment fallback reserves one native browser operation and validates its returned receipt',t=>{
  const s=setup(t),gh=new FakeGh();approvedImage(s);gh.attach=false;s.c.imageComment='Approved image specification';s.c.allowedActions.push('image-comment');
  const first=record(input(s),{client:gh.client()});assert.equal(first.status,'blocked');assert.equal(gh.issues.size,1);const count=gh.writes().length;
  const state=JSON.parse(readFileSync(s.statePath)).candidates.candidate;assert.equal(state.ops['image-comment'].browser.images.length,1);
  gh.comments.push({id:9,html_url:`${rootUrl}/issues/1#issuecomment-9`,body:`${s.c.imageComment}\n\n![image](${nativeUrl(1)})`,user:{login:'tester'}});
  s.context.receipts={'image-comment':{url:gh.comments[0].html_url,payloadHash:hash(s.payload),operationId:'candidate/image-comment',evidence:'Native browser operation returned comment URL'}};
  const r=record(input(s),{client:gh.client()});assert.equal(r.status,'verified',JSON.stringify(r));assert.equal(gh.writes().length,count);assert.equal(r.outcomes[0].attachments.image.sourceUrl,gh.comments[0].html_url);
});
test('native issue field writes are nonempty additive requests and preserve unrelated values',t=>{
  const s=setup(t),gh=new FakeGh();existing(s,gh);gh.values=[{issue_field_id:2,value:'keep'}];
  const def={id:1,name:'Priority',data_type:'single_select',options:[{id:1,name:'High'}]};
  const m={id:'priority',kind:'issue-field',fieldId:1,dataType:'single_select',name:'Priority',destination:s.c.issueUrl,value:'High',observed:null,definition:def,required:true,overwrite:false,rationale:'Explicit repository priority rubric',permission:perm};
  s.c.metadata=[m];s.c.allowedActions.push('metadata:priority');s.context.permissions.priority=perm;const r=record(input(s),{client:gh.client()});assert.equal(r.status,'verified',JSON.stringify(r));assert.equal(gh.values.find(x=>x.issue_field_id===2).value,'keep');
  const request=gh.writes().find(x=>x.args.includes('repos/owner/repo/issues/1/issue-field-values'));assert.equal(request.args[request.args.indexOf('--method')+1],'POST');assert.deepEqual(JSON.parse(request.input),{issue_field_values:[{field_id:1,value:'High'}]});
  gh.values.find(x=>x.issue_field_id===2).value='lost';const state=JSON.parse(readFileSync(s.statePath)).candidates.candidate;assert.equal(verifyRecording(s.payload,s.c,gh.client(),state).status,'failed');
});
test('known optional failure preserves issue; required failure reports surviving record',t=>{
  for(const required of [false,true]) {
    const s=setup(t),gh=new FakeGh();existing(s,gh);label(s,required);gh.unavailable=args=>args.includes('repos/owner/repo/issues/1/labels')&&args.includes('POST');const r=record(input(s),{client:gh.client()});assert.equal(r.status,required?'failed':'verified',JSON.stringify(r));assert.equal(r.outcomes[0].issueUrl,s.c.issueUrl);assert.equal(gh.issues.size,1);
  }
});
test('CLI uses structured errors, private output and rejects overwriting repository files',t=>{
  const s=setup(t),path=join(s.dir,'input.json');save(path,{version:1,repo:s.repo});assert.throws(()=>main(['snapshot',path,join(s.repo,'output.json')]),/outside/);assert.equal(main(['snapshot',path,join(s.dir,'baseline.json')]).complete,true);
  const cli=spawnSync(process.execPath,[new URL('./add-issue.mjs',import.meta.url).pathname,'unknown',path],{encoding:'utf8'});assert.equal(cli.status,1);assert.equal(JSON.parse(cli.stdout).status,'failed');
});

class ProjectGh extends FakeGh {
  constructor() {
    super();this.member=false;this.itemId='ITEM_1';this.projectWritable=true;this.fields=[{id:'F_1',name:'Priority',dataType:'SINGLE_SELECT',options:[{id:'OPT_1',name:'High'}],project:{id:'P_1'}},{id:'F_2',name:'Note',dataType:'TEXT',project:{id:'P_1'}}];this.projectValues={F_2:'keep'};this.mutations=[];
    const base=this.transport;
    this.transport=(program,args,options={})=>{
      if(args[0]!=='api'||args[args.indexOf('--method')+2]!=='graphql')return base(program,args,options);
      this.calls.push({args:[...args],input:options.input});const {query,variables:v}=JSON.parse(options.input);
      const ok=data=>({ok:true,stdout:JSON.stringify({data})});
      if(query.includes('addProjectV2ItemById')){this.mutations.push('membership');this.member=true;return ok({addProjectV2ItemById:{item:{id:this.itemId}}});}
      if(query.includes('updateProjectV2ItemFieldValue')){this.mutations.push('field');this.projectValues[v.input.fieldId]=Object.values(v.input.value)[0];return ok({updateProjectV2ItemFieldValue:{projectV2Item:{id:this.itemId}}});}
      if(query.includes('viewerCanUpdate'))return ok({node:{id:'P_1',title:'Roadmap',viewerCanUpdate:this.projectWritable}});
      if(query.includes('projectItems('))return ok({node:{projectItems:{nodes:this.member?[{id:this.itemId,project:{id:'P_1'}}]:[],pageInfo:{hasNextPage:false,endCursor:null}}}});
      if(query.includes('fieldValueByName')){const f=this.fields.find(x=>x.name===v.name),value=this.projectValues[f.id];return ok({node:{fieldValueByName:value===undefined?null:{field:f,[f.dataType==='TEXT'?'text':'optionId']:value}}});}
      if(query.includes('fieldValues('))return ok({node:{fieldValues:{nodes:Object.entries(this.projectValues).map(([id,value])=>({field:this.fields.find(x=>x.id===id),[id==='F_2'?'text':'optionId']:value})),pageInfo:{hasNextPage:false,endCursor:null}}}});
      if(query.includes('fields(first:'))return ok({node:{fields:{nodes:this.fields,pageInfo:{hasNextPage:false,endCursor:null}}}});
      return ok({node:this.fields.find(x=>x.id===v.id)});
    };
  }
}
function projectAudit(s,gh,{membership=false}={}) {
  const f={id:'priority',kind:'project-field',projectId:'P_1',fieldId:'F_1',name:'Priority',destination:'P_1',valueType:'singleSelectOptionId',value:'OPT_1',observed:null,definition:definition(gh.fields[0]),required:true,overwrite:false,rationale:'Authorized project priority',permission:perm};s.c.metadata.push(f);s.c.allowedActions.push('metadata:priority');s.context.permissions.priority=perm;
  if(membership){const m={id:'membership',kind:'project-membership',projectId:'P_1',name:'Roadmap',destination:'P_1',value:true,observed:false,definition:{id:'P_1',name:'Roadmap'},required:true,overwrite:false,rationale:'Human explicitly requested membership',permission:perm};s.c.metadata.push(m);s.c.allowedActions.push('metadata:membership');s.context.permissions.membership=perm;}
}
test('project membership precedes individual field writes and unrelated project values survive',t=>{
  const s=setup(t),gh=new ProjectGh();projectAudit(s,gh,{membership:true});const r=record(input(s),{client:gh.client()});assert.equal(r.status,'verified',JSON.stringify(r));assert.deepEqual(gh.mutations,['membership','field']);assert.equal(gh.projectValues.F_2,'keep');
  const s2=setup(t),gh2=new ProjectGh();existing(s2,gh2);gh2.member=true;projectAudit(s2,gh2);assert.equal(record(input(s2),{client:gh2.client()}).status,'verified');gh2.projectValues.F_2='lost';const state=JSON.parse(readFileSync(s2.statePath)).candidates.candidate;assert.equal(verifyRecording(s2.payload,s2.c,gh2.client(),state).status,'failed');
});
test('missing project item, wrong-project field and project permission loss block before creation',t=>{
  const s=setup(t),gh=new ProjectGh();projectAudit(s,gh);assert.equal(record(input(s),{client:gh.client()}).status,'blocked');assert.equal(gh.issues.size,0);
  gh.fields[0].project.id='OTHER';assert.equal(record(input(s),{client:gh.client()}).status,'blocked');gh.fields[0].project.id='P_1';gh.projectWritable=false;assert.equal(record(input(s),{client:gh.client()}).status,'blocked');assert.equal(gh.issues.size,0);
});
test('changed duplicate thread stops a second implementation-handoff comment',t=>{
  const s=setup(t),gh=new FakeGh();existing(s,gh,'duplicate comment');s.c.comment='Approved missing evidence';gh.comments.push({id:1,html_url:`${s.c.issueUrl}#issuecomment-1`,body:'New independently supplied evidence',user:{login:'other'}});
  assert.equal(record(input(s),{client:gh.client()}).status,'needs-review');assert.equal(gh.writes().length,0);
});
test('independently audited candidates continue after an uncertain write or draft-only restriction',t=>{
  for(const draft of [false,true]) {
    const s=setup(t),gh=new FakeGh();gh.search=[];const second=structuredClone(s.c);second.id='second';second.title='Second independent task';s.payload.candidates.push(second);
    if(draft)s.c.restrictions.draftOnly=true;else gh.loseNext=true;
    const r=record(input(s),{client:gh.client()});assert.equal(r.outcomes[0].status,draft?'blocked':'uncertain');assert.equal(r.outcomes[1].status,'verified',JSON.stringify(r));assert.equal(gh.issues.size,draft?1:2);
  }
});
test('GitHub searches are bounded and cannot return another repository',()=>{
  const gh=new FakeGh();gh.search=[{html_url:'https://github.com/other/repo/issues/1',number:1,title:'wrong',body:'',state:'open'}];assert.throws(()=>gh.client().duplicates('term',20),/target mismatch/);
  gh.search=Array.from({length:21},(_,i)=>({number:i+1,html_url:`${rootUrl}/issues/${i+1}`}));assert.throws(()=>gh.client().duplicates('term',20),/Incomplete/);
});

test('existing approved body/comment attachments complete without a redundant comment',t=>{
  for(const commentSurface of [false,true]) {
    const s=setup(t),gh=new FakeGh();const issue=existing(s,gh,'existing issue');const image=approvedImage(s,'existing-image','existing');image.attachmentUrl=nativeUrl(3);
    const body=`Already sufficient specification\n\n![existing-image](${image.attachmentUrl})`;
    if(commentSurface){image.surfaceUrl=`${issue.html_url}#issuecomment-7`;gh.comments.push({id:7,html_url:image.surfaceUrl,body,user:{login:'previous-reporter'}});}
    else {image.surfaceUrl=issue.html_url;issue.body=body;}
    s.c.duplicate.issues=gh.client().duplicates(s.c.duplicate.query,20);s.c.duplicate.issue=gh.client().issue(issue.html_url);s.c.duplicate.comments=gh.client().comments(issue.html_url);
    const r=record(input(s),{client:gh.client()});assert.equal(r.status,'verified',JSON.stringify(r));assert.equal(gh.writes().length,0);assert.equal(r.outcomes[0].attachments['existing-image'].sourceUrl,image.surfaceUrl);
    const s2=setup(t),gh2=new FakeGh();const issue2=existing(s2,gh2);label(s2);const i2=approvedImage(s2,'existing-image','existing');i2.surfaceUrl=issue2.html_url;i2.attachmentUrl=nativeUrl(3); // Missing native attachment must block metadata too.
    assert.equal(record(input(s2),{client:gh2.client()}).status,'blocked');assert.equal(gh2.writes().length,0);
  }
});
test('a corrupt retained target cannot redirect remaining metadata writes',t=>{
  const s=setup(t),gh=new FakeGh();label(s);assert.equal(record(input(s),{client:gh.client()}).status,'verified');const other=gh.addIssue('different','Different');const ledger=JSON.parse(readFileSync(s.statePath));ledger.candidates.candidate.issueUrl=other.html_url;save(s.statePath,ledger);gh.search=[];
  const count=gh.writes().length;assert.equal(record(input(s),{client:gh.client()}).status,'blocked');assert.equal(gh.writes().length,count);
});
test('204 assignee support and sanitized HTTP rejection status work without raw stderr exposure',()=>{
  const client=new GitHub(target,{transport:()=>({ok:true,stdout:''})});assert.equal(client.api('repos/owner/repo/assignees/tester'),null);
  const rejected=new GitHub(target,{transport:()=>({ok:false,stdout:'',httpStatus:403})});assert.throws(()=>rejected.api('repos/owner/repo/issues/1/labels','POST',{labels:['x']}),e=>e.definite===true);
});
test('private artifacts cannot be written through a symlink into the investigated repo',t=>{
  const s=setup(t),path=join(s.dir,'input.json');save(path,{version:1,repo:s.repo});const alias=join(s.dir,'alias');symlinkSync(s.repo,alias);
  assert.throws(()=>main(['snapshot',path,join(alias,'snapshot.json')]),/outside/);assert.throws(()=>record({...input(s),statePath:join(alias,'ledger.json')},{client:new FakeGh().client()}),/outside/);
});

test('existing generated image prompt is validated from retained and live published evidence',t=>{
  const s=setup(t),gh=new FakeGh();const issue=existing(s,gh,'existing issue');const image=approvedImage(s,'generated-image','existing');image.generated=true;image.prompt='Exact approved generation prompt';image.surfaceUrl=issue.html_url;image.attachmentUrl=nativeUrl(4);issue.body=`Existing specification\n\n![generated-image](${image.attachmentUrl})`;
  gh.comments.push({id:1,html_url:`${issue.html_url}#issuecomment-1`,body:image.prompt,user:{login:'reporter'}});s.c.duplicate.issues=gh.client().duplicates('term',20);s.c.duplicate.issue=gh.client().issue(issue.html_url);s.c.duplicate.comments=gh.client().comments(issue.html_url);
  assert.equal(validatePayload(s.payload).complete,true);const r=record(input(s),{client:gh.client()});assert.equal(r.status,'verified',JSON.stringify(r));assert.equal(gh.writes().length,0);
  gh.comments[0].body='Prompt removed';const state=JSON.parse(readFileSync(s.statePath)).candidates.candidate;assert.equal(verifyRecording(s.payload,s.c,gh.client(),state).status,'failed');
});
test('labels that require CSV quoting use exact API metadata plus the audited image handoff',t=>{
  const s=setup(t),gh=new FakeGh();const m=label(s);m.value='maintenance,exact';m.name=m.value;gh.labels[0].name=m.value;m.definition=definition(gh.labels[0]);approvedImage(s);s.c.imageComment='Approved image handoff';s.c.allowedActions.push('image-comment');
  const r=record(input(s),{client:gh.client()});assert.equal(r.status,'verified',JSON.stringify(r));assert.deepEqual(gh.issues.get(1).labels,[{name:'maintenance,exact'}]);assert.equal(gh.comments.length,1);assert.ok(gh.writes().find(x=>x.args.includes('repos/owner/repo/issues')));
});

test('nested submodule contents are preserved even when the outer dirty flag is unchanged',t=>{
  const parent=setup(t),child=setup(t);git(parent.repo,'-c','protocol.file.allow=always','submodule','add',child.repo,'module');git(parent.repo,'commit','--quiet','-m','Add module');const path=join(parent.repo,'module','source.txt');writeFileSync(path,'first dirty content');const baseline=snapshot(parent.repo);writeFileSync(path,'second dirty content');const observed=snapshot(parent.repo);assert.equal(observed.status,baseline.status);assert.ok(compare(baseline,observed).errors.includes('Workspace files changed'));
});

test('CLI uploads immutable approved bytes and removes only its private copies',t=>{
  const s=setup(t),gh=new FakeGh();const image=approvedImage(s);const base=gh.transport;let copiedPath;
  const client=new GitHub(target,{transport:(program,args,options)=>{
    if(args[0]==='issue'&&args[1]==='create'&&!args.includes('--help')) {copiedPath=args[args.indexOf('--attach')+1].split('#')[0];assert.notEqual(copiedPath,image.path);assert.equal(hash(readFileSync(copiedPath)),image.sha256);writeFileSync(image.path,'Concurrent edit');assert.equal(hash(readFileSync(copiedPath)),image.sha256);}
    return base(program,args,options);
  }});
  assert.equal(record(input(s),{client}).status,'verified');assert.throws(()=>readFileSync(copiedPath),/ENOENT/);assert.equal(readFileSync(image.path,'utf8'),'Concurrent edit');
});

test('Collect Review supports explicit null thread/review revision while preserving PR preflight',t=>{
  const s=setup(t),gh=new FakeGh();
  s.c.classification='Bug'; s.c.revision=gh.pr.head.sha;
  Object.assign(s.c.authorization,{kind:'collect-review',runId:'review-run',delegation:'Collect Review coordinator',scope:'Merged PR 5'});
  s.c.source={number:5,url:gh.pr.html_url,head:s.c.revision,merged:true,resolved:null,threadId:null,threadUrl:null,reviewRevision:null,reviewEvidence:'Review body without a thread; original review SHA unavailable',authorship:'API Bot identity'};
  assert.equal(validatePayload(s.payload).complete,true);
  const observations=gh.client().source(s.c.source); assert.equal(observations.resolved,null);
  assert.equal(gh.calls.some(x=>x.args.includes('graphql')),false);
  assert.equal(preflight(s.payload,s.c,gh.client(),s.context).complete,true);
  gh.pr.head.sha='b'.repeat(40); assert.equal(preflight(s.payload,s.c,gh.client(),s.context).complete,false);
  gh.pr.head.sha=s.c.revision; gh.pr.merged=false; assert.equal(preflight(s.payload,s.c,gh.client(),s.context).complete,false);
  gh.pr.merged=true;
  delete s.c.source.reviewRevision; assert.throws(()=>validatePayload(s.payload),/review revision/); s.c.source.reviewRevision=null;
  delete s.c.source.threadId; assert.throws(()=>validatePayload(s.payload),/threadId/); s.c.source.threadId=null;
  s.c.source.resolved=false; assert.throws(()=>validatePayload(s.payload),/explicit null/);
});
test('Collect Review thread-backed source still requires unresolved boolean and exact source target',t=>{
  const s=setup(t),gh=new FakeGh(); s.c.classification='Bug';s.c.revision=gh.pr.head.sha;
  Object.assign(s.c.authorization,{kind:'collect-review',runId:'review-run',delegation:'coordinator',scope:'PR 5'});
  s.c.source={number:5,url:gh.pr.html_url,head:s.c.revision,merged:true,resolved:false,threadId:'thread',threadUrl:gh.pr.html_url+'#discussion_r1',reviewRevision:null,reviewEvidence:'Source review',authorship:'API identity'};
  assert.equal(validatePayload(s.payload).complete,true);
  s.c.source.resolved=true;assert.throws(()=>validatePayload(s.payload),/not eligible/);
  s.c.source.resolved=false;s.c.source.url='https://elsewhere.test/owner/repo/pull/5';assert.throws(()=>validatePayload(s.payload),/target mismatch/);
  s.c.source.url=gh.pr.html_url;delete gh.thread.isResolved;assert.throws(()=>gh.client().source(s.c.source),/target mismatch/);
});

test('Collect Review recording preflight enforces every related source without changing investigation revision',t=>{
  const s=setup(t),gh=new FakeGh();s.c.classification='Bug';s.c.revision=gh.pr.head.sha;
  Object.assign(s.c.authorization,{kind:'collect-review',runId:'review-run',delegation:'coordinator',scope:'Merged PRs'});
  const source={number:5,url:gh.pr.html_url,head:s.c.revision,merged:true,resolved:null,threadId:null,threadUrl:null,reviewRevision:null,reviewEvidence:'Confirmed retained revision and outcome applicability',authorship:'API Bot identity'};
  s.c.source={...source,relatedSources:[{...source,threadId:'thread',threadUrl:gh.pr.html_url+'#discussion_r1',resolved:false}]};
  assert.equal(validatePayload(s.payload).complete,true);
  assert.equal(preflight(s.payload,s.c,gh.client(),s.context).complete,true);
  gh.thread.isResolved=true;assert.equal(preflight(s.payload,s.c,gh.client(),s.context).skip,true);
  gh.thread.isResolved=false;gh.thread.pullRequest.headRefOid='b'.repeat(40);assert.equal(preflight(s.payload,s.c,gh.client(),s.context).complete,false);
  s.c.source.relatedSources[0].relatedSources=[];assert.throws(()=>validatePayload(s.payload),/Nested/);
});


function reviewInput(s, gh, revise) {
  const previousPayload = structuredClone(s.payload);
  const ledger = JSON.parse(readFileSync(s.statePath));
  const flight = preflight(previousPayload, previousPayload.candidates[0], gh.client(), s.context, ledger.candidates.candidate);
  assert.equal(flight.status, 'needs-review');
  const payload = structuredClone(previousPayload), c = payload.candidates[0];
  c.duplicate.issues = flight.duplicateReview.issues;
  if (c.action !== 'new issue') {
    c.duplicate.issue = gh.client().issue(c.issueUrl);
    const receipts = new Set(Object.values(ledger.candidates.candidate.ops).map(x => x.receipt));
    c.duplicate.comments = gh.client().comments(c.issueUrl).filter(x => !receipts.has(x.url));
  }
  revise?.(c);
  return { version: 1, previousPayload, payload, statePath: s.statePath,
    review: { candidateId: c.id, reason: 'Coordinator reviewed latest evidence against retained implementation boundary', observations: flight.duplicateReview },
    context: { ...s.context, duplicateReview: { confirmed: true, evidence: 'Trusted coordinator semantic review in current invocation' } } };
}
function applyReview(s, gh, revise) {
  const request = reviewInput(s, gh, revise);
  const r = refresh(request, { client: gh.client() });
  assert.equal(r.status, 'verified', JSON.stringify(r));
  s.payload = request.payload; s.c = s.payload.candidates[0];
  return request;
}
function selectExisting(c, gh, issue, action = 'existing issue') {
  c.action = action; c.issueUrl = issue.html_url; c.title = issue.title;
  c.body = ''; c.comment = ''; c.metadata = []; c.allowedActions = [action];
  c.duplicate.issue = gh.client().issue(c.issueUrl);
  c.duplicate.comments = gh.client().comments(c.issueUrl);
}
test('unrelated search changes and edited duplicate text resume through reviewed observations', t => {
  for (const existingTarget of [false, true]) {
    const s = setup(t), gh = new FakeGh();
    if (existingTarget) { const x = existing(s, gh, 'existing issue'); x.title = 'Updated title'; x.body = 'Same maintenance outcome, clarified'; }
    else gh.addIssue('Unrelated outcome');
    assert.equal(record(input(s), { client: gh.client() }).status, 'needs-review');
    assert.equal(gh.writes().length, 0);
    const request = applyReview(s, gh);
    assert.equal(refresh(request, { client: gh.client() }).status, 'verified');
    assert.equal(record(input(s), { client: gh.client() }).status, 'verified');
    assert.equal(gh.writes().length, existingTarget ? 0 : 1);
    const ledger = JSON.parse(readFileSync(s.statePath));
    assert.equal(ledger.history[0].previousHash, hash(request.previousPayload));
    assert.deepEqual(ledger.history[0].previousPayload, request.previousPayload);
  }
});
test('new matching duplicate routes to one missing-content comment instead of creation', t => {
  const s = setup(t), gh = new FakeGh(), x = gh.addIssue('Matching outcome missing retained evidence');
  assert.equal(record(input(s), { client: gh.client() }).status, 'needs-review');
  applyReview(s, gh, c => { selectExisting(c, gh, x, 'duplicate comment'); c.comment = 'Retained evidence needed by implementer'; });
  assert.equal(record(input(s), { client: gh.client() }).status, 'verified');
  assert.equal(gh.issues.size, 1); assert.equal(gh.comments.length, 1);
  assert.equal(record(input(s), { client: gh.client() }).status, 'verified');
  assert.equal(gh.comments.length, 1);
});
test('independently completed thread becomes existing issue without another comment', t => {
  const s = setup(t), gh = new FakeGh(), x = existing(s, gh, 'duplicate comment');
  s.c.comment = 'Previously missing evidence';
  gh.comments.push({ id: 1, html_url: `${x.html_url}#issuecomment-1`, body: s.c.comment, user: { login: 'other' } });
  assert.equal(record(input(s), { client: gh.client() }).status, 'needs-review');
  applyReview(s, gh, c => selectExisting(c, gh, x));
  assert.equal(record(input(s), { client: gh.client() }).status, 'verified');
  assert.equal(gh.writes().length, 0);
});
test('closed duplicate routes to another open issue or creates the retained handoff', t => {
  for (const replacement of [false, true]) {
    const s = setup(t), gh = new FakeGh(), x = existing(s, gh, 'existing issue'); x.state = 'closed';
    const other = replacement ? gh.addIssue('Same outcome') : null;
    gh.search = other ? [other] : [];
    assert.equal(record(input(s), { client: gh.client() }).status, 'needs-review');
    applyReview(s, gh, c => {
      if (other) selectExisting(c, gh, other);
      else { c.action = 'new issue'; c.issueUrl = null; c.title = 'Retained work'; c.body = 'Retained complete handoff'; c.allowedActions = ['new issue']; }
    });
    assert.equal(record(input(s), { client: gh.client() }).status, 'verified');
    assert.equal(gh.writes().length, replacement ? 0 : 1);
  }
});
test('verified creation and comments survive refresh without duplicate writes or target changes', t => {
  for (const comment of [false, true]) {
    const s = setup(t), gh = new FakeGh();
    if (comment) { existing(s, gh, 'duplicate comment'); s.c.comment = 'Exact handoff'; }
    assert.equal(record(input(s), { client: gh.client() }).status, 'verified');
    const ledger = JSON.parse(readFileSync(s.statePath)), writes = gh.writes().length;
    gh.addIssue('Another result');
    assert.equal(record(input(s), { client: gh.client() }).status, 'needs-review');
    const request = reviewInput(s, gh);
    const invalid = structuredClone(request); invalid.payload.candidates[0].title = 'Different publication';
    assert.throws(() => refresh(invalid, { client: gh.client() }), /Completed operations/);
    applyReview(s, gh);
    assert.equal(record(input(s), { client: gh.client() }).status, 'verified');
    assert.equal(gh.writes().length, writes);
    assert.deepEqual(JSON.parse(readFileSync(s.statePath)).candidates.candidate.ops, ledger.candidates.candidate.ops);
  }
});
test('refresh rejects uncertain writes, expanded scope, metadata, or changed latest observations', t => {
  const s = setup(t), gh = new FakeGh(); gh.addIssue('Unrelated');
  assert.equal(record(input(s), { client: gh.client() }).status, 'needs-review');
  const request = reviewInput(s, gh);
  const bad = structuredClone(request); bad.payload.candidates[0].revision = 'b'.repeat(40);
  assert.throws(() => refresh(bad, { client: gh.client() }), /investigation/);
  const old = readFileSync(s.statePath, 'utf8');
  gh.addIssue('More drift'); const drift = refresh(request, { client: gh.client() });
  assert.equal(drift.status, 'needs-review'); assert.equal(drift.duplicateReview.issues.length, 2);
  assert.equal(readFileSync(s.statePath, 'utf8'), old);
  gh.issues.delete(2);
  const ledger = JSON.parse(old); ledger.candidates.candidate.ops.create = { status: 'uncertain', receipt: null }; save(s.statePath, ledger);
  assert.throws(() => refresh(request, { client: gh.client() }), /Reconcile uncertain/);
  assert.equal(gh.writes().length, 0);
});
test('unavailable reads and account or source changes stay blocked despite duplicate drift', t => {
  for (const cause of ['search','identity','source']) {
    const s = setup(t), gh = new FakeGh(); gh.addIssue('New result');
    if (cause === 'search') gh.unavailable = args => args.some(x => x.startsWith('search/issues'));
    if (cause === 'identity') gh.account = 'other';
    if (cause === 'source') { s.c.source = { head: gh.pr.head.sha, number: 5, url: gh.pr.html_url, threadId: 'thread' }; gh.pr.head.sha = 'b'.repeat(40); }
    const r = record(input(s), { client: gh.client() });
    assert.equal(r.status, 'blocked'); assert.equal(gh.writes().length, 0);
  }
});

test('refresh preserves completed image attachments without reuploading', t => {
  const s = setup(t), gh = new FakeGh(); approvedImage(s);
  assert.equal(record(input(s), { client: gh.client() }).status, 'verified');
  const before = JSON.parse(readFileSync(s.statePath)), writes = gh.writes().length;
  gh.addIssue('Unrelated result');
  assert.equal(record(input(s), { client: gh.client() }).status, 'needs-review');
  applyReview(s, gh);
  assert.equal(record(input(s), { client: gh.client() }).status, 'verified');
  assert.equal(gh.writes().length, writes);
  assert.deepEqual(JSON.parse(readFileSync(s.statePath)).candidates.candidate.attachments, before.candidates.candidate.attachments);
});
test('refresh rejects unaudited metadata and changed approved images before updating ledger', t => {
  const s = setup(t), gh = new FakeGh(); label(s); approvedImage(s); gh.addIssue('Unrelated');
  assert.equal(record(input(s), { client: gh.client() }).status, 'needs-review');
  const request = reviewInput(s, gh), before = readFileSync(s.statePath, 'utf8');
  const badMetadata = structuredClone(request); badMetadata.payload.candidates[0].metadata[0].value = 'other';
  assert.throws(() => refresh(badMetadata, { client: gh.client() }), /expand audited metadata/);
  const badImage = structuredClone(request); badImage.payload.candidates[0].images[0].approval = 'Replacement approval';
  assert.throws(() => refresh(badImage, { client: gh.client() }), /approved images/);
  assert.equal(readFileSync(s.statePath, 'utf8'), before); assert.equal(gh.writes().length, 0);
});
test('refresh keeps other candidates unchanged and preserves their completed ledger state', t => {
  const s = setup(t), gh = new FakeGh(); gh.search = [];
  const second = structuredClone(s.c); second.id = 'second'; second.title = 'Other candidate'; s.payload.candidates.push(second);
  assert.equal(record(input(s), { client: gh.client() }).status, 'verified');
  const before = JSON.parse(readFileSync(s.statePath)).candidates.second, writes = gh.writes().length;
  gh.search = [gh.addIssue('New search result')];
  assert.equal(record(input(s), { client: gh.client() }).status, 'needs-review');
  const request = reviewInput(s, gh), invalid = structuredClone(request);
  invalid.payload.candidates[1].title = 'Unauthorized other candidate edit';
  assert.throws(() => refresh(invalid, { client: gh.client() }), /another candidate/);
  applyReview(s, gh);
  assert.deepEqual(JSON.parse(readFileSync(s.statePath)).candidates.second, before);
  assert.equal(record(input(s), { client: gh.client() }).outcomes[0].status, 'verified');
  assert.equal(gh.writes().length, writes);
});
