import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, dispatch, main } from './collect-review.mjs';
import { GitHub, authorship, resolveScope } from './github.mjs';
import { summaryMarker } from './summary.mjs';
const target = {host:'github.com',repo:'owner/repo'}, head = 'a'.repeat(40);
const bot = {login:'chatgpt-codex-connector[bot]',type:'Bot',id:123};
const pr = {number:1,url:'https://github.com/owner/repo/pull/1',head,merged:true,nodeId:'PR1'};
const comment = id => ({id,databaseId:id==='C1'?1:2,url:`${pr.url}#discussion_r${id==='C1'?1:2}`,body:'Reported behavior',author:{__typename:'Bot',login:'chatgpt-codex-connector',id:'BOT'},originalCommit:{oid:head},path:'src.js',line:2});
const thread = () => ({id:'T1',pullRequest:{url:pr.url},isResolved:false,isOutdated:true,viewerCanResolve:true,comments:{nodes:[comment('C1')],pageInfo:{hasNextPage:false,endCursor:null}}});
class Fake {
  constructor() { this.target=target; this.prefix='repos/owner/repo'; this.current={...pr}; this.t=thread(); this.writes=0; this.summaryComments=[]; this.commentWrites=[]; }
  identity() { return this.account ?? 'tester'; }
  repository() { return {full_name:target.repo}; }
  merged() { return [1,2]; }
  pr(n) { if(this.failPr) throw Error('Unavailable'); return {...this.current,number:n,url:`https://github.com/owner/repo/pull/${n}`,merged:n===2?false:this.current.merged}; }
  list(endpoint) {
    if(this.failResource && endpoint.includes(this.failResource)) throw Error('Incomplete list');
    if(endpoint.includes('/reviews')) return [{node_id:'R1',id:1,html_url:`${pr.url}#pullrequestreview-1`,body:'Review finding',user:bot,commit_id:null}];
    if(endpoint.includes('/pulls/') && endpoint.includes('/comments')) return [{node_id:'C1',id:1,html_url:comment('C1').url,body:'Reported behavior',user:bot,commit_id:head}];
    return [{id:8,body:'Human evidence',user:{type:'User',login:'human'}}];
  }
  threads() { return [structuredClone(this.t)]; }
  thread(id,p) { assert.equal(id,'T1'); assert.equal(p.url,pr.url); if(this.failThread) throw Error('No state'); return structuredClone(this.t); }
  resolve(id) { assert.equal(id,'T1'); this.writes++; if(!this.noEffect) this.t.isResolved=true; if(this.loseResponse) throw Error('Lost response'); return {id,isResolved:true}; }
  prComments(number) {
    assert.equal(number,1);
    if(this.failSummaryRead || this.failSummaryReadback && this.commentWrites.length) throw Error('Comment read unavailable');
    return structuredClone(this.summaryComments);
  }
  writePrComment(number,body,id) {
    assert.equal(number,1);this.commentWrites.push({number,body,id});
    if(this.summaryDefiniteFailure) { const e=Error('Comment write forbidden');e.definite=true;throw e; }
    const value={id:id ?? 100,url:`${pr.url}#issuecomment-${id ?? 100}`,body,author:'tester'};
    if(!this.summaryNoEffect) {
      if(id) Object.assign(this.summaryComments.find(c=>c.id===id),value); else this.summaryComments.push(value);
    }
    if(this.summaryLoseResponse) throw Error('Lost comment response');
    return structuredClone(value);
  }
}
const context={mode:'default',trustedAuthorization:true,resolutionAuthorized:true,summaryAuthorized:true,evidence:'Human authorized run in trusted session'};
function setup() {
  const gh = new Fake();
  const s = initialize({version:1,target,scope:[1,2],draftOnly:false,authorization:{request:'Collect reviews',origin:'human chat',trusted:true}},gh);
  dispatch('collect',s,{number:1},gh);
  return {s,gh};
}
function ready(s,gh,id='bug',key='1/comment/C1',issue=9,action='existing issue') {
  dispatch('candidate',s,{candidateId:id,sourceKeys:[key],judgment:'Root cause and behavior',partitionEvidence:'Independent behavior'},gh);
  dispatch('handoff',s,{candidateId:id,sourceKey:key,evidence:'Support, contradictions and missing evidence',mode:'default'},gh);
  dispatch('outcome',s,{candidateId:id,action,verified:true,issueUrl:`https://github.com/owner/repo/issues/${issue}`,evidence:'Verified Add Issue result',confirmedSourceKeys:[key]},gh);
}
function assess(s,gh,ids=['bug']) { dispatch('assess',s,{number:1,threadId:'T1',items:ids.map(candidateId=>({commentId:'C1',candidateId})),evidence:'Every finding and reply classified'},gh); }
const resolveInput = {number:1,threadId:'T1',context};

test('scope resolves URL, repository, checkout and excludes nonmerged PRs',()=>{
  assert.deepEqual(resolveScope({scope:['https://enterprise.test/owner/repo/pull/3',3]}),{target:{host:'enterprise.test',repo:'owner/repo'},numbers:[3]});
  assert.deepEqual(resolveScope({checkout:'/checkout'},()=>({ok:true,stdout:JSON.stringify({url:'https://github.com/owner/repo',nameWithOwner:'owner/repo'})})).target,target);
  assert.throws(()=>resolveScope({scope:['owner/repo','different/repo']}),/Mixed/);
  const {s}=setup(); assert.deepEqual(s.prs.map(p=>p.number),[1]); assert.deepEqual(s.excluded.map(p=>p.number),[2]);
});
test('incomplete snapshot cannot initialize, and later PRs do not enter retained scope',()=>{
  const gh=new Fake(); gh.merged=()=>{throw Error('Bound exhausted');};
  assert.throws(()=>initialize({version:1,target},gh),/Bound/);
  const {s}=setup(); assert.throws(()=>dispatch('collect',s,{number:3},gh),/outside snapshot/);
});
test('Codex requires API identity/type; display name and text do not establish authorship',()=>{
  assert.equal(authorship(bot).status,'codex');
  assert.equal(authorship({login:'human',type:'User',name:'Codex'}).status,'other');
  assert.equal(authorship({login:bot.login}).status,'uncertain');
  assert.equal(authorship({login:'other[bot]',type:'Bot'}).status,'uncertain');
});
test('resolved threads excluded, missing nested state is a coverage gap',()=>{
  const {s,gh}=setup(); gh.t.isResolved=true; dispatch('collect',s,{number:1},gh);
  assert.equal(s.prs[0].collection.sources.some(x=>x.threadId==='T1'),false);
  assert.deepEqual(s.prs[0].collection.skippedResolved,['T1']);
  gh.threads=()=>{throw Error('Nested replies incomplete');};
  const value=dispatch('collect',s,{number:1},gh); assert.equal(value.complete,false); assert.ok(value.collection.gaps.some(x=>x.resource==='threads'));
});
test('head change and unmerged state stop that PR permanently without selecting new revision',()=>{
  for (const change of [{head:'b'.repeat(40)},{merged:false}]) {
    const {s,gh}=setup(); ready(s,gh); Object.assign(gh.current,change);
    assert.equal(dispatch('preflight',s,{candidateId:'bug'},gh).complete,false);
    assert.equal(s.prs[0].head,head); Object.assign(gh.current,pr);
    assert.equal(dispatch('preflight',s,{candidateId:'bug'},gh).complete,false); assert.equal(gh.writes,0);
  }
});
test('unavailable thread stops candidate while other sources remain usable',()=>{
  const {s,gh}=setup(); ready(s,gh); gh.failThread=true;
  assert.equal(dispatch('preflight',s,{candidateId:'bug'},gh).complete,false); assert.equal(s.prs[0].blocked,undefined);
  assert.equal(dispatch('collect',s,{number:1},gh).complete,true);
});
test('handoff retains exact source/revision/gaps and threadless null values',()=>{
  const {s,gh}=setup(); dispatch('candidate',s,{candidateId:'body',sourceKeys:['1/review/R1'],judgment:'Distinct body bug'},gh);
  const x=dispatch('handoff',s,{candidateId:'body',evidence:'Missing review revision',mode:'plan'},gh).handoff;
  assert.equal(x.payload.investigationRevision,head); assert.equal(x.payload.source.threadId,null); assert.equal(x.payload.source.reviewRevision,null); assert.equal(x.payload.restrictions.draftOnly,false); assert.equal(x.payload.mode,'plan');
  dispatch('outcome',s,{candidateId:'body',action:'prepared',payload:{exact:'audited'},evidence:'Prepared payload'},gh);
  assert.deepEqual(s.candidates[0].outcome.payload,{exact:'audited'});
  const continued=dispatch('handoff',s,{candidateId:'body',mode:'default'},gh);
  assert.equal(continued.resume,'recording-only'); assert.deepEqual(continued.payload,{exact:'audited'}); assert.equal(s.candidates[0].handoffs.length,1);
});
test('two candidates in one comment require both successful outcomes and complete assessment',()=>{
  const {s,gh}=setup(); ready(s,gh,'one');
  dispatch('candidate',s,{candidateId:'two',sourceKeys:['1/comment/C1'],judgment:'Independent bug',partitionEvidence:'Separate cause'},gh);
  assert.throws(()=>dispatch('resolve',s,resolveInput,gh),/assessment/);
  assess(s,gh,['one','two']);
  assert.throws(()=>dispatch('resolve',s,resolveInput,gh),/pending/);
  dispatch('outcome',s,{candidateId:'two',action:'fixed',evidence:'Fixed on retained head'},gh);
  assert.throws(()=>dispatch('resolve',s,resolveInput,gh),/pending/); assert.equal(gh.writes,0);
});
test('new replies invalidate assessment and block resolution',()=>{
  const {s,gh}=setup(); ready(s,gh); assess(s,gh); gh.t.comments.nodes.push(comment('C2'));
  assert.throws(()=>dispatch('resolve',s,resolveInput,gh),/changed/); assert.equal(gh.writes,0);
});
test('Default authorization gate blocks plan, draft-only, and untrusted context',()=>{
  for (const restriction of ['plan','draft','untrusted']) {
    const {s,gh}=setup(); ready(s,gh); assess(s,gh);
    const i=structuredClone(resolveInput);
    if(restriction==='plan') i.context.mode='plan';
    if(restriction==='draft') s.draftOnly=true;
    if(restriction==='untrusted') i.context.trustedAuthorization=false;
    assert.throws(()=>dispatch('resolve',s,i,gh),/authorization/); assert.equal(gh.writes,0);
  }
});
test('lost response is reconciled by readback; successful outcome/handoff is not repeated',()=>{
  const {s,gh}=setup(); ready(s,gh); assess(s,gh); gh.loseResponse=true;
  const persisted=[];
  assert.equal(dispatch('resolve',s,resolveInput,gh,()=>persisted.push(structuredClone(s))).complete,true);
  assert.equal(persisted[0].resolutions['1/T1'].status,'uncertain');
  assert.equal(dispatch('reconcile',s,resolveInput,gh).complete,true); assert.equal(gh.writes,1);
  assert.equal(dispatch('handoff',s,{candidateId:'bug'},gh).resume,'resolution-only');
  assert.throws(()=>dispatch('outcome',s,{candidateId:'bug',action:'new issue',issueUrl:'https://github.com/owner/repo/issues/10',evidence:'Other result'},gh),/cannot be replaced/);
});
test('unresolved uncertain attempt is retained and never retried',()=>{
  const {s,gh}=setup(); ready(s,gh); assess(s,gh); gh.noEffect=true; gh.loseResponse=true;
  assert.equal(dispatch('resolve',s,resolveInput,gh).status,'uncertain');
  assert.equal(dispatch('resolve',s,resolveInput,gh).status,'uncertain');
  assert.equal(dispatch('reconcile',s,resolveInput,gh).status,'uncertain'); assert.equal(gh.writes,1);
  gh.t.isResolved=true; assert.equal(dispatch('reconcile',s,resolveInput,gh).complete,true);
});
test('already resolved thread needs no write; repeated report needs per-source confirmation',()=>{
  const {s,gh}=setup(); ready(s,gh); gh.t.isResolved=true;
  assert.equal(dispatch('resolve',s,resolveInput,gh).complete,true); assert.equal(gh.writes,0);
  assert.equal(dispatch('preflight',s,{candidateId:'bug'},gh).observations[0].skip,true);
});
test('REST and top-level/nested GraphQL pagination collect every page and reject cycles/errors',()=>{
  let restPages=0; const gh=new GitHub(target,{maxPages:3});
  gh.api=()=>++restPages===1?Array.from({length:100},(_,id)=>({id})): [{id:101}];
  assert.equal(gh.list('resource').length,101); assert.equal(restPages,2);
  const t=thread(); t.comments.pageInfo={hasNextPage:true,endCursor:'first'}; let top=0,nested=0;
  gh.graphql=(query,v)=>{
    if(query.includes('reviewThreads')) { top++; return {node:{reviewThreads:{nodes:top===1?[t]:[],pageInfo:{hasNextPage:top===1,endCursor:top===1?'next':null}}}}; }
    nested++; return {node:{comments:{nodes:[comment(nested===1?'C1':'C2')],pageInfo:{hasNextPage:nested===1,endCursor:nested===1?'cnext':null}}}};
  };
  assert.equal(gh.threads(pr)[0].comments.nodes.length,2); assert.equal(top,2); assert.equal(nested,2);
  gh.graphql=()=>({node:{comments:{nodes:[],pageInfo:{hasNextPage:true,endCursor:'same'}}}});
  assert.throws(()=>gh.connection('query',{},x=>x.node.comments),/cursor/);
  gh.graphql=()=>({}); assert.throws(()=>gh.connection('query',{},x=>x.node?.comments),/Incomplete/);
  const err=new GitHub(target,{transport:()=>({ok:true,stdout:JSON.stringify({data:{node:{}},errors:[{message:'Partial'}]})})});
  assert.throws(()=>err.graphql('query'),/GraphQL errors/);
});
test('pagination exhaustion is never reported as a complete list',()=>{
  const gh=new GitHub(target,{maxPages:1}); gh.api=()=>Array.from({length:100},()=>({})); assert.throws(()=>gh.list('x'),/bound/);
  gh.graphql=()=>({node:{comments:{nodes:[],pageInfo:{hasNextPage:true,endCursor:'next'}}}});
  assert.throws(()=>gh.connection('query',{},x=>x.node.comments),/bound/);
});
test('CLI rejects private ledger inside checkout before any API call',t=>{
  const dir=mkdtempSync(join(tmpdir(),'collect-review-test-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const repo=join(dir,'repo'); mkdirSync(repo);
  // main's input can be retained outside; a target-side state file must be rejected.
  const input=join(dir,'input.json');
  // Use the existing private writer so the file itself is also 0600.
  return import('../../add-issue/scripts/common.mjs').then(({save})=>{
    save(input,{version:1,statePath:join(repo,'ledger.json'),checkout:repo});
    assert.throws(()=>main(['init',input]),/outside/);
    assert.equal(readFileSync(input,'utf8').includes('ledger.json'),true);
  });
});

test('repeated reports append sources and reuse the completed outcome only with fresh confirmation',()=>{
  const {s,gh}=setup(); ready(s,gh); const original=s.candidates[0].outcome.issueUrl;
  dispatch('candidate',s,{candidateId:'bug',sourceKeys:['1/review/R1']},gh);
  gh.t.isResolved=true; // Completed older sources do not prevent confirming a later report.
  const x=dispatch('handoff',s,{candidateId:'bug'},gh);
  assert.equal(x.resume,'resolution-only'); assert.deepEqual(x.pendingConfirmation,['1/review/R1']);
  assert.throws(()=>dispatch('outcome',s,{candidateId:'bug',action:'existing issue',verified:true,issueUrl:original,evidence:'Reused result',confirmedSourceKeys:['1/comment/C1']},gh),/every reported/);
  dispatch('outcome',s,{candidateId:'bug',action:'existing issue',verified:true,issueUrl:original,evidence:'Defect and issue cover body report at same retained SHA',confirmedSourceKeys:['1/comment/C1','1/review/R1']},gh);
  assert.equal(s.candidates[0].handoffs.length,1); assert.equal(gh.writes,0);
  assert.deepEqual(s.candidates[0].outcome.confirmedSourceKeys,['1/comment/C1','1/review/R1']);
});
test('changed/deleted inline finding blocks handoff; unavailable PR blocks only that PR',()=>{
  const {s,gh}=setup(); ready(s,gh); gh.t.comments.nodes[0].body='Edited finding';
  assert.equal(dispatch('preflight',s,{candidateId:'bug'},gh).complete,false);
  gh.t.comments.nodes=[]; assert.equal(dispatch('preflight',s,{candidateId:'bug'},gh).complete,false);
  assert.equal(s.prs[0].blocked,undefined);
  gh.failPr=true; assert.equal(dispatch('collect',s,{number:1},gh).complete,false);
  assert.ok(s.prs[0].blocked);
});
test('CLI persists private ledgers, enforces locks and keeps failed registration transactional',async t=>{
  const {save}=await import('../../add-issue/scripts/common.mjs');
  const {statSync,existsSync}=await import('node:fs');
  const dir=mkdtempSync(join(tmpdir(),'collect-review-cli-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const repo=join(dir,'repo');mkdirSync(repo);const statePath=join(dir,'private','ledger.json'),inputPath=join(dir,'input.json'),outputPath=join(dir,'result.json'),gh=new Fake();
  const call=(command,fields={})=>{save(inputPath,{version:1,statePath,...fields});return main([command,inputPath,outputPath],gh);};
  assert.equal(call('init',{target,scope:[1],checkout:repo,draftOnly:false,authorization:{origin:'Human chat',request:'Collect reviews',trusted:true}}).complete,true);
  assert.equal(statSync(statePath).mode & 0o777,0o600);assert.equal(statSync(outputPath).mode & 0o777,0o600);
  assert.throws(()=>call('init',{target}),/already exists/);
  assert.equal(call('collect',{number:1}).complete,true);
  assert.throws(()=>call('candidate',{candidateId:'bad',sourceKeys:['1/comment/C1','missing'],judgment:'Bug'}),/not in collected/);
  assert.equal(JSON.parse(readFileSync(statePath,'utf8')).candidates.length,0);
  mkdirSync(statePath+'.lock');assert.throws(()=>call('report'),/locked/);assert.ok(existsSync(statePath+'.lock'));rmSync(statePath+'.lock',{recursive:true});
  assert.equal(call('report').complete,true);assert.equal(existsSync(statePath+'.lock'),false);
  save(inputPath,{version:1,statePath});assert.throws(()=>main(['report',inputPath,statePath],gh),/overwrite/);
});

test('fresh viewer permission and retained account prevent unauthorized resolution',()=>{
  for(const condition of ['permission','account']) {
    const {s,gh}=setup();ready(s,gh);assess(s,gh);
    if(condition==='permission') gh.t.viewerCanResolve=false; else gh.account='different';
    assert.throws(()=>dispatch('resolve',s,resolveInput,gh),condition==='permission'?/cannot resolve/:/account changed/);assert.equal(gh.writes,0);
  }
});
test('explicit empty list cannot broaden scope to every merged PR',()=>{
  assert.throws(()=>resolveScope({target,scope:[]}),/empty/);
  assert.throws(()=>resolveScope({target,scope:'99999999999999999'}),/Invalid PR/);
});

test('repository snapshot excludes PRs merged during enumeration and retains every earlier merge',()=>{
  const gh=new GitHub(target);gh.graphql=()=>({repository:{pullRequests:{nodes:[{number:1,mergedAt:'2026-10-11T00:00:00Z'},{number:2,mergedAt:'2026-10-11T01:00:00Z'}],pageInfo:{hasNextPage:false,endCursor:null}}}});
  assert.deepEqual(gh.merged('2026-10-11T00:30:00Z'),[1]);
});

test('source exclusions distinguish classified reviews without Bugs from unprocessed sources',()=>{
  const {s,gh}=setup();assert.equal(dispatch('report',s,{},gh).summaries[0].status,'sources-awaiting-classification');
  for(const source of s.prs[0].collection.sources) dispatch('assess',s,{sourceKey:source.key,disposition:'non-finding',reason:'Acknowledgment without a bug report'},gh);
  assert.equal(dispatch('report',s,{},gh).summaries[0].status,'no-unresolved-bug-candidates');
  assert.throws(()=>dispatch('candidate',s,{candidateId:'bug',sourceKeys:['1/comment/C1'],judgment:'Bug'},gh),/excluded/);
  s.prs[0].collection.sources[0].body='New finding';
  assert.equal(dispatch('report',s,{},gh).summaries[0].status,'sources-awaiting-classification');
});

const summaryInput={number:1,context};
test('PR summary groups body and inline sources, deduplicates issues and skips unchanged writes',()=>{
  const {s,gh}=setup();ready(s,gh);ready(s,gh,'body','1/review/R1');
  ready(s,gh,'another','1/comment/C1',10,'new issue');
  gh.t.isResolved=true; // Summary remains independent of completed thread resolution.
  const saved=[];
  const value=dispatch('summary',s,summaryInput,gh,()=>saved.push(structuredClone(s)));
  assert.equal(value.status,'verified');assert.equal(gh.commentWrites.length,1);assert.equal(gh.summaryComments.length,1);
  assert.equal(saved[0].trackingSummaries[1].status,'uncertain');assert.equal(saved[0].trackingSummaries[1].attempts[0].body,value.summary.body);
  assert.equal(value.summary.body.split('Tracked at https://github.com/owner/repo/issues/9').length,2);
  assert.deepEqual(value.summary.entries.find(x=>x.issueUrl.endsWith('/9')).sourceUrls,
    [`${pr.url}#discussion_r1`,`${pr.url}#pullrequestreview-1`]);
  assert.equal(value.summary.commentUrl,`${pr.url}#issuecomment-100`);
  assert.equal(dispatch('summary',s,summaryInput,gh).summary.unchanged,true);assert.equal(gh.commentWrites.length,1);
  assert.equal(dispatch('report',s,{},gh).trackingComments[1].commentUrl,value.summary.commentUrl);
  assert.equal(dispatch('report',s,{},gh).summaries[0].trackingComment.status,'verified');
});
test('later runs merge new issues into the same PR comment and preserve earlier entries',()=>{
  const {s,gh}=setup();ready(s,gh);dispatch('summary',s,summaryInput,gh);
  const fresh=initialize({version:1,target,scope:[1],draftOnly:false,authorization:s.authorization},gh);
  dispatch('collect',fresh,{number:1},gh);ready(fresh,gh,'body','1/review/R1',10,'metadata update');
  const value=dispatch('summary',fresh,summaryInput,gh);
  assert.equal(value.status,'verified');assert.equal(gh.summaryComments.length,1);assert.equal(gh.commentWrites[1].id,100);
  assert.deepEqual(value.summary.entries.map(x=>x.issueUrl).sort(),['https://github.com/owner/repo/issues/10','https://github.com/owner/repo/issues/9']);
  assert.equal(dispatch('summary',fresh,summaryInput,gh).summary.unchanged,true);assert.equal(gh.commentWrites.length,2);
  assert.equal(fresh.candidates[0].handoffs.length,1);
});
test('new source confirmation adds its review link while unconfirmed repeats are omitted',()=>{
  const {s,gh}=setup();ready(s,gh);dispatch('summary',s,summaryInput,gh);
  dispatch('candidate',s,{candidateId:'bug',sourceKeys:['1/review/R1']},gh);
  assert.equal(dispatch('summary',s,summaryInput,gh).summary.entries[0].sourceUrls.length,1);
  dispatch('outcome',s,{candidateId:'bug',action:'existing issue',verified:true,issueUrl:'https://github.com/owner/repo/issues/9',
    evidence:'Confirmed body applicability',confirmedSourceKeys:['1/comment/C1','1/review/R1']},gh);
  assert.equal(dispatch('summary',s,summaryInput,gh).summary.entries[0].sourceUrls.length,2);
  assert.equal(gh.summaryComments.length,1);assert.equal(gh.commentWrites.length,2);
});
test('summary only includes the selected PR sources and verified successful outcomes',()=>{
  for(const action of ['prepared','fixed','unconfirmed','failed']) {
    const {s,gh}=setup();dispatch('candidate',s,{candidateId:'bug',sourceKeys:['1/comment/C1'],judgment:'Bug'},gh);
    dispatch('outcome',s,{candidateId:'bug',action,payload:action==='prepared'?{exact:'payload'}:undefined,evidence:'Not recorded'},gh);
    assert.equal(dispatch('summary',s,summaryInput,gh).summary.status,'skipped');assert.equal(gh.commentWrites.length,0);
  }
  const {s,gh}=setup();ready(s,gh);s.candidates[0].outcome.verified=false;
  assert.equal(dispatch('summary',s,summaryInput,gh).summary.status,'skipped');
  s.candidates[0].outcome.verified=true;s.candidates[0].sources[0].number=3;
  assert.equal(dispatch('summary',s,summaryInput,gh).summary.status,'skipped');assert.equal(gh.commentWrites.length,0);
  assert.throws(()=>dispatch('summary',s,{number:3,context},gh),/outside snapshot/);
});
test('plan and original draft/diagnosis restrictions retain a preview without posting',()=>{
  for(const restriction of ['plan','draft','restricted-draft','diagnosis']) {
    const {s,gh}=setup();ready(s,gh);const input=structuredClone(summaryInput);
    if(restriction==='plan') input.context.mode='plan';
    if(restriction==='draft') s.draftOnly=true;
    if(restriction==='restricted-draft') s.restrictions.draftOnly=true;
    if(restriction==='diagnosis') s.restrictions.diagnosisOnly=true;
    const value=dispatch('summary',s,input,gh);
    assert.equal(value.status,'prepared');assert.ok(value.summary.body.includes('Tracked at '));assert.equal(gh.commentWrites.length,0);
    if(restriction==='plan') {
      assert.equal(dispatch('summary',s,summaryInput,gh).status,'verified');assert.equal(gh.commentWrites.length,1);
    }
  }
});
test('current summary authorization and retained account are required for writes',()=>{
  for(const restriction of ['run-untrusted','context-untrusted','not-authorized','account']) {
    const {s,gh}=setup();ready(s,gh);const input=structuredClone(summaryInput);
    if(restriction==='run-untrusted') s.authorization.trusted=false;
    if(restriction==='context-untrusted') input.context.trustedAuthorization=false;
    if(restriction==='not-authorized') input.context.summaryAuthorized=false;
    if(restriction==='account') {
      gh.account='someone-else';assert.equal(dispatch('summary',s,input,gh).status,'blocked');
    } else assert.throws(()=>dispatch('summary',s,input,gh),/authorization/);
    assert.equal(gh.commentWrites.length,0);
  }
});
test('lost create and update responses are verified by readback without duplicate comments',()=>{
  const {s,gh}=setup();ready(s,gh);gh.summaryLoseResponse=true;
  assert.equal(dispatch('summary',s,summaryInput,gh).status,'verified');
  ready(s,gh,'body','1/review/R1',10,'duplicate comment');
  assert.equal(dispatch('summary',s,summaryInput,gh).status,'verified');assert.equal(gh.summaryComments.length,1);
  assert.equal(dispatch('reconcile-summary',s,{number:1},gh).status,'verified');assert.equal(gh.commentWrites.length,2);
});
test('unavailable readback is reconciled later using reads, even with new outcomes or changed head',()=>{
  const {s,gh}=setup();ready(s,gh);gh.summaryLoseResponse=true;gh.failSummaryReadback=true;
  assert.equal(dispatch('summary',s,summaryInput,gh).status,'uncertain');assert.equal(gh.commentWrites.length,1);
  gh.failSummaryReadback=false;gh.current.head='b'.repeat(40);
  assert.equal(dispatch('reconcile-summary',s,{number:1},gh).status,'verified');assert.equal(gh.commentWrites.length,1);
  gh.current.head=head;ready(s,gh,'body','1/review/R1',10);
  assert.equal(dispatch('summary',s,summaryInput,gh).status,'verified');assert.equal(gh.commentWrites.length,2);
});
test('uncertain or failed summary writes are never automatically retried and do not repeat handoffs',()=>{
  for(const definite of [false,true]) {
    const {s,gh}=setup();ready(s,gh);gh.summaryNoEffect=true;gh.summaryLoseResponse=true;gh.summaryDefiniteFailure=definite;
    const expected=definite?'failed':'uncertain';
    assert.equal(dispatch('summary',s,summaryInput,gh).status,expected);
    assert.equal(dispatch('summary',s,summaryInput,gh).status,expected);
    assert.equal(dispatch('reconcile-summary',s,{number:1},gh).status,expected);
    assert.equal(gh.commentWrites.length,1);assert.equal(s.candidates[0].outcome.verified,true);
    assert.equal(dispatch('handoff',s,{candidateId:'bug'},gh).resume,'resolution-only');assert.equal(s.candidates[0].handoffs.length,1);
    assert.equal(dispatch('report',s,{},gh).trackingComments[1].status,expected);
  }
});
test('changed PR state and incomplete summary reads block posting',()=>{
  for(const condition of ['head','unmerged','unavailable','comments']) {
    const {s,gh}=setup();ready(s,gh);
    if(condition==='head') gh.current.head='b'.repeat(40);
    if(condition==='unmerged') gh.current.merged=false;
    if(condition==='unavailable') gh.failPr=true;
    if(condition==='comments') gh.failSummaryRead=true;
    assert.equal(dispatch('summary',s,summaryInput,gh).status,'blocked');assert.equal(gh.commentWrites.length,0);
    if(condition!=='comments') assert.ok(s.prs[0].blocked);
  }
});
test('multiple, malformed, foreign-account, edited and missing managed comments are handled safely',()=>{
  const {s,gh}=setup();ready(s,gh);dispatch('summary',s,summaryInput,gh);
  const original=structuredClone(gh.summaryComments[0]);
  gh.summaryComments.push({...original,id:101,url:`${pr.url}#issuecomment-101`});
  assert.equal(dispatch('summary',s,summaryInput,gh).status,'blocked');assert.equal(gh.commentWrites.length,1);
  gh.summaryComments=[{...original,body:`${summaryMarker}\n\nHuman edit`}];
  assert.equal(dispatch('summary',s,summaryInput,gh).status,'blocked');assert.equal(gh.commentWrites.length,1);
  gh.summaryComments=[];
  assert.equal(dispatch('summary',s,summaryInput,gh).status,'blocked');assert.equal(gh.commentWrites.length,1);
  const other=setup();ready(other.s,other.gh);other.gh.summaryComments=[{...original,author:'other-account'}];
  assert.equal(dispatch('summary',other.s,summaryInput,other.gh).status,'verified');assert.equal(other.gh.commentWrites.length,1);
});
test('summary refuses overwriting a concurrently changed comment',()=>{
  const {s,gh}=setup();ready(s,gh);dispatch('summary',s,summaryInput,gh);ready(s,gh,'body','1/review/R1',10);
  let reads=0;const read=gh.prComments.bind(gh);
  gh.prComments=number=>{if(++reads===2) gh.summaryComments[0].body+='\nEdited';return read(number);};
  assert.equal(dispatch('summary',s,summaryInput,gh).status,'blocked');assert.equal(gh.commentWrites.length,1);
});
test('PR summary transport uses paginated issue-comment endpoints and validates returned targets',()=>{
  const gh=new GitHub(target);const calls=[];
  const raw={id:100,html_url:`${pr.url}#issuecomment-100`,body:'Exact body',user:{login:'tester'}};
  gh.api=(endpoint,method,body)=>{calls.push({endpoint,method,body});return method?raw:[raw];};
  assert.equal(gh.prComments(1)[0].url,raw.html_url);
  assert.equal(gh.writePrComment(1,'Exact body').id,100);assert.equal(gh.writePrComment(1,'Exact body',100).id,100);
  assert.deepEqual(calls,[{endpoint:'repos/owner/repo/issues/1/comments?per_page=100&page=1',method:undefined,body:undefined},
    {endpoint:'repos/owner/repo/issues/1/comments',method:'POST',body:{body:'Exact body'}},
    {endpoint:'repos/owner/repo/issues/comments/100',method:'PATCH',body:{body:'Exact body'}}]);
  gh.api=()=>({...raw,html_url:'https://github.com/other/repo/pull/1#issuecomment-100'});
  assert.throws(()=>gh.writePrComment(1,'Exact body'),/target mismatch/);
});

test('reconcile-summary verifies the prior receipt without posting a newly prepared preview',()=>{
  const {s,gh}=setup();ready(s,gh);dispatch('summary',s,summaryInput,gh);ready(s,gh,'body','1/review/R1',10);
  assert.equal(dispatch('summary',s,{number:1,context:{mode:'plan'}},gh).summary.entries.length,2);
  const value=dispatch('reconcile-summary',s,{number:1},gh);
  assert.equal(value.status,'verified');assert.equal(value.summary.entries.length,1);assert.equal(gh.commentWrites.length,1);
  assert.equal(dispatch('summary',s,summaryInput,gh).summary.entries.length,2);assert.equal(gh.commentWrites.length,2);
});
test('CLI persists uncertain summary writes across restarts and recovers the receipt read-only',async t=>{
  const {save}=await import('../../add-issue/scripts/common.mjs');
  const {statSync}=await import('node:fs');
  const dir=mkdtempSync(join(tmpdir(),'collect-review-summary-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const statePath=join(dir,'ledger.json'),inputPath=join(dir,'input.json'),outputPath=join(dir,'output.json');
  const {s,gh}=setup();ready(s,gh);save(statePath,s);gh.summaryLoseResponse=true;gh.failSummaryReadback=true;
  const call=(command,fields)=>{save(inputPath,{version:1,statePath,...fields});return main([command,inputPath,outputPath],gh);};
  assert.equal(call('summary',summaryInput).status,'uncertain');
  const pending=JSON.parse(readFileSync(statePath,'utf8')).trackingSummaries[1];
  assert.equal(pending.attempts[0].status,'uncertain');assert.ok(pending.attempts[0].body.includes('Tracked at '));
  assert.equal(call('summary',summaryInput).status,'blocked');assert.equal(gh.commentWrites.length,1);
  gh.failSummaryReadback=false;
  assert.equal(call('reconcile-summary',{number:1}).status,'verified');assert.equal(gh.commentWrites.length,1);
  const observed=JSON.parse(readFileSync(statePath,'utf8')).trackingSummaries[1];
  assert.equal(observed.status,'verified');assert.equal(observed.commentUrl,`${pr.url}#issuecomment-100`);
  assert.equal(statSync(statePath).mode & 0o777,0o600);assert.equal(statSync(outputPath).mode & 0o777,0o600);
  const report=main(['report',inputPath],gh);assert.equal(report.trackingComments[1].status,'verified');
});
