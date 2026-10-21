#!/usr/bin/env python3
"""Read T3 Chat's v2 SQLite projections without modifying session history."""
import argparse
import contextlib
import datetime as dt
import json
import math
from pathlib import Path
import re
import sqlite3
import sys

FIELDS = ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens')
PREFIX = 'orchestration_v2_projection_'


@contextlib.contextmanager
def connect(path):
    # mode=ro avoids creating a database at a misspelled path. Keep WAL visibility.
    db = sqlite3.connect(path.expanduser().resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA query_only = ON')
        db.execute('BEGIN')  # One consistent snapshot across all projections.
        yield db
    finally:
        db.close()


def rows(db, table, thread=None):
    query = 'SELECT * FROM ' + PREFIX + table
    params = ()
    if thread is not None:
        query += ' WHERE thread_id = ?'
        params = (thread,)
    yield from db.execute(query, params)


def payload(row, warnings, table):
    try:
        value = json.loads(row['payload_json'])
        if not isinstance(value, dict):
            raise ValueError('expected object')
        return value
    except (ValueError, TypeError) as exc:
        warnings.append({'table': PREFIX + table, 'error': str(exc)[:200]})
        return {}


def body(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def evidence(text, skill, skill_path, user=False, match_text=()):
    if user:
        text = re.sub(r'<(?:skills_instructions|INSTRUCTIONS|skill)>.*?</(?:skills_instructions|INSTRUCTIONS|skill)>', '', text, flags=re.S)
        text = re.sub(r'```.*?```', '', text, flags=re.S)
        if re.search(r'\$' + re.escape(skill) + r'(?![\w-])', text):
            return 'explicit_invocation_candidate'
    elif any(p in text for p in (skill_path, str(Path(skill_path).resolve()), '/' + skill + '/SKILL.md')):
        return 'skill_path_tool_candidate'
    if any(term in text for term in match_text):
        return 'text_match_candidate'
    return None


def in_range(stamp, since, until):
    return bool(stamp) and (not since or stamp[:10] >= since) and (not until or stamp[:10] <= until)


def item_sample(row, p, limit):
    result = {k: row[k] for k in ('turn_item_id', 'run_id', 'provider_turn_id', 'type', 'status')}
    for k in ('input', 'output'):
        if k in p:
            text = body(p[k])
            result[k + '_characters'] = len(text)
            result[k + '_excerpt'] = text[:limit]
    result['tool_name'] = p.get('toolName')
    return result


def turn_record(row, p, selection):
    # tokenUsage describes the context window / latest response, not total turn cost.
    u = p.get('turnTokenUsage') or {}
    mapping = dict(inputTokens='input_tokens', cachedInputTokens='cached_input_tokens',
                   cacheCreationTokens='cache_write_input_tokens', outputTokens='output_tokens')
    return {'provider_turn_id': row['provider_turn_id'], 'provider_thread_id': row['provider_thread_id'],
            'node_id': row['node_id'], 'model': selection.get('model'),
            'provider_instance_id': selection.get('instanceId'),
            'model_options': selection.get('options', []),
            'timestamp': row['completed_at'] or row['started_at'],
            'usage_status': u.get('usageStatus', 'unavailable'),
            'usage_scope': u.get('usageScope'), 'has_subagents': u.get('hasSubagents'),
            'source': 'provider_turn_total',
            'usage': {dest: u[src] for src, dest in mapping.items() if src in u}}


def price_turn(call, prices):
    """T3 turn totals include cache reads/writes in input and reasoning in output."""
    rule = prices.get('models', {}).get(call['model']) if prices else None
    if not rule:
        return None, 'model price unavailable'
    if call.get('usage_status') != 'complete':
        return None, 'turn usage incomplete or unavailable'
    usage = call['usage']
    if any(k not in usage for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')):
        return None, 'usage fields missing'
    if any(not valid_count(usage.get(k, 0)) for k in FIELDS):
        return None, 'invalid token counts'
    if not rule.get('source') or not prices.get('as_of') or not rule.get('basis'):
        return None, 'price source, date, or basis missing'
    inp, cached, out = (usage[k] for k in ('input_tokens', 'cached_input_tokens', 'output_tokens'))
    writes = usage.get('cache_write_input_tokens', 0)
    if cached > inp:
        return None, 'cached input exceeds input'
    uncached = inp - cached - writes
    if uncached < 0:
        return None, 'overlapping input buckets'
    rates = rule.get('usd_per_million', {})
    if any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in rates.values()):
        return None, 'invalid rates'
    if 'cache_write_input_tokens' not in usage:
        return None, 'cache-write usage unavailable'
    buckets = {'input': uncached, 'cached_input': cached, 'cache_write': writes, 'output': out}
    if any(v and k not in rates for k, v in buckets.items()):
        return None, 'required rate missing'
    if rule.get('long_context'):
        return None, 'request boundaries unavailable for long-context pricing'
    value = sum(v * rates.get(k, 0) for k, v in buckets.items()) / 1_000_000
    return value, None


def valid_count(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0)


def summarize(calls, prices):
    result = {'provider_turns': len(calls), 'tokens': {k: 0 for k in FIELDS}, 'priced_turns': 0,
              'unpriced_turns': 0, 'known_cost_usd': 0.0, 'unpriced_reasons': {}, 'usage_statuses': {},
              'missing_token_fields': {k: 0 for k in FIELDS}}
    for call in calls:
        status = call.get('usage_status', 'unavailable')
        result['usage_statuses'][status] = result['usage_statuses'].get(status, 0) + 1
        for k in FIELDS:
            value = call['usage'].get(k)
            if value is None:
                result['missing_token_fields'][k] += 1
            elif valid_count(value):
                result['tokens'][k] += value
        cost, reason = price_turn(call, prices)
        if cost is None:
            result['unpriced_turns'] += 1
            result['unpriced_reasons'][reason] = result['unpriced_reasons'].get(reason, 0) + 1
        else:
            result['priced_turns'] += 1
            result['known_cost_usd'] += cost
    result['known_cost_usd'] = round(result['known_cost_usd'], 8)
    return result


def analyze(db, skill, skill_path, prices=None, threads=(), since=None, until=None,
            top=10, excerpt_chars=600, match_text=()):
    sessions, errors = [], []
    available = {r['thread_id']: r for r in rows(db, 'threads')}
    errors.extend({'thread_id': t, 'error': 'thread not found'} for t in threads if t not in available)
    scanned = 0
    for tid, thread in available.items():
        if threads and tid not in threads:
            continue
        scanned += 1
        warnings, hits, actions = [], {}, {}
        runs = {r['run_id']: payload(r, warnings, 'runs') for r in rows(db, 'runs', tid)}
        nodes = {r['node_id']: r['run_id'] for r in rows(db, 'nodes', tid)}
        # Read each projection once. Messages and user_message turn items mirror one another;
        # use messages for user evidence and turn items only for tool evidence.
        for row in rows(db, 'messages', tid):
            if row['role'] != 'user':
                continue
            p = payload(row, warnings, 'messages')
            text = p.get('text', '')
            kind = evidence(text, skill, skill_path, True, match_text)
            if kind and in_range(row['created_at'], since, until):
                entries = hits.setdefault(row['run_id'], [])
                if len(entries) < 10:
                    entries.append({'message_id': row['message_id'], 'timestamp': row['created_at'],
                                    'kind': kind, 'excerpt': text[:excerpt_chars]})
        for row in rows(db, 'turn_items', tid):
            if row['type'] not in ('command_execution', 'dynamic_tool'):
                continue
            p = payload(row, warnings, 'turn_items')
            kind = evidence(body(p.get('input', '')), skill, skill_path, match_text=match_text)
            if kind and in_range(row['updated_at'], since, until):
                entries = hits.setdefault(row['run_id'], [])
                if len(entries) < 10:
                    entries.append({'turn_item_id': row['turn_item_id'], 'timestamp': row['updated_at'],
                                    'kind': kind, 'excerpt': body(p.get('input', ''))[:excerpt_chars]})
            entries = actions.setdefault(row['run_id'], [])
            if in_range(row['updated_at'], since, until) and len(entries) < 40:
                entries.append(item_sample(row, p, excerpt_chars))
        if not hits and not threads:
            continue
        records = []
        for row in rows(db, 'provider_turns', tid):
            p = payload(row, warnings, 'provider_turns')
            run_id = nodes.get(row['node_id'])
            if run_id is None:
                warnings.append({'provider_turn_id': row['provider_turn_id'], 'error': 'run linkage unavailable'})
            run = runs.get(run_id, {})
            # A run's selected model identifies its root turn only. Do not assign it
            # to native child turns, or to turns whose run linkage was not retained.
            selection = run.get('modelSelection', {}) if row['node_id'] == run.get('rootNodeId') else {}
            record = turn_record(row, p, selection)
            record['run_id'] = run_id
            if in_range(record['timestamp'], since, until):
                records.append(record)
        selected_runs = set(hits) if not threads else set(runs) | set(hits)
        if since or until:
            selected_runs &= set(hits) | {r['run_id'] for r in records}
        selected = [r for r in records if r['run_id'] is not None and r['run_id'] in selected_runs]
        subagents = []
        for row in rows(db, 'subagents', tid):
            if row['run_id'] not in selected_runs:
                continue
            p = payload(row, warnings, 'subagents')
            subagents.append({k: p.get(k) for k in ('id', 'runId', 'childThreadId', 'providerThreadId',
                                                   'modelSelection', 'status')})
        if not hits and not selected and (since or until):
            continue
        sessions.append({'thread_id': tid, 'title': thread['title'],
                         'archived': thread['archived_at'] is not None,
                         'deleted': thread['deleted_at'] is not None,
                         'thread_usage_in_date_range': summarize(records, prices),
                         'selected_run_usage': summarize(selected, prices),
                         'models': sorted({r['model'] or 'unknown' for r in records}),
                         'runs': [{'run_id': rid, 'evidence': hits.get(rid, []),
                                   'tool_samples': actions.get(rid, []),
                                   'usage': summarize([r for r in selected if r['run_id'] == rid], prices)}
                                  for rid in sorted(selected_runs, key=lambda x: x or '')],
                         'turn_samples': selected[:10], 'linked_subagents': subagents,
                         'warnings': warnings})
    sessions.sort(key=lambda s: (s['selected_run_usage']['known_cost_usd'],
                                s['selected_run_usage']['tokens']['input_tokens']), reverse=True)
    return {'skill': skill, 'threads_scanned': scanned, 'matched_threads': len(sessions),
            'scope': ('Explicit threads: all retained runs.' if threads else 'Candidate runs: confirm invocation.') +
                     ' Associated context is not exclusive skill cost. Child threads are not included automatically.',
            'price_as_of': (prices or {}).get('as_of'), 'pricing_basis': (prices or {}).get('models', {}),
            'sessions': sessions[:top], 'omitted_sessions': max(0, len(sessions) - top), 'errors': errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skill', required=True, help='Exact skill slug')
    parser.add_argument('--skill-path', required=True, help='Target skill directory')
    parser.add_argument('--database', type=Path, default=Path.home() / '.t3/userdata/statev2.sqlite')
    parser.add_argument('--thread', action='append', default=[], help='Exact T3 thread ID; analyzes all its runs; repeatable')
    parser.add_argument('--match-text', action='append', default=[], help='Additional literal candidate text; repeatable')
    detail = parser.add_mutually_exclusive_group()
    detail.add_argument('--item', help='Retrieve one exact turn-item ID instead of analyzing')
    detail.add_argument('--message', help='Retrieve one exact message ID instead of analyzing')
    parser.add_argument('--since', type=dt.date.fromisoformat)
    parser.add_argument('--until', type=dt.date.fromisoformat)
    parser.add_argument('--prices', type=Path, help='Verified API price JSON; omitted means token-only analysis')
    parser.add_argument('--top', type=int, default=10)
    parser.add_argument('--excerpt-chars', type=int, default=600)
    args = parser.parse_args()
    if args.top < 1 or args.excerpt_chars < 0 or (args.since and args.until and args.since > args.until):
        parser.error('invalid limits or date range')
    try:
        prices = json.loads(args.prices.read_text()) if args.prices else None
        with connect(args.database) as db:
            if args.message:
                row = db.execute('SELECT * FROM ' + PREFIX + 'messages WHERE message_id = ?', (args.message,)).fetchone()
                if row is None:
                    raise ValueError('message not found: ' + args.message)
                warnings = []
                text = payload(row, warnings, 'messages').get('text', '')
                report = {'message_id': row['message_id'], 'thread_id': row['thread_id'],
                          'run_id': row['run_id'], 'role': row['role'], 'text_characters': len(text),
                          'text_excerpt': text[:args.excerpt_chars], 'warnings': warnings}
            elif args.item:
                row = db.execute('SELECT * FROM ' + PREFIX + 'turn_items WHERE turn_item_id = ?', (args.item,)).fetchone()
                if row is None:
                    raise ValueError('turn item not found: ' + args.item)
                warnings = []
                report = {'item': item_sample(row, payload(row, warnings, 'turn_items'), args.excerpt_chars),
                          'warnings': warnings}
            else:
                report = analyze(db, args.skill, args.skill_path, prices, args.thread,
                                 args.since.isoformat() if args.since else None,
                                 args.until.isoformat() if args.until else None,
                                 args.top, args.excerpt_chars, args.match_text)
        report['database'] = str(args.database.expanduser().resolve())
    except (OSError, sqlite3.Error, ValueError) as exc:
        json.dump({'error': str(exc)}, sys.stderr, ensure_ascii=False)
        print(file=sys.stderr)
        return 1
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
