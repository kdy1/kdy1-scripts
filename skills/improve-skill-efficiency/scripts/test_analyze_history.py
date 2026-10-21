import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from analyze_history import PREFIX, analyze, connect, evidence, price_turn


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'statev2.sqlite'
        self.writer = sqlite3.connect(self.path)
        self.addCleanup(self.writer.close)
        # The columns used by the reader match T3's v2 SQLite projections.
        schemas = {
            'threads': 'thread_id TEXT PRIMARY KEY, title TEXT, archived_at TEXT, deleted_at TEXT',
            'runs': 'run_id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT',
            'nodes': 'node_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT',
            'messages': 'message_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, role TEXT, created_at TEXT, payload_json TEXT',
            'turn_items': 'turn_item_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, provider_turn_id TEXT, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT',
            'provider_turns': 'provider_turn_id TEXT PRIMARY KEY, thread_id TEXT, provider_thread_id TEXT, node_id TEXT, completed_at TEXT, started_at TEXT, payload_json TEXT',
            'subagents': 'subagent_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, payload_json TEXT',
        }
        for table, columns in schemas.items():
            self.writer.execute('CREATE TABLE ' + PREFIX + table + ' (' + columns + ')')
        self.usage = dict(usageStatus='complete', usageScope='main_agent', hasSubagents=False,
                          inputTokens=100, cachedInputTokens=40, cacheCreationTokens=10,
                          outputTokens=20, reasoningTokens=5)
        self.prices = {'as_of': '2026-10-21', 'models': {'model-a': {
            'source': 'https://example.com/pricing', 'basis': 'test fixture',
            'usd_per_million': dict(input=2, cached_input=0.2, cache_write=2.5, output=10)}}}
        self.add_thread('thread-a', archived=True)
        self.add_run('run-a', 'thread-a', 'model-a')
        self.add_run('run-b', 'thread-a', 'model-b')
        self.add_message('message-a', 'thread-a', 'run-a', '$demo run')
        self.add_turn('turn-a', 'thread-a', 'run-a')
        self.add_turn('turn-b', 'thread-a', 'run-b')
        self.add_item('item-a', 'thread-a', 'run-a', {'input': 'cat /skills/demo/SKILL.md', 'output': 'x' * 5000})

    def insert(self, table, **values):
        self.writer.execute('INSERT INTO ' + PREFIX + table + ' (' + ','.join(values) + ') VALUES (' +
                            ','.join('?' for _ in values) + ')', tuple(values.values()))
        self.writer.commit()

    def add_thread(self, tid, archived=False):
        self.insert('threads', thread_id=tid, title=tid, archived_at='2026-10-20' if archived else None, deleted_at=None)

    def add_run(self, rid, tid, model):
        self.insert('runs', run_id=rid, thread_id=tid, payload_json=json.dumps({
            'id': rid, 'rootNodeId': rid + '-node',
            'modelSelection': {'instanceId': 'provider-a', 'model': model,
                               'options': [{'id': 'reasoningEffort', 'value': 'medium'}]}}))
        self.insert('nodes', node_id=rid + '-node', thread_id=tid, run_id=rid)

    def add_message(self, mid, tid, rid, text):
        self.insert('messages', message_id=mid, thread_id=tid, run_id=rid, role='user',
                    created_at='2026-10-20T10:00:00Z', payload_json=json.dumps({'text': text}))

    def add_turn(self, turn, tid, rid, usage=None, stamp='2026-10-20T10:01:00Z', node=None):
        self.insert('provider_turns', provider_turn_id=turn, thread_id=tid, provider_thread_id=tid + '-provider',
                    node_id=node or rid + '-node', completed_at=stamp, started_at='2026-10-19T23:59:00Z',
                    payload_json=json.dumps({'turnTokenUsage': usage if usage is not None else self.usage,
                                             'tokenUsage': {'inputTokens': 999999, 'outputTokens': 999999}}))

    def add_item(self, item, tid, rid, p):
        self.insert('turn_items', turn_item_id=item, thread_id=tid, run_id=rid, provider_turn_id=None,
                    type='command_execution', status='completed', updated_at='2026-10-20T10:00:30Z',
                    payload_json=json.dumps(p))

    def report(self, **kwargs):
        with connect(self.path) as db:
            return analyze(db, 'demo', '/skills/demo', self.prices, **kwargs)

    def test_scope_models_archives_and_no_mirror_double_count(self):
        result = self.report()
        self.assertEqual(result['matched_threads'], 1)
        s = result['sessions'][0]
        self.assertTrue(s['archived'])
        self.assertEqual(s['thread_usage_in_date_range']['provider_turns'], 2)
        self.assertEqual(s['selected_run_usage']['provider_turns'], 1)
        self.assertEqual(s['models'], ['model-a', 'model-b'])
        self.assertEqual(s['selected_run_usage']['tokens']['input_tokens'], 100)
        self.assertEqual(s['turn_samples'][0]['model_options'][0]['value'], 'medium')
        self.assertAlmostEqual(s['selected_run_usage']['known_cost_usd'], (50*2 + 40*.2 + 10*2.5 + 20*10)/1e6)
        self.assertEqual(s['runs'][0]['tool_samples'][0]['output_characters'], 5000)
        self.assertEqual(len(s['runs'][0]['tool_samples'][0]['output_excerpt']), 600)

    def test_explicit_thread_scope_unknown_ids_and_dates(self):
        s = self.report(threads=['thread-a'])['sessions'][0]
        self.assertEqual(s['selected_run_usage']['provider_turns'], 2)
        self.assertEqual(s['selected_run_usage']['unpriced_turns'], 1)
        self.assertEqual(self.report(threads=['missing'])['errors'][0]['thread_id'], 'missing')
        self.assertEqual(self.report(since='2026-10-21')['matched_threads'], 0)
        self.assertEqual(self.report(since='2026-10-20', until='2026-10-20')['matched_threads'], 1)

    def test_catalog_quotes_and_edit_candidates(self):
        for text in ('Available skills: demo /skills/demo/SKILL.md', '```$demo```', '<skill>$demo</skill>'):
            self.assertIsNone(evidence(text, 'demo', '/skills/demo', user=True))
        # Editing requests are deliberately candidates requiring human/model judgment.
        self.assertEqual(evidence('$demo update its instructions', 'demo', '/skills/demo', user=True),
                         'explicit_invocation_candidate')

    def test_literal_search(self):
        self.add_thread('natural')
        self.add_run('natural-run', 'natural', 'model-a')
        self.add_message('natural-msg', 'natural', 'natural-run', 'Use Demo Skill please')
        self.assertEqual(self.report()['matched_threads'], 1)
        self.assertEqual(self.report(match_text=['Demo Skill'])['matched_threads'], 2)

    def test_partial_missing_and_last_response_not_substituted(self):
        self.add_turn('partial', 'thread-a', 'run-a', dict(self.usage, usageStatus='partial'))
        self.add_turn('missing', 'thread-a', 'run-a', {})
        s = self.report()['sessions'][0]['selected_run_usage']
        self.assertEqual(s['priced_turns'], 1)
        self.assertEqual(s['unpriced_turns'], 2)
        self.assertEqual(s['tokens']['input_tokens'], 200)
        self.assertEqual(s['missing_token_fields']['input_tokens'], 1)
        self.assertEqual(s['usage_statuses'], {'complete': 1, 'partial': 1, 'unavailable': 1})

    def test_child_links_separate_usage_and_unknown_model(self):
        self.insert('subagents', subagent_id='child-task', thread_id='thread-a', run_id='run-a',
                    payload_json=json.dumps({'id': 'child-task', 'childThreadId': 'child', 'runId': 'run-a'}))
        self.add_thread('child')
        self.add_run('child-run', 'child', 'model-a')
        self.add_turn('child-turn', 'child', 'child-run')
        self.insert('nodes', node_id='native-child-node', thread_id='thread-a', run_id='run-a')
        self.add_turn('native-child', 'thread-a', 'run-a', node='native-child-node')
        s = self.report()['sessions'][0]
        self.assertEqual(s['linked_subagents'][0]['childThreadId'], 'child')
        self.assertEqual(s['selected_run_usage']['provider_turns'], 2)
        self.assertEqual(s['selected_run_usage']['priced_turns'], 1)
        self.assertEqual(self.report(threads=['child'])['sessions'][0]['selected_run_usage']['provider_turns'], 1)

    def test_bad_json_and_unlinked_usage(self):
        self.add_turn('unlinked', 'thread-a', 'run-a', node='absent')
        self.writer.execute('UPDATE ' + PREFIX + "turn_items SET payload_json = '{bad' WHERE turn_item_id = 'item-a'")
        self.writer.commit()
        s = self.report()['sessions'][0]
        self.assertEqual(len(s['warnings']), 2)
        self.assertEqual(s['thread_usage_in_date_range']['provider_turns'], 3)
        self.assertEqual(s['selected_run_usage']['provider_turns'], 1)

    def test_disjoint_buckets_missing_fields_and_long_context(self):
        call = self.report()['sessions'][0]['turn_samples'][0]
        self.assertIsNotNone(price_turn(call, self.prices)[0])
        call['usage'].pop('cache_write_input_tokens')
        self.assertEqual(price_turn(call, self.prices)[1], 'cache-write usage unavailable')
        rule = self.prices['models']['model-a']
        rule['long_context'] = {'scope': 'request', 'threshold': 99, 'multipliers': {}}
        self.assertEqual(price_turn(call, self.prices)[1], 'cache-write usage unavailable')
        call['usage']['cache_write_input_tokens'] = 10
        self.assertEqual(price_turn(call, self.prices)[1], 'request boundaries unavailable for long-context pricing')
        rule['long_context']['scope'] = 'session'
        self.assertIsNone(price_turn(call, self.prices)[0])

    def test_invalid_tokens_and_prices(self):
        self.add_turn('invalid', 'thread-a', 'run-a', dict(self.usage, inputTokens='bad'))
        s = self.report()['sessions'][0]['selected_run_usage']
        self.assertEqual(s['unpriced_reasons']['invalid token counts'], 1)
        call = self.report()['sessions'][0]['turn_samples'][0]
        for value in (-1, float('nan'), True):
            call['usage']['input_tokens'] = value
            self.assertEqual(price_turn(call, self.prices)[1], 'invalid token counts')

    def test_read_only_wal_snapshot_and_no_creation(self):
        self.writer.execute('PRAGMA journal_mode=WAL').fetchall()
        self.add_thread('wal-writer')
        with connect(self.path) as db:
            count = db.execute('SELECT COUNT(*) FROM ' + PREFIX + 'threads').fetchone()[0]
            self.add_thread('later')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM ' + PREFIX + 'threads').fetchone()[0], count)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute('DELETE FROM ' + PREFIX + 'threads')
        with connect(self.path) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM ' + PREFIX + 'threads').fetchone()[0], count + 1)
        missing = self.path.parent / 'missing.sqlite'
        with self.assertRaises(sqlite3.OperationalError):
            with connect(missing):
                pass
        self.assertFalse(missing.exists())

    def test_unscoped_evidence_does_not_attribute_unlinked_turn(self):
        self.add_thread('unscoped')
        self.add_message('unscoped-msg', 'unscoped', None, '$demo run')
        self.add_turn('unscoped-turn', 'unscoped', 'missing', node='missing')
        s = next(s for s in self.report()['sessions'] if s['thread_id'] == 'unscoped')
        self.assertEqual(s['thread_usage_in_date_range']['provider_turns'], 1)
        self.assertEqual(s['selected_run_usage']['provider_turns'], 0)

    def test_zero_cache_rate_still_needs_write_count(self):
        call = self.report()['sessions'][0]['turn_samples'][0]
        call['usage'].pop('cache_write_input_tokens')
        self.prices['models']['model-a']['usd_per_million']['cache_write'] = 0
        self.assertEqual(price_turn(call, self.prices)[1], 'cache-write usage unavailable')

    def test_cli_item_and_failure_exit(self):
        cmd = [sys.executable, str(Path(__file__).with_name('analyze_history.py')), '--skill', 'demo',
               '--skill-path', '/skills/demo', '--database', str(self.path)]
        result = subprocess.run(cmd + ['--item', 'item-a', '--excerpt-chars', '25'], capture_output=True, text=True, check=True)
        self.assertEqual(len(json.loads(result.stdout)['item']['output_excerpt']), 25)
        message = subprocess.run(cmd + ['--message', 'message-a'], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(message.stdout)['text_excerpt'], '$demo run')
        for args in (['--item', 'absent'], ['--history-root', '/tmp'], ['--since', 'bad']):
            self.assertNotEqual(subprocess.run(cmd + args, capture_output=True).returncode, 0)
        self.assertNotEqual(subprocess.run(cmd + ['--database', str(self.path.parent / 'missing')], capture_output=True).returncode, 0)


if __name__ == '__main__':
    unittest.main()
