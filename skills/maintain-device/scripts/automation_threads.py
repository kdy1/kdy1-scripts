#!/usr/bin/env python3
"""List T3 Code automation threads that are ready to archive.

An automation thread is a top-level thread that a scheduled task started: its
first run starts from a message whose id begins with `scheduled-task-message:`.
A scheduled task that sends its prompt into an existing thread does not make
that thread an automation thread, because the thread's first run came from a
human.

The helper opens the T3 Code state database read-only and changes nothing. The
agent archives each listed thread with the T3 tool `t3_thread_organize`, then
runs this helper again to confirm that no candidate is left.
"""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import sys

HOUR = 3600
SCHEDULED_MESSAGE_PREFIX = "scheduled-task-message:"
ACTIVE_RUN_STATUSES = ("preparing", "queued", "starting", "running", "waiting")

QUERY = """
WITH first_runs AS (
  SELECT r.thread_id, r.payload_json
  FROM orchestration_v2_projection_runs r
  WHERE r.ordinal = (
    SELECT MIN(r2.ordinal) FROM orchestration_v2_projection_runs r2
    WHERE r2.thread_id = r.thread_id
  )
)
SELECT
  t.thread_id,
  t.title,
  t.created_at,
  t.payload_json,
  json_extract(f.payload_json, '$.userMessageId') AS first_message_id,
  (SELECT MAX(COALESCE(r.completed_at, r.requested_at))
     FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id) AS last_run_at,
  (SELECT MAX(m.updated_at)
     FROM orchestration_v2_projection_messages m WHERE m.thread_id = t.thread_id) AS last_message_at,
  (SELECT COUNT(*)
     FROM orchestration_v2_projection_runs r
     WHERE r.thread_id = t.thread_id AND r.status IN ({active})) AS active_runs
FROM orchestration_v2_projection_threads t
JOIN first_runs f ON f.thread_id = t.thread_id
WHERE t.archived_at IS NULL
  AND t.deleted_at IS NULL
  AND json_extract(f.payload_json, '$.userMessageId') LIKE '{prefix}%'
""".format(
    active=", ".join("'%s'" % status for status in ACTIVE_RUN_STATUSES),
    prefix=SCHEDULED_MESSAGE_PREFIX,
)


def default_db():
    home = os.environ.get("T3CODE_HOME")
    base = Path(home) if home else Path.home() / ".t3"
    return base / "userdata" / "statev2.sqlite"


def parse_time(value):
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def iso(stamp):
    return dt.datetime.fromtimestamp(stamp, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def scheduled_task_id(message_id):
    """`scheduled-task-message:scheduled-task:<uuid>:<ms>:<trigger>` -> `scheduled-task:<uuid>`."""
    parts = message_id[len(SCHEDULED_MESSAGE_PREFIX):].split(":")
    return ":".join(parts[:2]) if len(parts) >= 2 else None


def connect(db):
    connection = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def task_titles(connection):
    try:
        rows = connection.execute("SELECT task_id, title FROM scheduled_tasks").fetchall()
    except sqlite3.Error:
        return {}
    return {row["task_id"]: row["title"] for row in rows}


def collect(connection, idle_hours, exclude, now):
    """Return (candidates, skipped) for automation threads idle at least idle_hours."""
    titles = task_titles(connection)
    cutoff = now - idle_hours * HOUR
    candidates, skipped = [], []
    for row in connection.execute(QUERY):
        payload = json.loads(row["payload_json"] or "{}")
        lineage = payload.get("lineage") or {}
        task_id = scheduled_task_id(row["first_message_id"])
        stamps = [
            parse_time(value)
            for value in (row["created_at"], row["last_run_at"], row["last_message_at"])
        ]
        stamps = [stamp for stamp in stamps if stamp is not None]
        last_activity = max(stamps) if stamps else None
        item = {
            "threadId": row["thread_id"],
            "title": row["title"],
            "scheduledTaskId": task_id,
            "scheduledTaskTitle": titles.get(task_id),
            "lastActivityAt": iso(last_activity) if last_activity else None,
            "settled": bool(payload.get("settledAt")),
        }
        if row["thread_id"] in exclude:
            reason = "excluded"
        elif lineage.get("parentThreadId"):
            reason = "not-top-level"
        elif payload.get("pinnedAt"):
            reason = "pinned"
        elif row["active_runs"]:
            reason = "active-run"
        elif last_activity is None:
            reason = "unknown-activity"
        elif last_activity > cutoff:
            reason = "recent-activity"
        else:
            candidates.append(item)
            continue
        skipped.append(dict(item, reason=reason))
    candidates.sort(key=lambda item: item["lastActivityAt"])
    return candidates, skipped


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["list"])
    parser.add_argument("--idle-hours", type=float, default=48.0)
    parser.add_argument("--exclude-thread", action="append", default=[], metavar="THREAD_ID")
    parser.add_argument("--db", type=Path, default=None, help="T3 Code state database (default: ~/.t3/userdata/statev2.sqlite)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    db = args.db or default_db()
    if not db.is_file():
        print("T3 Code state database not found: %s" % db, file=sys.stderr)
        return 1
    try:
        with connect(db) as connection:
            candidates, skipped = collect(connection, args.idle_hours, set(args.exclude_thread), dt.datetime.now().timestamp())
    except sqlite3.Error as error:
        print("Cannot read %s: %s" % (db, error), file=sys.stderr)
        return 1

    reasons = {}
    for item in skipped:
        reasons[item["reason"]] = reasons.get(item["reason"], 0) + 1
    report = {
        "idleHours": args.idle_hours,
        "candidateCount": len(candidates),
        "unsettledCandidateCount": sum(1 for item in candidates if not item["settled"]),
        "candidates": candidates,
        "skippedByReason": reasons,
    }
    if args.json:
        json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        for item in candidates:
            print("%s  %s  %s" % (item["lastActivityAt"], item["threadId"], item["title"]))
        print("%d candidate(s); skipped: %s" % (len(candidates), reasons or "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
