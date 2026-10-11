#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, text, version, hash, readJson, save, lock, outside, result } from '../../add-issue/scripts/common.mjs';
import { target } from '../../add-issue/scripts/payload.mjs';
import { GitHub, resolveScope, authorship, threadFingerprint } from './github.mjs';
import { summarize, successfulActions as successful } from './summary.mjs';

const outcomes = [...successful,'prepared','fixed','unconfirmed','failed'];
const now = () => new Date().toISOString();
function artifact(path, input) {
  for (const repo of [input.checkout, ...(input.privateOutside ?? [])].filter(Boolean)) outside(path,repo);
}
function issueUrl(url, t) {
  const u = new URL(text(url,'verified issue URL'));
  check(u.protocol === 'https:' && u.host === t.host && new RegExp(`^/${t.repo.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/issues/[1-9]\\d*$`).test(u.pathname) && !u.search && !u.hash, 'Issue target mismatch');
}
function findPr(s, number) { const p = s.prs.find(p => p.number === number); check(p,'PR outside snapshot'); return p; }
function sourceCheck(s, source, client) {
  const p = findPr(s,source.number);
  if (p.blocked) return result('blocked',[p.blocked]);
  try {
    const current = client.pr(p.number);
    if (current.head !== p.head || !current.merged) { p.blocked = 'Source PR head or merged state changed'; return result('blocked',[p.blocked]); }
  } catch { p.blocked = 'Source PR head/merged state cannot be verified'; return result('blocked',[p.blocked]); }
  if (source.threadId !== null) {
    try {
      const t = client.thread(source.threadId,p);
      if (source.id) {
        const finding = t.comments.nodes.find(c => c.id === source.id || c.databaseId === source.databaseId);
        if (!finding || finding.body !== source.body || authorship(finding.author).status !== 'codex') return result('blocked',['Source finding identity/content changed or unavailable']);
      }
      if (t.isResolved) return result('blocked',['Source thread is now resolved'],{skip:true,thread:t});
      return result('verified',[],{thread:t});
    } catch { return result('blocked',['Source thread state cannot be verified']); }
  }
  return result('verified');
}
function sourceKey(x) { return `${x.number}/${x.kind}/${x.id}`; }
export function initialize(input, client) {
  version(input); const selectionStartedAt = now(); const scope = resolveScope(input); target(scope.target);
  const gh = client ?? new GitHub(scope.target,{maxPages:input.maxPages ?? 10000});
  const account = gh.identity(); text(account,'authenticated account');
  const repo = gh.repository(); check(repo.full_name.toLowerCase() === scope.target.repo.toLowerCase(), 'Repository target mismatch');
  scope.target.repo = repo.full_name; gh.target = scope.target;
  const selected = scope.numbers.length ? scope.numbers : gh.merged(selectionStartedAt);
  check(new Set(selected).size === selected.length, 'Duplicate PR inventory');
  const prs = [], excluded = [];
  // Do not persist a runnable scope if any selected PR metadata is incomplete.
  for (const n of selected) { const p = gh.pr(n); (p.merged ? prs : excluded).push(p); }
  text(input.authorization?.request,'original human request'); text(input.authorization?.origin,'authorization origin');
  check(typeof input.authorization?.trusted === 'boolean' && typeof input.draftOnly === 'boolean', 'Missing authorization/restrictions');
  return {version:1,runId:input.runId ?? randomUUID(),createdAt:now(),selectionStartedAt,account,target:scope.target,scope:input.scope ?? null,authorization:input.authorization,
    draftOnly:input.draftOnly,restrictions:input.restrictions ?? {},checkout:input.checkout ?? null,privateOutside:input.privateOutside ?? [],maxPages:input.maxPages ?? 10000,prs,excluded,candidates:[],resolutions:{},trackingSummaries:{}};
}
function collect(s,input,client) {
  const p = findPr(s,input.number), gate = sourceCheck(s,{number:p.number,threadId:null},client); if (!gate.complete) return gate;
  const collection = {at:now(),gaps:[],reviews:[],comments:[],conversations:[],threads:[],sources:[],skippedResolved:[],uncertainAuthors:[]};
  const observe = (key,fn) => { try { collection[key] = fn(); } catch (e) { collection.gaps.push({resource:key,reason:e.message}); } };
  observe('reviews',() => client.list(`${client.prefix}/pulls/${p.number}/reviews`));
  observe('comments',() => client.list(`${client.prefix}/pulls/${p.number}/comments`));
  observe('conversations',() => client.list(`${client.prefix}/issues/${p.number}/comments`));
  observe('threads',() => client.threads(p));
  for (const t of collection.threads) if (t.isResolved) collection.skippedResolved.push(t.id);
  const add = (raw,kind,thread) => {
    const identity = authorship(raw.user ?? raw.author,raw.performed_via_github_app ?? null);
    if (identity.status === 'uncertain') collection.uncertainAuthors.push({kind,id:raw.node_id ?? raw.id,authorship:identity});
    if (identity.status !== 'codex' || thread?.isResolved) return;
    const id = String(raw.node_id ?? raw.id);
    collection.sources.push({key:sourceKey({number:p.number,kind,id}),number:p.number,kind,id,databaseId:raw.databaseId ?? raw.id,
      url:raw.html_url ?? raw.url,body:raw.body ?? '',authorship:identity,head:p.head,reviewRevision:raw.original_commit_id ?? raw.originalCommit?.oid ?? raw.commit_id ?? null,
      gaps:(raw.original_commit_id ?? raw.originalCommit?.oid ?? raw.commit_id) ? [] : ['Original review revision unavailable'],
      reviewId:raw.pull_request_review_id ?? raw.pullRequestReview?.id ?? (kind === 'review' ? id : null),threadId:thread?.id ?? null,
      threadUrl:thread ? thread.comments.nodes[0]?.url ?? null : null,resolved:thread ? thread.isResolved : null,outdated:thread?.isOutdated ?? null,
      anchor:{path:raw.path ?? thread?.path ?? null,line:raw.line ?? thread?.line ?? null,originalLine:raw.original_line ?? raw.originalLine ?? null,diffHunk:raw.diff_hunk ?? raw.diffHunk ?? null}});
  };
  for (const r of collection.reviews) add(r,'review',null);
  // Use REST app/author metadata where available, with GraphQL thread identity/state.
  for (const t of collection.threads) if (!t.isResolved) for (const c of t.comments.nodes) {
    const rest = collection.comments.find(x => x.node_id === c.id || x.id === c.databaseId);
    add({...c,...rest},'comment',t);
  }
  const matched = new Set(collection.threads.flatMap(t => t.comments.nodes.flatMap(c => [c.databaseId,c.id])));
  for (const c of collection.comments) if (!matched.has(c.id) && !matched.has(c.node_id)) {
    // No thread state means no eligible inline source, even with established authorship.
    if (authorship(c.user,c.performed_via_github_app).status === 'codex') collection.gaps.push({resource:'threadMapping',commentId:c.id,reason:'Inline comment resolution state unavailable'});
  }
  collection.complete = collection.gaps.length === 0;
  const prior = p.collection;
  p.collection = collection;
  // Assessments are tied to complete comment inventories; new replies require reassessment.
  for (const t of collection.threads) {
    const previous = prior?.threads.find(x => x.id === t.id);
    if (previous?.assessment && threadFingerprint(previous) === threadFingerprint(t)) t.assessment = previous.assessment;
  }
  const after = sourceCheck(s,{number:p.number,threadId:null},client);
  return after.complete ? result(collection.complete ? 'verified' : 'blocked',collection.gaps.map(x => x.reason),{collection}) : after;
}
function register(s,input) {
  text(input.candidateId,'candidate ID'); const sources = input.sourceKeys;
  check(Array.isArray(sources) && sources.length,'Missing source keys');
  let c = s.candidates.find(c => c.id === input.candidateId);
  if (!c) { text(input.judgment,'candidate judgment'); c = {id:input.candidateId,judgment:input.judgment,sources:[],handoffs:[],outcome:null}; s.candidates.push(c); }
  for (const key of sources) {
    const source = s.prs.flatMap(p => p.collection?.sources ?? []).find(x => x.key === key);
    check(source,'Source not in collected Codex inventory');
    const pr = findPr(s,source.number);
    check(!pr.blocked,'PR processing stopped');
    check(!pr.sourceAssessments?.[key] || pr.sourceAssessments[key].body !== source.body,'Source already classified as excluded');
    check(source.threadId === null || pr.collection.threads.some(t => t.id === source.threadId && !t.isResolved),'Source resolved or unavailable');
    const owner = s.candidates.find(other => other.id !== c.id && other.sources.some(x => x.key === key));
    // Multiple independent bugs may share a comment; require an explicit explanation.
    if (owner) { text(input.partitionEvidence,'independent candidate partition evidence'); c.partitionEvidence = input.partitionEvidence; }
    if (!c.sources.some(x => x.key === key)) { c.sources.push(structuredClone(source));
      const t = pr.collection.threads.find(t => t.id === source.threadId); if (t) delete t.assessment;
    }
  }
  return result('verified',[],{candidate:c});
}
function assess(s,input) {
  if (input.sourceKey) {
    const p = s.prs.find(p => p.collection?.sources.some(x => x.key === input.sourceKey));
    check(p,'Unknown collected source');
    check(!s.candidates.some(c => c.sources.some(x => x.key === input.sourceKey)),'Registered Bug sources cannot be excluded');
    check(['not-bug','resolved-copy','non-finding'].includes(input.disposition),'Invalid source exclusion');
    text(input.reason,'source exclusion reason');
    if (input.disposition === 'resolved-copy') check(p.collection.threads.some(t => t.id === input.threadId && t.isResolved),'Resolved-copy requires an inventoried resolved source thread');
    (p.sourceAssessments ??= {})[input.sourceKey] = {disposition:input.disposition,reason:input.reason,threadId:input.threadId ?? null,body:p.collection.sources.find(x => x.key === input.sourceKey).body};
    return result('verified');
  }
  const p = findPr(s,input.number), t = p.collection?.threads.find(t => t.id === input.threadId);
  check(t && !t.isResolved && p.collection.complete,'Complete unresolved thread inventory required');
  check(Array.isArray(input.items) && input.items.length,'Classify every in-scope item'); text(input.evidence,'classification completeness evidence');
  for (const item of input.items) {
    check(t.comments.nodes.some(x => x.id === item.commentId),'Assessment comment outside thread');
    if (item.candidateId) check(s.candidates.some(c => c.id === item.candidateId && c.sources.some(x => x.threadId === t.id && x.id === item.commentId)),'Candidate not bound to assessed comment');
    else { check(['not-bug','resolved-copy','non-finding','human-evidence'].includes(item.disposition),'Invalid excluded item'); text(item.reason,'exclusion reason'); }
  }
  for (const c of t.comments.nodes) check(input.items.some(x => x.commentId === c.id),'Unclassified thread comment');
  for (const c of s.candidates.filter(c => c.sources.some(x => x.threadId === t.id))) check(input.items.some(x => x.candidateId === c.id),'Unclassified registered candidate');
  t.assessment = {items:input.items,evidence:input.evidence,fingerprint:threadFingerprint(t)};
  return result('verified');
}
function preflight(s,input,client,pendingOnly=false) {
  const c = s.candidates.find(c => c.id === input.candidateId); check(c,'Unknown candidate');
  const required = pendingOnly && c.outcome?.verified && successful.includes(c.outcome.action) ? c.sources.filter(x => !c.outcome.confirmedSourceKeys.includes(x.key)) : c.sources;
  const observations = required.map(source => ({key:source.key,...sourceCheck(s,source,client)}));
  return result(observations.every(x => x.complete) ? 'verified' : 'blocked',observations.flatMap(x => x.errors),{observations});
}
function handoff(s,input,client) {
  const c = s.candidates.find(c => c.id === input.candidateId); check(c,'Unknown candidate');
  if (c.outcome && successful.includes(c.outcome.action) && c.sources.every(x => c.outcome.confirmedSourceKeys.includes(x.key))) return result('verified',[],{resume:'resolution-only',outcome:c.outcome,pendingConfirmation:[]});
  const gate = preflight(s,input,client,true); if (!gate.complete) return gate;
  if (c.outcome && successful.includes(c.outcome.action)) return result('verified',[],{resume:'resolution-only',outcome:c.outcome,pendingConfirmation:c.sources.filter(x => !c.outcome.confirmedSourceKeys.includes(x.key)).map(x => x.key)});
  if (c.outcome?.action === 'prepared') return result('verified',[],{resume:'recording-only',payload:c.outcome.payload,outcome:c.outcome});
  check(['default','plan'].includes(input.mode),'Missing current mode');
  const source = c.sources.find(x => x.key === input.sourceKey) ?? (c.sources.length === 1 ? c.sources[0] : null); check(source,'Select exact investigation sourceKey');
  const payload = {version:1,skill:'add-issue',runId:s.runId,target:s.target,authorization:s.authorization,scope:s.prs.map(p => ({number:p.number,url:p.url,head:p.head})),
    mode:input.mode,restrictions:{...s.restrictions,draftOnly:s.draftOnly || s.restrictions.draftOnly === true,noImplementation:true,noCodeChanges:true,noRepair:true},candidateId:c.id,judgment:c.judgment,
    investigationRevision:source.head,source,sources:c.sources,evidence:input.evidence ?? null,requiredPreconditions:c.sources.map(x => ({number:x.number,head:x.head,merged:true,threadId:x.threadId,resolved:x.resolved})),
    requirement:'Confirm Bug at investigationRevision before recording. Collect Review owns thread resolution.'};
  text(input.evidence,'supporting/contradicting evidence and gaps');
  const entry = {sourceKey:source.key,at:now(),payload,hash:hash(payload)};
  if (!c.handoffs.some(x => x.hash === entry.hash)) c.handoffs.push(entry);
  return result('verified',[],{handoff:entry});
}
function outcome(s,input) {
  const c = s.candidates.find(c => c.id === input.candidateId); check(c,'Unknown candidate');
  check(outcomes.includes(input.action),'Invalid Add Issue outcome'); text(input.evidence,'Add Issue verification evidence');
  if (c.outcome && successful.includes(c.outcome.action)) {
    check(input.action === c.outcome.action && input.issueUrl === c.outcome.issueUrl,'Completed issue outcome cannot be replaced');
  }
  if (successful.includes(input.action)) {
    check(input.verified === true,'Successful outcome requires verified Add Issue result'); issueUrl(input.issueUrl,s.target);
    check(c.handoffs.length,'No retained handoff');
    check(Array.isArray(input.confirmedSourceKeys) && c.sources.every(x => input.confirmedSourceKeys.includes(x.key)) && input.confirmedSourceKeys.every(key => c.sources.some(x => x.key === key)), 'Confirm defect/outcome applicability at every reported source/head');
    if (c.outcome && successful.includes(c.outcome.action)) {
      c.outcome.confirmedSourceKeys = [...new Set([...c.outcome.confirmedSourceKeys,...input.confirmedSourceKeys])];
      (c.outcome.reconciliations ??= []).push({evidence:input.evidence,at:now()});
      return result('verified',[],{outcome:c.outcome});
    }
  }
  if (input.action === 'prepared') check(input.payload && typeof input.payload === 'object','Retain exact Add Issue recording payload');
  c.outcome = {action:input.action,verified:input.verified === true,issueUrl:input.issueUrl ?? null,evidence:input.evidence,confirmedSourceKeys:input.confirmedSourceKeys ?? [],payload:input.payload ?? null,at:now()};
  return result('verified',[],{outcome:c.outcome});
}
function resolutionGate(s,input,client) {
  const p = findPr(s,input.number), t = p.collection?.threads.find(t => t.id === input.threadId);
  check(t,'Unknown source thread');
  const gate = sourceCheck(s,{number:p.number,threadId:t.id},client);
  if (gate.skip) return result('verified',[],{alreadyResolved:true,thread:gate.thread});
  if (!gate.complete) return gate;
  check(p.collection.complete && t.assessment,'Complete collection and full thread assessment required');
  check(threadFingerprint(gate.thread) === t.assessment.fingerprint,'Source thread changed; recollect and reassess');
  const ids = [...new Set(t.assessment.items.map(x => x.candidateId).filter(Boolean))];
  check(ids.length,'No handled Bug candidates in thread');
  for (const id of ids) {
    const c = s.candidates.find(c => c.id === id);
    check(c?.outcome?.verified && successful.includes(c.outcome.action),'Thread has pending, fixed, unconfirmed or failed items');
    check(c.sources.filter(x => x.threadId === t.id).every(x => c.outcome.confirmedSourceKeys.includes(x.key)),'Unconfirmed repeated report');
  }
  return result('verified',[],{thread:gate.thread});
}
function resolveThread(s,input,client,persist,reconcileOnly=false) {
  const key = `${input.number}/${input.threadId}`;
  const gate = resolutionGate(s,input,client); if (!gate.complete) return gate;
  if (gate.alreadyResolved) {
    s.resolutions[key] = {...s.resolutions[key],status:'verified',reconciled:true,at:now()}; persist(); return result('verified',[],{resolution:s.resolutions[key]});
  }
  if (s.resolutions[key]?.status === 'verified') return result('blocked',['Previously verified thread is unresolved; no automatic new write']);
  if (reconcileOnly || s.resolutions[key]) return result('uncertain',['Thread remains unresolved; prior attempt is not automatically repeated']);
  check(input.context?.mode === 'default' && !s.draftOnly && !s.restrictions?.draftOnly && !s.restrictions?.diagnosisOnly && s.authorization.trusted && input.context.trustedAuthorization === true && input.context.resolutionAuthorized === true,'Resolution requires trusted current authorization, Default mode and no draft-only restriction');
  text(input.context.evidence,'current authorization evidence');
  check(gate.thread.viewerCanResolve === true,'Current authenticated viewer cannot resolve intended thread');
  check(client.identity() === s.account,'Authenticated account changed or unavailable');
  // Account verification precedes one final source/head/thread check.
  const finalGate = resolutionGate(s,input,client); if (!finalGate.complete) return finalGate;
  if (finalGate.alreadyResolved) { s.resolutions[key] = {status:'verified',reconciled:true,at:now()}; persist(); return result('verified'); }
  check(finalGate.thread.viewerCanResolve === true,'Current authenticated viewer cannot resolve intended thread');
  s.resolutions[key] = {status:'uncertain',startedAt:now()}; persist();
  try {
    const response = client.resolve(input.threadId);
    check(response?.id === input.threadId && response.isResolved === true,'Mutation did not confirm intended thread');
  } catch { /* Read back even after a lost response; never repeat the mutation here. */ }
  const p = findPr(s,input.number);
  try {
    const observed = client.thread(input.threadId,p);
    if (observed.isResolved) { s.resolutions[key].status = 'verified'; s.resolutions[key].verifiedAt = now(); }
  } catch { /* Preserve uncertain attempt. */ }
  persist(); return result(s.resolutions[key].status,s.resolutions[key].status === 'verified' ? [] : ['Resolution outcome uncertain'],{resolution:s.resolutions[key]});
}
export function dispatch(command,s,input,client,persist=()=>{}) {
  if (command === 'collect') return collect(s,input,client);
  if (command === 'candidate') return register(s,input);
  if (command === 'assess') return assess(s,input);
  if (command === 'preflight') return preflight(s,input,client);
  if (command === 'handoff') return handoff(s,input,client);
  if (command === 'outcome') return outcome(s,input);
  if (command === 'resolve' || command === 'reconcile') return resolveThread(s,input,client,persist,command === 'reconcile');
  if (command === 'summary' || command === 'reconcile-summary') return summarize(s,input,client,persist,command === 'reconcile-summary');
  if (command === 'report') {
    const gaps = s.prs.flatMap(p => !p.collection ? [{number:p.number,reason:'Not collected'}] : p.collection.gaps.map(x => ({number:p.number,...x})));
    const summaries = s.prs.map(p => {
      let status;
      if (!p.collection) status = 'not-collected';
      else if (!p.collection.complete) status = 'incomplete';
      else if (!p.collection.reviews.some(r => authorship(r.user,r.performed_via_github_app).status === 'codex') && !p.collection.sources.length) status = p.collection.uncertainAuthors.length ? 'authorship-uncertain' : 'no-codex-reviews';
      else if (!p.collection.sources.length) status = 'no-unresolved-codex-sources';
      else {
        const classified = key => p.sourceAssessments?.[key]?.body === p.collection.sources.find(x => x.key === key)?.body || s.candidates.some(c => c.sources.some(x => x.key === key));
        if (p.collection.sources.some(x => !classified(x.key))) status = 'sources-awaiting-classification';
        else if (!s.candidates.some(c => c.sources.some(x => x.number === p.number))) status = 'no-unresolved-bug-candidates';
        else status = 'candidates-tracked';
      }
      return {number:p.number,head:p.head,blocked:p.blocked ?? null,status,trackingComment:s.trackingSummaries?.[p.number] ?? null};
    });
    return result(gaps.length || s.prs.some(p => p.blocked) ? 'blocked' : 'verified',gaps.map(x => x.reason),{run:s,coverage:gaps,summaries,trackingComments:s.trackingSummaries ?? {},
      meaning:'complete describes collection coverage only, not candidate handling or absence of bugs'});
  }
  throw new Error('Unknown command');
}
export function main(args, injectedClient) {
  const [command,path,output] = args;
  if (command === '--help') return {help:'node collect-review.mjs init|collect|candidate|assess|preflight|handoff|outcome|resolve|reconcile|summary|reconcile-summary|report /absolute/input.json [/absolute/output.json]'};
  check(path && args.length <= 3,'Expected command and absolute JSON input'); const input = readJson(path); version(input);
  check(input.statePath,'Missing private statePath'); artifact(input.statePath,input); if (output) { check(resolve(output) !== resolve(input.statePath) && resolve(output) !== resolve(path),'Output must not overwrite input or ledger'); artifact(output,input); }
  const release = lock(input.statePath); check(release,'Ledger locked; reconcile interrupted owner before removing its lock');
  let s;
  try {
    if (command === 'init') {
      check(!existsSync(input.statePath),'Run already exists; use retained snapshot'); s = initialize(input,injectedClient);
      artifact(input.statePath,s); if (output) artifact(output,s); save(input.statePath,s);
      const value = result('verified',[],{runId:s.runId,prs:s.prs,excluded:s.excluded}); if (output) save(output,value); return output ? result('verified',[],{output}) : value;
    }
    s = readJson(input.statePath); version(s); artifact(input.statePath,s); if (output) artifact(output,s);
    const client = injectedClient ?? new GitHub(s.target,{maxPages:s.maxPages});
    const working = ['candidate','assess','outcome'].includes(command) ? structuredClone(s) : s;
    const value = dispatch(command,working,input,client,() => save(input.statePath,working)); s = working; save(input.statePath,s);
    if (output) { save(output,value); return result(value.status,value.errors,{output}); } return value;
  } catch (e) { if (s) save(input.statePath,s); throw e; }
  finally { release(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const value = main(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(value,null,2)}\n`); if (value.complete === false) process.exitCode = value.status === 'uncertain' ? 3 : 2; }
  catch (e) { process.stdout.write(`${JSON.stringify(result('failed',[e.message]))}\n`); process.exitCode = 1; }
}
