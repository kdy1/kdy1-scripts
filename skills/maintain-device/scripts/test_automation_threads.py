"""Offline checks on a temporary SQLite file shaped like the T3 Code state database."""

import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import automation_threads as threads


NOW = threads.parse_time("2026-11-19T00:00:00Z")
OLD = "2026-11-10T00:00:00Z"
RECENT = "2026-11-18T12:00:00Z"
TASK = "scheduled-task:aaaa"


def scheduled(task=TASK):
    return "scheduled-task-message:%s:1794706955460:scheduled" % task


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "statev2.sqlite"
        self.conn = sqlite3.connect(str(self.db))
        self.conn.executescript(
            """
            CREATE TABLE orchestration_v2_projection_threads (
              thread_id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT,
              archived_at TEXT, deleted_at TEXT, payload_json TEXT);
            CREATE TABLE orchestration_v2_projection_runs (
              run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, status TEXT,
              requested_at TEXT, completed_at TEXT, payload_json TEXT);
            CREATE TABLE orchestration_v2_projection_messages (
              message_id TEXT PRIMARY KEY, thread_id TEXT, created_at TEXT, updated_at TEXT);
            CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY, title TEXT);
            """
        )
        self.conn.execute("INSERT INTO scheduled_tasks VALUES (?, ?)", (TASK, "Nightly scan"))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def thread(self, thread_id, first_message, at=OLD, status="completed", archived=None,
               settled=True, pinned=False, parent=None):
        payload = {
            "settledAt": at if settled else None,
            "pinnedAt": at if pinned else None,
            "lineage": {"parentThreadId": parent},
        }
        self.conn.execute(
            "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, NULL, ?)",
            (thread_id, thread_id, OLD, at, archived, json.dumps(payload)),
        )
        self.run_(thread_id, 1, first_message, at, status)

    def run_(self, thread_id, ordinal, message_id, at, status="completed"):
        self.conn.execute(
            "INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("%s:%d" % (thread_id, ordinal), thread_id, ordinal, status, at,
             None if status == "running" else at, json.dumps({"userMessageId": message_id})),
        )

    def collect(self, exclude=()):
        self.conn.commit()
        with threads.connect(self.db) as connection:
            return threads.collect(connection, 48, set(exclude), NOW)


class CollectTest(Fixture):
    def test_old_idle_automation_thread_is_a_candidate(self):
        self.thread("auto", scheduled())
        candidates, skipped = self.collect()
        self.assertEqual([c["threadId"] for c in candidates], ["auto"])
        self.assertEqual(candidates[0]["scheduledTaskId"], TASK)
        self.assertEqual(candidates[0]["scheduledTaskTitle"], "Nightly scan")
        self.assertEqual(skipped, [])

    def test_human_threads_and_scheduled_messages_in_existing_threads_are_ignored(self):
        self.thread("human", "message:1")
        self.run_("human", 2, scheduled(), OLD)
        self.assertEqual(self.collect(), ([], []))

    def test_recent_runs_and_messages_keep_a_thread(self):
        self.thread("followed-up", scheduled())
        self.run_("followed-up", 2, "message:2", RECENT)
        self.thread("messaged", scheduled())
        self.conn.execute(
            "INSERT INTO orchestration_v2_projection_messages VALUES ('m', 'messaged', ?, ?)",
            (RECENT, RECENT),
        )
        candidates, skipped = self.collect()
        self.assertEqual(candidates, [])
        self.assertEqual({s["reason"] for s in skipped}, {"recent-activity"})

    def test_active_pinned_child_excluded_and_archived_threads_are_kept(self):
        self.thread("running", scheduled(), status="running")
        self.thread("pinned", scheduled(), pinned=True)
        self.thread("child", scheduled(), parent="parent")
        self.thread("current", scheduled())
        self.thread("archived", scheduled(), archived=OLD)
        candidates, skipped = self.collect(exclude=["current"])
        self.assertEqual(candidates, [])
        reasons = {s["threadId"]: s["reason"] for s in skipped}
        self.assertEqual(
            reasons,
            {"running": "active-run", "pinned": "pinned", "child": "not-top-level", "current": "excluded"},
        )

    def test_unsettled_threads_are_candidates_and_reported(self):
        self.thread("open", scheduled(), settled=False)
        candidates, _ = self.collect()
        self.assertEqual([(c["threadId"], c["settled"]) for c in candidates], [("open", False)])


if __name__ == "__main__":
    unittest.main()
