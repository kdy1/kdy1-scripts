import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from analyze_history import analyze, evidence, price_call, read_session


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.usage = dict(input_tokens=100, cached_input_tokens=40, cache_write_input_tokens=10,
                          output_tokens=20, reasoning_output_tokens=5)
        self.prices = {'as_of': '2026-10-17', 'models': {'model-a': {
            'source': 'https://developers.openai.com/example', 'basis': 'test fixture',
            'cache_write_in_input': True,
            'usd_per_million': dict(input=2, cached_input=0.2, cache_write=2.5, output=10)}}}

    def rows(self):
        return [
            ('session_meta', {'id': 'session-a'}),
            ('turn_context', {'turn_id': 'turn-a', 'model': 'model-a'}),
            ('response_item', {'type': 'message', 'role': 'user', 'content': [{'text': '$demo run'}]}),
            ('token_usage_record', {'response_id': 'resp-a', 'turn_id': 'turn-a', 'usage': self.usage}),
            ('event_msg', {'type': 'token_count', 'info': {'total_token_usage': self.usage, 'last_token_usage': self.usage}}),
            ('turn_context', {'turn_id': 'turn-b', 'model': 'model-b'}),
            ('token_usage_record', {'response_id': 'resp-b', 'turn_id': 'turn-b', 'usage': self.usage}),
        ]

    def write(self, rows, name='one.jsonl'):
        path = self.root / name
        path.write_text(''.join(json.dumps({'timestamp': '2026-10-17T00:00:%02dZ' % i,
                                           'type': t, 'payload': p}) + '\n' for i, (t, p) in enumerate(rows)))
        return path

    def test_no_catalog_activation(self):
        for role in ('system', 'developer', 'user'):
            self.assertIsNone(evidence({'type': 'message', 'role': role,
                                       'content': [{'text': 'Available skills: demo /skills/demo/SKILL.md'}]}, 'demo', '/skills/demo'))
        self.assertIsNone(evidence({'type': 'message', 'role': 'user',
                                   'content': [{'text': '```$demo```'}]}, 'demo', '/skills/demo'))

    def test_usage_precedence_dedup_scope_and_models(self):
        a = self.write(self.rows())
        b = self.root / 'copy.jsonl'
        shutil.copyfile(a, b)
        report = analyze([a, b], 'demo', '/skills/demo', self.prices)
        self.assertEqual(report['candidate_sessions'], 1)
        s = report['sessions'][0]
        self.assertEqual(s['session_usage_in_date_range']['calls'], 2)
        self.assertEqual(s['candidate_turn_usage']['calls'], 1)
        self.assertEqual(s['session_usage_in_date_range']['unpriced_calls'], 1)
        self.assertEqual(s['models'], ['model-a', 'model-b'])

    def test_disjoint_buckets_and_reasoning(self):
        cost, error = price_call({'model': 'model-a', 'usage': self.usage}, self.prices)
        self.assertIsNone(error)
        self.assertAlmostEqual(cost, (50*2 + 40*0.2 + 10*2.5 + 20*10)/1e6)
        rule = self.prices['models']['model-a']
        rule.pop('cache_write_in_input')
        self.assertIsNone(price_call({'model': 'model-a', 'usage': self.usage}, self.prices)[0])

    def test_long_context_and_missing_data(self):
        rule = self.prices['models']['model-a']
        rule['long_context'] = {'scope': 'request', 'threshold': 99,
                                'multipliers': dict(input=2, cached_input=2, cache_write=2, output=1.5)}
        call = {'model': 'model-a', 'usage': self.usage}
        self.assertAlmostEqual(price_call(call, self.prices)[0], (100*2 + 8*2 + 25*2 + 200*1.5)/1e6)
        rule['long_context']['scope'] = 'session'
        self.assertIsNone(price_call(call, self.prices)[0])
        self.assertIsNone(price_call({'model': 'model-a', 'usage': {}}, self.prices)[0])
        self.assertIsNone(price_call({'model': 'unknown', 'usage': self.usage}, self.prices)[0])

    def test_invalid_prices_and_ambiguous_intervals(self):
        rule = self.prices['models']['model-a']
        call = {'model': 'model-a', 'usage': self.usage, 'source': 'cumulative_delta'}
        rule['long_context'] = {'scope': 'request', 'threshold': 99, 'multipliers': {}}
        self.assertIsNone(price_call(call, self.prices)[0])
        rule.pop('long_context')
        rule['usd_per_million']['input'] = -1
        self.assertIsNone(price_call(call, self.prices)[0])

    def test_legacy_deltas_and_repeated_snapshots(self):
        rows = self.rows()[:3]
        for amount in (100, 100, 150):
            u = dict(input_tokens=amount, cached_input_tokens=0, output_tokens=0)
            rows.append(('event_msg', {'type': 'token_count', 'info': {'total_token_usage': u, 'last_token_usage': u}}))
        result = read_session(self.write(rows), 'demo', '/skills/demo', 100)
        self.assertEqual([c['usage']['input_tokens'] for c in result['calls']], [100, 50])

    def test_missing_baseline_dates_and_bad_json(self):
        rows = self.rows()[:3] + [('event_msg', {'type': 'token_count', 'info': {'total_token_usage': self.usage}})]
        path = self.write(rows)
        with path.open('a') as f:
            f.write('{bad\n')
        result = read_session(path, 'demo', '/skills/demo', 100)
        self.assertEqual(result['calls'], [])
        self.assertEqual(len(result['warnings']), 2)
        self.assertEqual(analyze([path], 'demo', '/skills/demo', since='2027-01-01')['candidate_sessions'], 0)

    @unittest.skipUnless(shutil.which('zstd'), 'zstd unavailable')
    def test_compressed_identical(self):
        path = self.write(self.rows())
        compressed = path.with_suffix('.jsonl.zst')
        subprocess.run(['zstd', '-q', str(path), '-o', str(compressed)], check=True)
        a = read_session(path, 'demo', '/skills/demo', 100)
        b = read_session(compressed, 'demo', '/skills/demo', 100)
        self.assertEqual(a['calls'], b['calls'])
        self.assertEqual(a['hits'], b['hits'])


if __name__ == '__main__':
    unittest.main()
