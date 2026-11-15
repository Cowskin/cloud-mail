"""Restore a downloaded gzip SQL into a NEW LOCAL SQLite file; never connects to Cloudflare."""
import argparse
import gzip
import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
parser.add_argument('destination', type=Path)
args = parser.parse_args()
if args.destination.exists():
    raise SystemExit('Refusing to overwrite an existing restore database')
os.umask(0o077)
digest = hashlib.sha256()
with args.source.open('rb') as stream:
    while chunk := stream.read(1024 * 1024):
        digest.update(chunk)
db = sqlite3.connect(args.destination)
# Disposable local restore; retain the source dump and verify the completed database.
db.execute('PRAGMA journal_mode=WAL')
db.execute('PRAGMA synchronous=NORMAL')
statement = ''
with gzip.open(args.source, 'rt', encoding='utf-8') as dump:
    for line in dump:
        statement += line
        if sqlite3.complete_statement(statement):
            db.executescript(statement)
            statement = ''
if statement.strip():
    raise SystemExit('Incomplete SQL at end of backup')
integrity = [r[0] for r in db.execute('PRAGMA integrity_check')]
if integrity != ['ok']:
    raise SystemExit('SQLite integrity verification failed')
tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
if not {'email', 'account', 'user'}.issubset(tables):
    raise SystemExit('Backup is missing required mail tables')
counts = {name: db.execute('SELECT COUNT(*) FROM "' + name + '"').fetchone()[0]
          for name in ['email', 'account', 'user', 'attachments', 'inbox_batch_group', 'inbox_batch_member'] if name in tables}
latest = db.execute('SELECT create_time FROM email ORDER BY email_id DESC LIMIT 1').fetchone()
db.close()
report = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'compressedBytes': args.source.stat().st_size,
          'restoredBytes': args.destination.stat().st_size, 'sha256': digest.hexdigest(), 'integrity': 'ok',
          'newestRowCreatedAt': latest[0] if latest else None, 'counts': counts}
args.destination.with_suffix('.report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
