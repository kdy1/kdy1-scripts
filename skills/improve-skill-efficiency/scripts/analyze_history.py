#!/usr/bin/env python3
"""Read Codex rollout logs; emit bounded evidence and explicitly scoped API estimates."""
import argparse
import contextlib
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys

FIELDS = ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens')


@contextlib.contextmanager
def lines(path):
    if path.suffix != '.zst':
        with path.open(encoding='utf-8') as stream:
            yield stream
        return
    # Stream decompression; never rewrite the user's history.
    proc = subprocess.Popen(['zstd', '-dc', '--', str(path)], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, encoding='utf-8')
    try:
        yield proc.stdout
        proc.stdout.close()
        error = proc.stderr.read()
        if proc.wait():
            raise ValueError('zstd failed: ' + error[:300])
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        proc.stderr.close()


def content_text(payload):
    content = payload.get('content', [])
    if isinstance(content, str):
        return content
    return '\n'.join(x.get('text', '') for x in content if isinstance(x, dict))


def evidence(payload, skill, skill_path):
    """Catalog availability is not invocation. Tool path matches are candidates only."""
    kind = payload.get('type')
    if kind == 'message' and payload.get('role') == 'user':
        text = content_text(payload)
        # Environment skill catalogs and quoted logs must not become positive evidence.
        text = re.sub(r'<(?:skills_instructions|INSTRUCTIONS)>.*?</(?:skills_instructions|INSTRUCTIONS)>', '', text, flags=re.S)
        text = re.sub(r'```.*?```', '', text, flags=re.S)
        if re.search(r'\$' + re.escape(skill) + r'(?![\w-])', text):
            return 'explicit_invocation_candidate', text
    if kind in ('function_call', 'custom_tool_call'):
        text = str(payload.get('arguments', payload.get('input', '')))
        paths = (skill_path, str(Path(skill_path).resolve()), '/' + skill + '/SKILL.md')
        if any(p and p in text for p in paths):
            return 'skill_path_tool_candidate', text
    return None


def read_session(path, skill, skill_path, excerpt_chars):
    modern, legacy, hits, actions = [], [], {}, {}
    model, turn, session = None, 'unknown', path.name
    total = None
    warnings = []
    with lines(path) as stream:
        for number, line in enumerate(stream, 1):
            try:
                row = json.loads(line)
            except (ValueError, TypeError):
                warnings.append('malformed JSON at line %s' % number)
                continue
            p = row.get('payload') or {}
            kind = row.get('type')
            stamp = row.get('timestamp', '')
            if kind == 'session_meta':
                session = p.get('id', session)
            if kind == 'turn_context':
                model = p.get('model')
                turn = p.get('turn_id', turn)
            if kind == 'response_item':
                found = evidence(p, skill, skill_path)
                if found:
                    entries = hits.setdefault(turn, [])
                    if len(entries) < 10:
                        entries.append({'line': number, 'timestamp': stamp, 'kind': found[0],
                                        'excerpt': found[1][:excerpt_chars]})
                if p.get('type') in ('function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'):
                    entries = actions.setdefault(turn, [])
                    if len(entries) < 40:
                        body = str(p.get('arguments', p.get('input', p.get('output', ''))))
                        entries.append({'line': number, 'type': p['type'], 'name': p.get('name'),
                                        'characters': len(body), 'excerpt': body[:excerpt_chars]})
            if kind == 'token_usage_record':
                usage = p.get('usage')
                if usage:
                    modern.append({'session': session, 'turn': p.get('turn_id', turn),
                                   'response_id': p.get('response_id'), 'model': p.get('model') or model,
                                   'timestamp': stamp, 'line': number, 'usage': usage, 'source': 'usage'})
            if kind == 'event_msg' and p.get('type') == 'token_count':
                info = p.get('info') or {}
                current = info.get('total_token_usage')
                if not current:
                    continue
                # Repeated cumulative snapshots are not new calls. Missing baseline after a
                # reset is not interpreted as the entire historical total being one call.
                reset = total is not None and any(current.get(k, 0) < total.get(k, 0) for k in FIELDS)
                if total is None or reset:
                    usage = info.get('last_token_usage')
                    if usage and any(current.get(k, 0) > usage.get(k, 0) for k in FIELDS):
                        warnings.append('history before first/reset snapshot omitted at line %s' % number)
                    if not usage:
                        warnings.append('unpriced initial/reset cumulative snapshot at line %s' % number)
                else:
                    usage = {k: current[k] - total.get(k, 0) for k in FIELDS if k in current}
                initial_snapshot = total is None or reset
                total = current
                if usage and any(usage.get(k, 0) for k in FIELDS):
                    legacy.append({'session': session, 'turn': turn, 'response_id': None,
                                   'model': model, 'timestamp': stamp, 'line': number,
                                   'usage': usage, 'source': 'cumulative_delta',
                                   'precision': 'last_call' if initial_snapshot else 'snapshot_interval'})
    modern_turns = {c['turn'] for c in modern}
    calls = modern + [c for c in legacy if c['turn'] not in modern_turns]
    return {'session': session, 'path': str(path), 'calls': calls, 'hits': hits,
            'actions': actions, 'warnings': warnings}


def price_call(call, prices):
    """Price disjoint input buckets; price files must specify cache-write semantics."""
    rule = prices.get('models', {}).get(call['model']) if prices else None
    if not rule:
        return None, 'model price unavailable'
    usage = call['usage']
    if any(k not in usage for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')):
        return None, 'usage fields missing'
    if any(not isinstance(usage.get(k, 0), (int, float)) or usage.get(k, 0) < 0 for k in FIELDS):
        return None, 'invalid token counts'
    if not rule.get('source') or not prices.get('as_of') or not rule.get('basis'):
        return None, 'price source, date, or basis missing'
    inp, cached, out = (usage[k] for k in ('input_tokens', 'cached_input_tokens', 'output_tokens'))
    writes = usage.get('cache_write_input_tokens', 0)
    if cached > inp:
        return None, 'cached input exceeds input'
    if writes and rule.get('cache_write_in_input') not in (True, False):
        return None, 'cache-write accounting unknown'
    uncached = inp - cached - (writes if rule.get('cache_write_in_input') else 0)
    if uncached < 0:
        return None, 'overlapping input buckets'
    rates = rule.get('usd_per_million', {})
    if any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in rates.values()):
        return None, 'invalid rates'
    if 'cache_write' in rates and rates['cache_write'] and 'cache_write_input_tokens' not in usage:
        return None, 'cache-write usage unavailable'
    buckets = {'input': uncached, 'cached_input': cached, 'cache_write': writes, 'output': out}
    if any(v and k not in rates for k, v in buckets.items()):
        return None, 'required rate missing'
    multipliers = {}
    long = rule.get('long_context')
    if long:
        if call.get('source') == 'cumulative_delta' and call.get('precision') != 'last_call':
            return None, 'request boundaries unavailable for long-context pricing'
        if long.get('scope') != 'request':
            return None, 'session-level long-context pricing requires manual calculation'
        if inp > long['threshold']:
            multipliers = long['multipliers']
    value = sum(v * rates.get(k, 0) * multipliers.get(k, 1) for k, v in buckets.items()) / 1_000_000
    return value, None


def summarize(calls, prices):
    result = {'calls': len(calls), 'tokens': {k: 0 for k in FIELDS}, 'priced_calls': 0,
              'unpriced_calls': 0, 'known_cost_usd': 0.0, 'unpriced_reasons': {}}
    for call in calls:
        for k in FIELDS:
            result['tokens'][k] += call['usage'].get(k, 0)
        cost, reason = price_call(call, prices)
        if cost is None:
            result['unpriced_calls'] += 1
            result['unpriced_reasons'][reason] = result['unpriced_reasons'].get(reason, 0) + 1
        else:
            result['priced_calls'] += 1
            result['known_cost_usd'] += cost
    result['known_cost_usd'] = round(result['known_cost_usd'], 8)
    return result


def analyze(paths, skill, skill_path, prices=None, since=None, until=None, top=10, excerpt_chars=600):
    sessions, errors, seen = [], [], set()
    scanned = 0
    for path in paths:
        scanned += 1
        try:
            data = read_session(path, skill, skill_path, excerpt_chars)
        except (OSError, ValueError, UnicodeError) as exc:
            errors.append({'path': str(path), 'error': str(exc)[:300]})
            continue
        if not data['hits']:
            continue
        calls = []
        for c in sorted(data['calls'], key=lambda x: x['timestamp']):
            day = c['timestamp'][:10]
            if (since and day < since) or (until and day > until):
                continue
            key = ('response', c['response_id']) if c['response_id'] else (
                c['session'], c['turn'], c['timestamp'], json.dumps(c['usage'], sort_keys=True))
            if key in seen:
                continue
            seen.add(key)
            calls.append(c)
        related = [c for c in calls if c['turn'] in data['hits']]
        if not related and (since or until):
            continue
        if not calls and any(x['session'] == data['session'] for x in sessions):
            continue
        sessions.append({'session': data['session'], 'path': data['path'],
                         'session_usage_in_date_range': summarize(calls, prices),
                         'candidate_turn_usage': summarize(related, prices),
                         'models': sorted({c['model'] or 'unknown' for c in calls}),
                         'candidate_turns': [{'turn': t, 'evidence': h, 'tool_samples': data['actions'].get(t, [])}
                                             for t, h in data['hits'].items()
                                             if not (since or until) or any(c['turn'] == t for c in related)],
                         'call_samples': related[:10], 'warnings': data['warnings']})
    sessions.sort(key=lambda s: (s['candidate_turn_usage']['known_cost_usd'],
                                 s['candidate_turn_usage']['tokens']['input_tokens']), reverse=True)
    return {'skill': skill, 'files_scanned': scanned, 'candidate_sessions': len(sessions),
            'price_as_of': (prices or {}).get('as_of'),
            'scope': 'Candidate turns are associated context, not exclusive skill cost. Confirm evidence before editing.',
            'pricing_basis': (prices or {}).get('models', {}),
            'sessions': sessions[:top], 'omitted_sessions': max(0, len(sessions) - top), 'errors': errors}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--skill', required=True, help='Exact skill slug')
    p.add_argument('--skill-path', required=True, help='Target skill directory')
    p.add_argument('--history-root', action='append', help='Repeatable; defaults to CODEX_HOME sessions and archived_sessions')
    p.add_argument('--session', action='append', help='Exact session UUID or rollout filename; repeatable')
    p.add_argument('--since', type=dt.date.fromisoformat)
    p.add_argument('--until', type=dt.date.fromisoformat)
    p.add_argument('--prices', type=Path, help='Verified API price JSON; omitted means token-only analysis')
    p.add_argument('--top', type=int, default=10)
    p.add_argument('--excerpt-chars', type=int, default=600)
    args = p.parse_args()
    if args.top < 1 or args.excerpt_chars < 0 or (args.since and args.until and args.since > args.until):
        p.error('invalid limits or date range')
    home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    roots = [Path(x).expanduser() for x in args.history_root] if args.history_root else [home / 'sessions', home / 'archived_sessions']
    paths = sorted({f for root in roots for f in root.rglob('*.jsonl*')
                    if f.name.endswith(('.jsonl', '.jsonl.zst'))})
    if args.session:
        paths = [f for f in paths if any(s == f.name or f.name.endswith(s + '.jsonl') or f.name.endswith(s + '.jsonl.zst') for s in args.session)]
    prices = json.loads(args.prices.read_text()) if args.prices else None
    report = analyze(paths, args.skill, args.skill_path, prices,
                     str(args.since) if args.since else None, str(args.until) if args.until else None,
                     args.top, args.excerpt_chars)
    report['missing_history_roots'] = [str(r) for r in roots if not r.exists()]
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == '__main__':
    main()
