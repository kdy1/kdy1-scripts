import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { repoFromUrl } from './lib/common.mjs';

const helper = fileURLToPath(new URL('./repair-pr.mjs', import.meta.url));
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'repair-workflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), bin = join(root, 'bin'), dataFile = join(root, 'data.json'), session = join(root, 'session.json');
  mkdirSync(repo); mkdirSync(bin);
  const exec = (cmd, args, cwd = repo, env = process.env) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  const git = (...args) => { const r = exec('git', args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-b', 'fix'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'file.txt'), 'initial\n'); git('add', 'file.txt'); git('commit', '-m', 'initial');
  const start = git('rev-parse', 'HEAD');
  git('remote', 'add', 'upstream', 'https://github.com/owner/repo.git');
  if (options.fork) git('remote', 'add', 'fork', 'git@github.com:alice/repo.git');
  const data = { start, remote: start, headRepo: options.fork ? 'alice/repo' : 'owner/repo', checks: [], threads: [], calls: [], ...options };
  const save = () => writeFileSync(dataFile, JSON.stringify(data)); save();
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.REPAIR_TEST_DATA;
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const a = process.argv.slice(2); d.calls.push(a); fs.writeFileSync(file, JSON.stringify(d));
const emit = v => process.stdout.write(JSON.stringify(v));
const fail = msg => { process.stderr.write(msg); process.exit(1); };
const pr = (number = 1) => d.prs?.[number] || ({number, html_url:d.prURL||'https://github.com/owner/repo/pull/'+number, state:'open', head:{ref:number===1?'fix':'upper', sha:number===1?d.remote:d.upperSha, repo:{full_name:d.headRepo}}, base:{ref:number===1?(d.base||'main'):'fix', sha:d.start, repo:{full_name:'owner/repo'}}});
if (a[0] === '--version' || a[0] === 'auth') process.exit(0);
if (a[0] === 'stack') {
 if(a[1]==='--help' && (d.catalog || d.stackInstalled)) process.exit(0);
 if(a[1]==='view' && d.stackViewError) fail(d.stackViewError);
 if(d.catalog) emit(d.catalog); else fail('unknown command "stack" for "gh"');
}
else if (a[0] === 'pr' && a[1] === 'view') emit({url:a[2]?.startsWith('https:')?a[2]:(d.prURL||'https://github.com/owner/repo/pull/1')});
else if (a[0] === 'run') { if(d.logError) fail('logs unavailable'); process.stdout.write('failed step log'); }
else if (a[0] === 'api') {
 const endpoint=a.at(-1);
 if (a.includes('graphql')) {
   const q=a.find(x=>x.startsWith('query='))||'';
   const id=a.find(x=>x.startsWith('threadId='))?.slice(9);
   if(q.includes('mutation')) {
     const th=d.threads.find(x=>x.id===id); if(!th) fail('missing thread');
     if(q.includes('addPullRequestReviewThreadReply')) {
       if(d.replyError) fail('reply transport failure');
       const body=a.find(x=>x.startsWith('body='))?.slice(5);
       th.comments.nodes.push({id:'new-reply',author:{login:'Alice'},body});
       emit({data:{addPullRequestReviewThreadReply:{comment:{id:'new-reply'}}}});
     } else { if(d.resolveError || d.resolveErrorIDs?.includes(id)) fail('resolve transport failure'); th.isResolved=true; emit({data:{resolveReviewThread:{thread:{id,isResolved:true}}}}); }
     fs.writeFileSync(file,JSON.stringify(d));
   } else if(q.includes('stack{id}')) {
     if(d.nativeStackError) fail(d.nativeStackError);
     if(d.nativeStackGraphQLError) emit({errors:[{message:d.nativeStackGraphQLError}]});
     else {
       const node={url:d.prURL||'https://github.com/owner/repo/pull/1',headRefName:'fix',headRefOid:d.remote,baseRefName:d.base||'main',baseRefOid:d.start,stack:d.nativeStack??null,...d.nativeIdentity};
       if(d.nativeStackMissing) delete node.stack;
       emit({data:{repository:{pullRequest:node}}});
     }
   } else emit({data:{viewer:{login:'Alice'},repository:{pullRequest:{reviewThreads:{nodes:d.threads,pageInfo:{hasNextPage:false}}}}}});
 } else if(/pulls\\/\\d+$/.test(endpoint)) {
   const item=pr(Number(endpoint.split('/').at(-1)));
   if(d.headChangesAfterChecks && d.calls.some(x=>x.some(v=>v.includes('/check-runs?')))) item.head.sha='b'.repeat(40);
   emit(item);
 }
 else if(endpoint.includes('/compare/')) emit({status:d.missingMerge?'diverged':'identical',merge_base_commit:{sha:d.missingMerge?'b'.repeat(40):d.start}});
 else if(endpoint.includes('/check-runs?')) {
   if(d.checksError) fail(d.checksError);
   if(d.checksRaw!==undefined) {process.stdout.write(d.checksRaw);process.exit(0);}
   const page=Number(endpoint.match(/[?&]page=(\\d+)/)?.[1]||1);
   const all=d.checkRuns??d.checks.map((c,i)=>({id:i+1,name:c.name,status:c.bucket==='pending'?'in_progress':'completed',conclusion:c.bucket==='pending'?null:(c.state||(c.bucket==='fail'?'FAILURE':'SUCCESS')).toLowerCase(),details_url:c.link||null,app:{id:1},started_at:'2026-10-11T00:00:00Z'}));
   const pages=d.checkRunsPages??[all]; emit({total_count:d.checkRunTotal??pages.flat().length,check_runs:pages[page-1]??[]});
 }
 else if(endpoint.includes('/statuses/')) {
   const page=Number(endpoint.match(/[?&]page=(\\d+)/)?.[1]||1);
   emit((d.statusesPages??[d.statuses??[]])[page-1]??[]);
 }
 else if(endpoint.includes('pulls?')) emit(d.relationships||[]);
 else if(endpoint.includes('actions/runs/')) emit({head_sha:d.runHead||d.remote,repository:{full_name:d.runRepo||'owner/repo'},run_attempt:1});
 else if(endpoint.includes('actions/jobs/')) emit({head_sha:d.remote,run_id:42,run_attempt:1});
 else if(endpoint==='repos/owner/repo') emit({default_branch:'main'});
 else fail('unexpected API: '+endpoint);
} else fail('unexpected gh: '+a.join(' '));
`, { mode: 0o755 });
  // Intercept only remote publication; every local Git operation is real.
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs=require('node:fs'), cp=require('node:child_process');
const a=process.argv.slice(2), file=process.env.REPAIR_TEST_DATA;
if(a[0]==='ls-remote') { const d=JSON.parse(fs.readFileSync(file)); process.stdout.write(d.remote+'\\trefs/heads/fix\\n'); }
else if(a.includes('push') && a.includes('--no-follow-tags')) {
 const d=JSON.parse(fs.readFileSync(file)); d.pushCount=(d.pushCount||0)+1; d.pushArgs=a;
 if(!d.pushError) d.remote=a.at(-1).split(':')[0]; fs.writeFileSync(file,JSON.stringify(d));
 if(d.pushError){process.stderr.write('push failed');process.exit(1);}
} else {const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'}); process.exit(r.status??1);}
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, REPAIR_TEST_DATA: dataFile };
  const run = (...args) => exec(process.execPath, [helper, ...args], repo, env);
  const runAt = (cwd, ...args) => exec(process.execPath, [helper, ...args], cwd, env);
  const ok = (...args) => { const r=run(...args); assert.equal(r.status,0,r.stderr+'\n'+r.stdout); return JSON.parse(r.stdout); };
  const update = patch => { Object.assign(data, JSON.parse(readFileSync(dataFile)), patch); save(); };
  const read = () => JSON.parse(readFileSync(dataFile));
  const record = input => { const path=join(root,'input.json'); writeFileSync(path,JSON.stringify(input)); return run('session','record','--file',session,'--input',path); };
  const validation = revision => ({ command:'node --test', revision, result:'passed' });
  const commit = (name='repair') => { writeFileSync(join(repo,'file.txt'),name+'\n'); git('add','file.txt'); git('commit','-m',name); return git('rev-parse','HEAD'); };
  const init = () => ok('session','init','--file',session,'--pr','1');
  const repair = (threads=[]) => { const sha=commit(); const r=record({problem:{id:'repair',kind:'review',commit:sha,evidence:'test confirms defect',threads,validation:[validation(sha)]}}); assert.equal(r.status,0,r.stderr); assert.equal(record({validation:validation(sha)}).status,0); return sha; };
  const thread = (id, author='chatgpt-codex-connector[bot]') => ({id,isResolved:false,isOutdated:false,path:'file.txt',line:1,comments:{nodes:[{id:'comment-'+id,author:{login:author},body:'finding'}],pageInfo:{hasNextPage:false}}});
  return { root,repo,session,dataFile,git,start,save,run,runAt,ok,update,read,record,validation,commit,init,repair,thread };
}

test('remote identity accepts HTTPS and SSH without assuming origin', () => {
  for (const url of ['https://github.com/Owner/Repo.git','git@github.com:Owner/Repo.git','ssh://git@github.com/Owner/Repo.git']) assert.equal(repoFromUrl(url),'github.com/owner/repo');
  assert.equal(repoFromUrl('/tmp/repo'),null);
});
test('preflight handles fork remotes and returns precise read-only identity', t => {
  const f=fixture(t,{fork:true}); const r=f.ok('preflight','--pr','1','--json');
  assert.equal(r.mode,'ordinary'); assert.equal(r.baseRemote,'upstream'); assert.equal(r.pushRemote,'fork');
  assert(!f.read().calls.some(a=>a.includes('mutation')));
});
test('preflight blocks dirty, detached, pending merge, ambiguous remote, and another worktree', t => {
  const f=fixture(t);
  writeFileSync(join(f.repo,'dirty'),'x'); assert.match(f.run('preflight').stdout,/worktree changes/); rmSync(join(f.repo,'dirty'));
  f.git('checkout','--detach'); assert.match(f.run('preflight').stdout,/detached/); f.git('checkout','fix');
  writeFileSync(join(f.repo,'.git','MERGE_HEAD'),f.start); assert.match(f.run('preflight').stdout,/Pending Git/); rmSync(join(f.repo,'.git','MERGE_HEAD'));
  f.git('remote','add','duplicate','https://github.com/owner/repo.git'); assert.match(f.run('preflight').stdout,/ambiguous/); f.git('remote','remove','duplicate');
  f.git('checkout','--detach'); f.git('worktree','add',join(f.root,'other'),'fix'); assert.match(f.run('preflight').stdout,/another worktree/);
});
test('unregistered stack relationships and nondefault bases are not ordinary PRs', t => {
  const f=fixture(t,{base:'parent'}); assert.match(f.run('preflight').stdout,/Unregistered/);
  f.update({base:'main',catalog:{branches:['fix']}}); assert.match(f.run('preflight').stdout,/Unregistered/);
});
test('missing worktree catalog permits only positively verified standalone membership', t => {
  const f = fixture(t, { stackInstalled: true, stackViewError: 'branch "fix" is not part of a stack' });
  const result = f.ok('preflight', '--pr', '1');
  assert.equal(result.ready, true);
  assert.equal(result.mode, 'ordinary');
  assert.equal(result.catalogStatus, 'absent-in-worktree');
  assert.equal(result.nativeStack, null);
  assert(f.read().calls.some(a => a.some(x => x.includes('stack{id}'))));
  assert(!f.read().calls.some(a => a.includes('mutation') || a[0] === 'stack' && !['--help', 'view'].includes(a[1])));
});
test('fresh linked repair worktree preserves registered singleton token and session boundaries', t => {
  const f = fixture(t, { stackInstalled: true, stackViewError: 'branch "fix" is not part of a stack' });
  const layers = [{ pr: 'https://github.com/owner/repo/pull/1', branch: 'fix', headRepository: 'github.com/owner/repo', headSha: f.start, baseBranch: 'main' }];
  const dir = join(f.repo, '.git', 'codex-stack-coordination'); mkdirSync(dir);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, recoveries: [], stacks: [{ id: 'singleton', phase: 'ready', layers, lock: { owner: 'attempt', token: 'held', mode: 'repair' } }] }));
  const snapshotPath = join(f.root, 'snapshot.json'), ownership = join(f.root, 'owner.json');
  writeFileSync(snapshotPath, JSON.stringify({ layers }));
  writeFileSync(ownership, JSON.stringify({ owner: 'attempt', token: 'held', snapshotPath }));
  f.git('switch', '-c', 'main');
  const linked = join(f.root, 'linked'); f.git('worktree', 'add', linked, 'fix');
  const check = f.runAt(linked, 'preflight', '--pr', '1', '--stack-file', ownership);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const report = JSON.parse(check.stdout);
  assert.equal(report.mode, 'stack');
  assert.equal(report.stack.id, 'singleton');
  assert.equal(report.stack.lock.token, 'held');
  const init = f.runAt(linked, 'session', 'init', '--file', f.session, '--pr', '1', '--stack-file', ownership);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const session = JSON.parse(init.stdout);
  assert.equal(session.stack.token, 'held');
  assert.deepEqual(session.stack.initialLayers, layers.map(l => ({ ...l, state: 'OPEN', mergeSha: null })));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).stacks[0].lock, { owner: 'attempt', token: 'held', mode: 'repair' });
});
test('missing catalog never excuses unknown native membership, changing identity or other CLI errors', t => {
  const f = fixture(t, { stackInstalled: true, stackViewError: 'branch "fix" is not part of a stack' });
  for (const patch of [
    { nativeStack: { id: 'native-stack' } },
    { nativeStackError: 'authentication failed' },
    { nativeStackGraphQLError: 'stack field unavailable' },
    { nativeStackMissing: true },
    { nativeIdentity: { headRefOid: 'a'.repeat(40) } },
    { nativeIdentity: { baseRefOid: 'b'.repeat(40) } },
    { stackViewError: 'permission denied reading catalog' },
    { stackViewError: 'branch "another" is not part of a stack' },
  ]) {
    f.update({ nativeStack: null, nativeStackError: null, nativeStackGraphQLError: null, nativeStackMissing: false, nativeIdentity: {}, stackViewError: 'branch "fix" is not part of a stack', ...patch });
    assert.equal(f.run('preflight', '--pr', '1').status, 1, JSON.stringify(patch));
  }
});
test('missing catalog does not turn related PRs or foreign ownership into standalone repair', t => {
  const f = fixture(t, { stackInstalled: true, stackViewError: 'branch "fix" is not part of a stack', base: 'parent' });
  assert.match(f.run('preflight').stdout, /nondefault-base stack/);
  f.update({ base: 'main', relationships: [{ number: 2, html_url: 'https://github.com/owner/repo/pull/2', head: { ref: 'upper', repo: { full_name: 'owner/repo' } }, base: { ref: 'fix' } }] });
  assert.match(f.run('preflight').stdout, /related or nondefault-base stack/);
  f.update({ relationships: [] });
  const dir = join(f.repo, '.git', 'codex-stack-coordination'); mkdirSync(dir);
  const state = { version: 1, recoveries: [], stacks: [{ id: 's', phase: 'ready', layers: [{ pr: 'https://github.com/owner/repo/pull/1', branch: 'fix', headRepository: 'github.com/owner/repo' }], lock: { owner: 'other', token: 'held', mode: 'repair' } }] };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  assert.match(f.run('preflight').stdout, /another owner/);
  state.stacks[0].phase = 'building'; writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  assert.match(f.run('preflight').stdout, /Stack is building/);
});
test('registry transaction, corruption, building, and ownership block preflight', t => {
  const f=fixture(t), dir=join(f.repo,'.git','codex-stack-coordination'); mkdirSync(dir);
  mkdirSync(join(dir,'transaction')); assert.match(f.run('preflight').stdout,/transaction/); rmSync(join(dir,'transaction'),{recursive:true});
  writeFileSync(join(dir,'state.json'),'invalid'); assert.equal(f.run('preflight').status,1);
  const state={version:1,recoveries:[],stacks:[{id:'s',phase:'building',layers:[{pr:'https://github.com/owner/repo/pull/1',branch:'fix',headRepository:'github.com/owner/repo'}],lock:{owner:'other',token:'token',mode:'repair'}}]};
  writeFileSync(join(dir,'state.json'),JSON.stringify(state)); assert.match(f.run('preflight').stdout,/building/);
  state.stacks[0].phase='ready';writeFileSync(join(dir,'state.json'),JSON.stringify(state));assert.match(f.run('preflight').stdout,/another owner/);
});
test('check inventory preserves failure and pending JSON but reports API/JSON errors', t => {
  const f=fixture(t,{checks:[{name:'ci',bucket:'fail',state:'FAILURE'}]});
  let r=f.ok('status','--pr','1','--json');assert.equal(r.checks.failing.length,1);assert.equal(r.checks.complete,true);
  f.update({checks:[{name:'ci',bucket:'pending',state:'PENDING'}]});r=f.ok('status','--json');assert.equal(r.checks.complete,true);
  f.update({checks:[],checksError:'authentication failed'});r=f.ok('status','--json');assert.equal(r.checks.complete,false);assert.match(r.checks.error,/authentication/);
  f.update({checksRaw:'not JSON',checksError:null});assert.equal(f.ok('status','--json').checks.complete,false);
  assert(!f.read().calls.some(a=>a[0]==='pr'&&a[1]==='checks'));
});
test('REST checks paginate both sources and keep only the latest attempts', t => {
  const run=(id,name,conclusion)=>({id,name,status:'completed',conclusion,app:{id:1},details_url:'https://github.com/owner/repo/actions/runs/42',started_at:'2026-10-11T00:00:00Z'});
  const filler=Array.from({length:99},(_,i)=>run(i+1,`filler-${i}`,'success'));
  const status=(id,context,state,time='2026-10-11T00:00:00Z')=>({id,context,state,created_at:time});
  const statusFiller=Array.from({length:99},(_,i)=>status(i+10,`status-${i}`,'success'));
  const f=fixture(t,{checkRunsPages:[[...filler,run(100,'ci','failure')],[run(101,'ci','success'),run(102,'cancelled','cancelled'),run(103,'skipped','skipped')]],
    statusesPages:[[...statusFiller,status(1,'deploy','failure')],[status(2,'deploy','success','2026-10-11T00:01:00Z')]]});
  const result=f.ok('status','--json');
  assert.equal(result.checks.complete,true);
  assert.equal(result.checks.total,202);
  assert.deepEqual(result.checks.failing.map(x=>x.name),['cancelled']);
  assert.equal(f.read().calls.filter(a=>a.some(x=>x.includes('page=2'))).length,2);
});
test('REST checks fail closed on missing pages and concurrent head changes', t => {
  const run={id:1,name:'ci',status:'completed',conclusion:'success',app:{id:1}};
  const f=fixture(t,{checkRunsPages:[[run]],checkRunTotal:2});
  let result=f.ok('status','--json');assert.equal(result.checks.complete,false);assert.match(result.checks.error,/Missing check-run page/);
  f.update({checkRunTotal:1,headChangesAfterChecks:true,calls:[]});
  result=f.ok('status','--json');assert.equal(result.checks.complete,false);assert.match(result.checks.error,/head or base changed/);
});
test('session rejects source paths, preexisting ahead commits, duplicate and unrecorded commits', t => {
  const f=fixture(t);assert.equal(f.run('session','init','--file',join(f.repo,'session.json')).status,1);
  f.init();const sha=f.repair();
  const duplicate=f.record({problem:{id:'other',kind:'ci',commit:sha,evidence:'cause',threads:[],validation:[f.validation(sha)]}});assert.match(duplicate.stderr,/share a commit/);
  f.commit('unrecorded');assert.match(f.run('session','verify','--file',f.session).stderr,/Unrecorded/);
  assert.equal(f.run('session','init','--file',join(f.root,'ahead.json')).status,1);
});
test('session records preserve separate problems, block duplicate threads, and clear stale final validation', t => {
  const f=fixture(t);f.init();f.repair([{id:'PRRT_one',disposition:'fixed',evidence:'fixed root cause'}]);const sha=f.commit('second');
  const problem={id:'second',kind:'review',commit:sha,evidence:'second cause',threads:[{id:'PRRT_one',disposition:'fixed',evidence:'duplicate'}],validation:[f.validation(sha)]};
  assert.match(f.record({problem}).stderr,/Duplicate/);problem.threads=[];assert.equal(f.record({problem}).status,0);
  assert.deepEqual(JSON.parse(readFileSync(f.session)).finalValidation,[]);
  assert.match(f.run('publish','--session',f.session).stderr,/Validation/);
});
test('publish performs one explicit normal push, verifies head, and skips completed writes', t => {
  const f=fixture(t);f.init();const sha=f.repair();const p=f.ok('publish','--session',f.session);
  assert.equal(p.state,'verified');assert.equal(f.read().remote,sha);f.ok('publish','--session',f.session);assert.equal(f.read().pushCount,1);
  assert(f.read().pushArgs.includes(sha+':refs/heads/fix'));assert(!f.read().pushArgs.some(x=>x.includes('force')));
});
test('publish blocks concurrent remote change and does not retry failed or uncertain attempts', t => {
  const f=fixture(t);f.init();const sha=f.repair();f.update({remote:'b'.repeat(40)});assert.match(f.run('publish','--session',f.session).stderr,/Remote PR head changed/);
  f.update({remote:f.start,pushError:true});assert.equal(f.run('publish','--session',f.session).status,1);assert.equal(f.read().pushCount,1);
  assert.match(f.run('publish','--session',f.session).stderr,/Previous push/);assert.equal(f.read().pushCount,1);
  f.update({remote:sha});assert.equal(f.ok('publish','--session',f.session).state,'verified');assert.equal(f.read().pushCount,1);
});
test('noop publication avoids empty pushes and permits incorrect thread handling', t => {
  const f=fixture(t);f.update({threads:[f.thread('PRRT_wrong')]});f.init();
  assert.equal(f.record({problem:{id:'wrong',kind:'review',evidence:'invariant proves finding incorrect',threads:[{id:'PRRT_wrong',disposition:'incorrect',evidence:'invariant'}]}}).status,0);
  assert.equal(f.record({validation:f.validation(f.start)}).status,0);
  assert.equal(f.ok('publish','--session',f.session).state,'noop');assert(!f.read().pushCount);
  assert.equal(f.ok('finish-threads','--session',f.session).outcomes.PRRT_wrong.resolve.state,'verified');
});
test('threads are gated by publication and PR membership; blocked findings stay unresolved', t => {
  const f=fixture(t);f.update({threads:[f.thread('PRRT_fixed'),f.thread('PRRT_blocked')]});f.init();
  f.repair([{id:'PRRT_fixed',disposition:'fixed',evidence:'fixed'},{id:'PRRT_blocked',disposition:'blocked',evidence:'decision missing'}]);
  assert.equal(f.run('finish-threads','--session',f.session).status,1);f.ok('publish','--session',f.session);
  f.update({threads:[f.thread('PRRT_blocked')]});assert.match(f.run('finish-threads','--session',f.session).stderr,/not in this PR/);
  f.update({threads:[f.thread('PRRT_fixed'),f.thread('PRRT_blocked')]});const r=f.ok('finish-threads','--session',f.session);assert.deepEqual(r.blocked,['PRRT_blocked']);assert.equal(f.read().threads[1].isResolved,false);
  const mutations=f.read().calls.filter(a=>a.some(x=>x.includes('mutation'))).length;f.ok('finish-threads','--session',f.session);assert.equal(f.read().calls.filter(a=>a.some(x=>x.includes('mutation'))).length,mutations);
});
test('reply failure still resolves and repeated runs do not retry the reply', t => {
  const f=fixture(t);f.update({threads:[f.thread('PRRT_wrong')],replyError:true});f.init();const body=join(f.root,'reply.txt');writeFileSync(body,'The invariant disproves this finding.');
  assert.equal(f.record({problem:{id:'wrong',kind:'review',evidence:'invariant',threads:[{id:'PRRT_wrong',disposition:'incorrect',evidence:'invariant',replyBodyFile:body}]}}).status,0);
  assert.equal(f.record({validation:f.validation(f.start)}).status,0);
  let r=f.run('finish-threads','--session',f.session);assert.equal(r.status,1,r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.outcomes.PRRT_wrong.resolve.state,'verified');assert.equal(result.outcomes.PRRT_wrong.reply.state,'uncertain');
  const count=f.read().calls.filter(a=>a.some(x=>x.includes('mutation'))).length;r=f.run('finish-threads','--session',f.session);assert.equal(r.status,1);assert.equal(f.read().calls.filter(a=>a.some(x=>x.includes('mutation'))).length,count);
});
test('@me findings reject optional replies and uncertain resolution never retries', t => {
  const f=fixture(t);f.update({threads:[f.thread('PRRT_me','Alice')]});f.init();const body=join(f.root,'reply.txt');writeFileSync(body,'Explanation.');
  assert.equal(f.record({problem:{id:'wrong',kind:'review',evidence:'invariant',threads:[{id:'PRRT_me',disposition:'incorrect',evidence:'invariant',replyBodyFile:body}]}}).status,0);assert.equal(f.record({validation:f.validation(f.start)}).status,0);
  assert.match(f.run('finish-threads','--session',f.session).stderr,/findingCommentId|incorrect bot/);assert(!f.read().calls.some(a=>a.some(x=>x.includes('mutation'))));
  const s=JSON.parse(readFileSync(f.session));delete s.problems[0].threads[0].replyBodyFile;writeFileSync(f.session,JSON.stringify(s));f.update({resolveError:true});
  assert.equal(f.run('finish-threads','--session',f.session).status,1);const count=f.read().calls.filter(a=>a.some(x=>x.includes('mutation'))).length;
  assert.equal(f.run('finish-threads','--session',f.session).status,1);assert.equal(f.read().calls.filter(a=>a.some(x=>x.includes('mutation'))).length,count);
});
test('CI logs validate head/repository, deduplicate logs, and report external/unavailable checks', t => {
  const link='https://github.com/owner/repo/actions/runs/42/job/7';
  const f=fixture(t,{checks:[{name:'ci',bucket:'fail',link},{name:'duplicate',bucket:'fail',link},{name:'external',bucket:'fail',link:'https://ci.example.test/1'}],checksExit:1});f.init();
  let r=f.ok('ci-logs','--session',f.session,'--output-dir',join(f.root,'logs'));assert.equal(r.results[0].state,'collected');assert.equal(r.results[2].state,'external');assert.equal(f.read().calls.filter(a=>a[0]==='run').length,1);assert(existsSync(r.results[0].path));
  f.update({runHead:'b'.repeat(40)});r=f.ok('ci-logs','--session',f.session,'--output-dir',join(f.root,'logs'));assert.equal(r.results[0].state,'unavailable');assert.match(r.results[0].error,/Stale/);
  f.update({runHead:null,logError:true});r=f.ok('ci-logs','--session',f.session,'--output-dir',join(f.root,'logs'));assert.match(r.results[0].error,/unavailable/);
  f.update({logError:false,runRepo:'other/repo'});r=f.ok('ci-logs','--session',f.session,'--output-dir',join(f.root,'logs'));assert.equal(r.results[0].state,'unavailable');
});

test('missing optional reply file is a known failure and still resolves the finding', t => {
  const f=fixture(t);f.update({threads:[f.thread('PRRT_missing')]});f.init();
  assert.equal(f.record({problem:{id:'wrong',kind:'review',evidence:'invariant',threads:[{id:'PRRT_missing',disposition:'incorrect',evidence:'invariant',replyBodyFile:join(f.root,'missing.txt')}]}}).status,0);
  assert.equal(f.record({validation:f.validation(f.start)}).status,0);
  const r=f.run('finish-threads','--session',f.session);assert.equal(r.status,1,r.stderr);const result=JSON.parse(r.stdout);
  assert.equal(result.outcomes.PRRT_missing.reply.state,'failed');assert.equal(result.outcomes.PRRT_missing.resolve.state,'verified');
  assert.equal(f.read().calls.filter(a=>a.some(x=>x.includes('addPullRequestReviewThreadReply'))).length,0);
});
test('successful optional reply is sent once and interrupted replies reconcile by comment identity', t => {
  const f=fixture(t);f.update({threads:[f.thread('PRRT_reply')]});f.init();const body=join(f.root,'reply.txt');writeFileSync(body,'The test proves the invariant.');
  assert.equal(f.record({problem:{id:'wrong',kind:'review',evidence:'invariant',threads:[{id:'PRRT_reply',disposition:'incorrect',evidence:'invariant',replyBodyFile:body}]}}).status,0);assert.equal(f.record({validation:f.validation(f.start)}).status,0);
  let result=f.ok('finish-threads','--session',f.session);assert.equal(result.outcomes.PRRT_reply.reply.state,'verified');
  const s=JSON.parse(readFileSync(f.session));s.threadOutcomes.PRRT_reply.reply.state='attempting';writeFileSync(f.session,JSON.stringify(s));
  result=f.ok('finish-threads','--session',f.session);assert.equal(result.outcomes.PRRT_reply.reply.state,'verified');
  assert.equal(f.read().calls.filter(a=>a.some(x=>x.includes('addPullRequestReviewThreadReply'))).length,1);
});
test('session lock contention fails closed and invalid records never replace the session', t => {
  const f=fixture(t);f.init();const old=readFileSync(f.session,'utf8');mkdirSync(f.session+'.lock');
  assert.match(f.record({validation:f.validation(f.start)}).stderr,/locked/);assert.equal(readFileSync(f.session,'utf8'),old);rmSync(f.session+'.lock',{recursive:true});
  assert.equal(f.record({validation:{command:'test',revision:'missing',result:'passed'}}).status,1);assert.equal(readFileSync(f.session,'utf8'),old);
});
test('stack sessions reuse ownership and independently verify all published heads and base chains', t => {
  const f=fixture(t);const upper=f.commit('upper original');f.git('branch','upper');f.git('reset','--hard',f.start);f.update({upperSha:upper});
  const layers=[{pr:'https://github.com/owner/repo/pull/1',branch:'fix',headRepository:'github.com/owner/repo',headSha:f.start,baseBranch:'main'},
    {pr:'https://github.com/owner/repo/pull/2',branch:'upper',headRepository:'github.com/owner/repo',headSha:upper,baseBranch:'fix',inheritedBoundary:f.start}];
  const dir=join(f.repo,'.git','codex-stack-coordination');mkdirSync(dir);
  const state={version:1,recoveries:[],stacks:[{id:'stack',phase:'ready',layers,lock:{owner:'attempt',token:'held',mode:'repair'}}]};
  writeFileSync(join(dir,'state.json'),JSON.stringify(state));
  const snapshot=join(f.root,'snapshot.json');writeFileSync(snapshot,JSON.stringify({layers}));const ownership=join(f.root,'owner.json');writeFileSync(ownership,JSON.stringify({owner:'attempt',token:'held',snapshotPath:snapshot}));
  f.ok('session','init','--file',f.session,'--pr','1','--stack-file',ownership);
  assert.equal(f.record({validation:f.validation(f.start)}).status,0);
  assert.match(f.run('publish','--session',f.session).stderr,/manage-stacked-prs/);
  assert.equal(f.run('finish-threads','--session',f.session).status,1);
  assert.equal(f.record({stackPublication:{complete:true,targetBoundary:f.start,repairCommits:[],layers,validation:[]}}).status,0);
  assert.equal(f.record({validation:f.validation(f.start)}).status,0);
  assert.equal(f.ok('finish-threads','--session',f.session).complete,true);
  f.update({upperSha:'c'.repeat(40)});assert.match(f.run('finish-threads','--session',f.session).stderr,/remote head or base chain/);f.update({upperSha:upper});
  state.stacks[0].lock.token='changed';writeFileSync(join(dir,'state.json'),JSON.stringify(state));assert.match(f.run('finish-threads','--session',f.session).stderr,/another owner/);
});
test('stack initialization rejects stale remote snapshots and unclaimed reservations', t => {
  const f=fixture(t),dir=join(f.repo,'.git','codex-stack-coordination');mkdirSync(dir);
  const layer={pr:'https://github.com/owner/repo/pull/1',branch:'fix',headRepository:'github.com/owner/repo',headSha:f.start,baseBranch:'main'};
  const state={version:1,recoveries:[],stacks:[{id:'stack',phase:'ready',layers:[layer],lock:{owner:'attempt',token:'held',mode:'reserved'}}]};writeFileSync(join(dir,'state.json'),JSON.stringify(state));
  const snapshot=join(f.root,'snapshot.json');writeFileSync(snapshot,JSON.stringify({layers:[layer]}));const ownership=join(f.root,'owner.json');writeFileSync(ownership,JSON.stringify({owner:'attempt',token:'held',snapshotPath:snapshot}));
  assert.match(f.run('session','init','--file',f.session,'--stack-file',ownership).stderr,/unclaimed reservation/);
  state.stacks[0].lock.mode='repair';writeFileSync(join(dir,'state.json'),JSON.stringify(state));layer.headSha=f.commit('stale');f.git('reset','--hard',f.start);writeFileSync(snapshot,JSON.stringify({layers:[layer]}));
  assert.match(f.run('session','init','--file',f.session,'--stack-file',ownership).stderr,/Snapshot remote/);
});

test('PR URL case is normalized to the shared registry identity', t => {
  const f=fixture(t,{prURL:'https://github.com/Owner/Repo/pull/1',headRepo:'Owner/Repo'});
  const result=f.ok('preflight','--pr','1');assert.equal(result.pr.url,'https://github.com/owner/repo/pull/1');assert.equal(result.pr.headRepository,'github.com/owner/repo');
});
test('rerun validation replaces its failed final result and retains validation history', t => {
  const f=fixture(t);f.init();const revision=f.repair();
  assert.equal(f.record({validation:{command:'node --test',revision,result:'failed'}}).status,0);
  assert.equal(f.ok('session','verify','--file',f.session).valid,true);
  assert.equal(f.record({validation:f.validation(revision)}).status,0);assert.equal(f.ok('publish','--session',f.session).state,'verified');
  const s=JSON.parse(readFileSync(f.session));assert.equal(s.finalValidation.length,1);assert(s.validationHistory.some(v=>v.result==='failed'));
});
test('session help is available without an action and rejects irrelevant options', t => {
  const f=fixture(t);const help=f.run('session','--help');assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/session init/);
  assert.match(f.run('session','verify','--file',f.session,'--pr','1').stderr,/Unknown/);
});

test('partial resolution failures preserve independent successful thread outcomes', t => {
  const f=fixture(t);f.update({threads:[f.thread('PRRT_fail'),f.thread('PRRT_ok')],resolveErrorIDs:['PRRT_fail']});f.init();
  assert.equal(f.record({problem:{id:'wrong',kind:'review',evidence:'same incorrect premise',threads:['PRRT_fail','PRRT_ok'].map(id=>({id,disposition:'incorrect',evidence:'invariant'}))}}).status,0);assert.equal(f.record({validation:f.validation(f.start)}).status,0);
  const r=f.run('finish-threads','--session',f.session);assert.equal(r.status,1,r.stderr);const outcomes=JSON.parse(r.stdout).outcomes;
  assert.equal(outcomes.PRRT_fail.resolve.state,'uncertain');assert.equal(outcomes.PRRT_ok.resolve.state,'verified');
});
test('mixed-author replies require the exact eligible bot finding comment', t => {
  const f=fixture(t);const thread=f.thread('PRRT_mixed');thread.comments.nodes.push({id:'human',author:{login:'Alice'},body:'human finding'});f.update({threads:[thread]});f.init();const body=join(f.root,'reply.txt');writeFileSync(body,'The bot premise contradicts the test.');
  assert.equal(f.record({problem:{id:'wrong',kind:'review',evidence:'invariant',threads:[{id:'PRRT_mixed',disposition:'incorrect',evidence:'invariant',replyBodyFile:body}]}}).status,0);assert.equal(f.record({validation:f.validation(f.start)}).status,0);
  assert.match(f.run('finish-threads','--session',f.session).stderr,/findingCommentId/);
  const s=JSON.parse(readFileSync(f.session));s.problems[0].threads[0].findingCommentId='human';writeFileSync(f.session,JSON.stringify(s));assert.match(f.run('finish-threads','--session',f.session).stderr,/incorrect bot/);
  s.problems[0].threads[0].findingCommentId='comment-PRRT_mixed';writeFileSync(f.session,JSON.stringify(s));assert.equal(f.ok('finish-threads','--session',f.session).complete,true);
});
test('replayed target repairs use original boundaries and mapped layer commits', t => {
  const f=fixture(t);f.git('branch','parent');const original=f.commit('target own');
  const url=n=>'https://github.com/owner/repo/pull/'+n;
  const pr=(n,branch,sha,base)=>({number:n,html_url:url(n),state:'open',head:{ref:branch,sha,repo:{full_name:'owner/repo'}},base:{ref:base,sha:f.start,repo:{full_name:'owner/repo'}}});
  const prs={1:pr(1,'fix',original,'parent'),2:pr(2,'parent',f.start,'main')};f.update({remote:original,prs});
  const layers=[{pr:url(2),branch:'parent',headRepository:'github.com/owner/repo',headSha:f.start,baseBranch:'main'},
    {pr:url(1),branch:'fix',headRepository:'github.com/owner/repo',headSha:original,baseBranch:'parent',inheritedBoundary:f.start}];
  const dir=join(f.repo,'.git','codex-stack-coordination');mkdirSync(dir);writeFileSync(join(dir,'state.json'),JSON.stringify({version:1,recoveries:[],stacks:[{id:'stack',phase:'ready',layers,lock:{owner:'attempt',token:'held',mode:'repair'}}]}));
  const snapshot=join(f.root,'snapshot.json');writeFileSync(snapshot,JSON.stringify({layers}));const ownership=join(f.root,'owner.json');writeFileSync(ownership,JSON.stringify({owner:'attempt',token:'held',snapshotPath:snapshot}));f.ok('session','init','--file',f.session,'--pr','1','--stack-file',ownership);
  const beforeRepair=f.repair();f.git('checkout','parent');writeFileSync(join(f.repo,'parent.txt'),'necessary lower repair\n');f.git('add','parent.txt');f.git('commit','-m','necessary lower repair');const parent=f.git('rev-parse','HEAD');
  f.git('checkout','fix');f.git('rebase','--onto',parent,f.start,'fix');const final=f.git('rev-parse','HEAD');assert.notEqual(final,beforeRepair);
  prs[1]=pr(1,'fix',final,'parent');prs[2]=pr(2,'parent',parent,'main');f.update({remote:final,prs});
  const published=[{...layers[0],headSha:parent},{...layers[1],headSha:final}];
  const publication={complete:true,targetBoundary:parent,repairCommits:[{problemId:'repair',commit:parent}],layers:published,validation:[f.validation(parent),f.validation(final)]};
  assert.match(f.record({stackPublication:publication}).stderr,/outside the target layer/);
  publication.repairCommits[0].commit=final;assert.equal(f.record({stackPublication:publication}).status,0);assert.equal(f.record({validation:f.validation(final)}).status,0);
  assert.equal(f.ok('finish-threads','--session',f.session).complete,true);
  const s=JSON.parse(readFileSync(f.session));assert.equal(s.problems[0].commit,beforeRepair);assert.equal(s.stack.initialLayers[1].inheritedBoundary,f.start);
});

test('a merge repair inventories its merge commit without adopting incoming base commits', t => {
  const f=fixture(t);f.init();f.git('branch','base');f.git('checkout','base');writeFileSync(join(f.repo,'base.txt'),'base change\n');f.git('add','base.txt');f.git('commit','-m','base change');
  f.git('checkout','fix');f.git('merge','--no-ff','base','-m','merge base');const merge=f.git('rev-parse','HEAD');
  assert.equal(f.record({problem:{id:'merge',kind:'merge',commit:merge,evidence:'base integration resolves conflicts',threads:[],validation:[f.validation(merge)]}}).status,0);
  assert.equal(f.record({validation:f.validation(merge)}).status,0);assert.equal(f.ok('session','verify','--file',f.session).commits,1);
  assert.equal(f.ok('publish','--session',f.session).state,'verified');assert.equal(f.read().pushCount,1);
});

test('review thread inventory accepts opaque legacy GitHub node IDs', t => {
  const f=fixture(t),id='opaque-legacy-node';f.update({threads:[f.thread(id)]});f.init();
  assert.equal(f.record({problem:{id:'wrong',kind:'review',evidence:'invariant',threads:[{id,disposition:'incorrect',evidence:'invariant'}]}}).status,0);assert.equal(f.record({validation:f.validation(f.start)}).status,0);
  assert.equal(f.ok('finish-threads','--session',f.session).outcomes[id].resolve.state,'verified');
});

test('building repair session accepts only the transferred claimed token', t => {
  const f = fixture(t);
  const pr = 'https://github.com/owner/repo/pull/1';
  const layers = [{ pr, branch: 'fix', headRepository: 'github.com/owner/repo', headSha: f.start, baseBranch: 'main' }];
  const dir = join(f.repo, '.git', 'codex-stack-coordination'); mkdirSync(dir);
  const state = { version: 1, recoveries: [], stacks: [{ id: 's', phase: 'building', layers,
    buildRepair: { pr, assignmentId: 'r', buildOwner: 'builder' }, lock: { owner: 'child', token: 'claimed', mode: 'repair' } }] };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  const snapshotPath = join(f.root, 'snapshot.json'), ownership = join(f.root, 'owner.json');
  writeFileSync(snapshotPath, JSON.stringify({ layers }));
  writeFileSync(ownership, JSON.stringify({ owner: 'child', token: 'claimed', snapshotPath }));
  assert.match(f.run('preflight', '--pr', '1').stdout, /Stack is building/);
  const init = f.run('session', 'init', '--file', f.session, '--pr', '1', '--stack-file', ownership);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.equal(JSON.parse(init.stdout).stack.token, 'claimed');
  writeFileSync(ownership, JSON.stringify({ owner: 'child', token: 'wrong', snapshotPath }));
  assert.match(f.run('preflight', '--pr', '1', '--stack-file', ownership).stdout, /Stack is building/);
});

for (const result of ['failed', 'skipped']) {
  test(`publication and thread handling preserve ${result} validation without blocking`, t => {
    const f = fixture(t);
    f.update({ threads: [f.thread('PRRT_fixed')] });
    f.init();
    const revision = f.repair([{ id: 'PRRT_fixed', disposition: 'fixed', evidence: 'repair implemented' }]);
    assert.equal(f.record({ validation: { command: 'node --test', revision, result } }).status, 0);
    assert.equal(f.ok('publish', '--session', f.session).state, 'verified');
    assert.equal(f.read().pushCount, 1);
    assert.equal(f.ok('finish-threads', '--session', f.session).outcomes.PRRT_fixed.resolve.state, 'verified');
    const session = JSON.parse(readFileSync(f.session, 'utf8'));
    assert.equal(session.finalValidation[0].result, result);
    assert(session.validationHistory.some(validation => validation.result === result));
  });
}

test('failed validation still requires the covered revision', t => {
  const f = fixture(t);
  f.init();
  f.repair();
  const before = readFileSync(f.session, 'utf8');
  assert.match(f.record({ validation: { command: 'test', revision: f.start, result: 'failed' } }).stderr, /revision differs/);
  assert.equal(readFileSync(f.session, 'utf8'), before);
});

test('merged prefix permits session and publication without rewriting retired layers', t => {
  const f = fixture(t, { catalog: { branches: ['fix'] } });
  const layers = [
    { pr: 'https://github.com/owner/repo/pull/2', branch: 'retired', headRepository: 'github.com/owner/repo', headSha: f.start, baseBranch: 'main' },
    { pr: 'https://github.com/owner/repo/pull/1', branch: 'fix', headRepository: 'github.com/owner/repo', headSha: f.start, baseBranch: 'main', inheritedBoundary: f.start },
  ];
  const retired = { html_url: layers[0].pr, state: 'closed', merged: true, merge_commit_sha: f.start, head: { ref: 'retired', sha: f.start, repo: { full_name: 'owner/repo' } }, base: { ref: 'main', sha: f.start, repo: { full_name: 'owner/repo' } } };
  f.update({ prs: { 2: retired } });
  const dir = join(f.repo, '.git', 'codex-stack-coordination'); mkdirSync(dir);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, recoveries: [], stacks: [{ id: 'prefix', phase: 'ready', layers, lock: { owner: 'attempt', token: 'held', mode: 'repair' } }] }));
  const snapshotPath = join(f.root, 'snapshot.json'), ownership = join(f.root, 'owner.json');
  writeFileSync(snapshotPath, JSON.stringify({ layers }));
  writeFileSync(ownership, JSON.stringify({ owner: 'attempt', token: 'held', snapshotPath }));
  const session = f.ok('session', 'init', '--file', f.session, '--pr', '1', '--stack-file', ownership);
  assert.equal(session.stack.initialLayers[0].state, 'MERGED');
  assert.equal(f.record({ stackPublication: { complete: true, targetBoundary: f.start, repairCommits: [], layers, validation: [] } }).status, 0);
  assert.equal(f.record({ validation: f.validation(f.start) }).status, 0);
  f.ok('finish-threads', '--session', f.session);
  f.update({ missingMerge: true });
  assert.match(f.run('finish-threads', '--session', f.session).stderr, /does not contain/);
  f.update({ missingMerge: false, prs: { 2: { ...retired, head: { ...retired.head, sha: 'b'.repeat(40) } } } });
  assert.match(f.run('finish-threads', '--session', f.session).stderr, /remote head/);
  assert(!f.read().pushCount);
});
