import type { DatabaseSync } from 'node:sqlite';

/** Transactional projection of Run custody. Only migration scans historical Runs; reads use the active channel index. */
export function migrateQuotaWaits(db: DatabaseSync): void {
  // Projection is not snapshot authority. Preserve corrupt bytes for the canonical Run reader's RUN_STORE_CORRUPT refusal.
  // CASE guards JSON parsing in both historical backfill and triggers, regardless of SQL predicate evaluation order.
  const insert = (scope: string, run: string, snapshot: string) => `INSERT INTO run_quota_waits
    SELECT ${scope},${run},json_extract(q.value,'$.identity.attemptId'),json_extract(q.value,'$.channelId'),
      json_extract(q.value,'$.since'),json_extract(q.value,'$.deadline'),json_extract(q.value,'$.quota.resetsAtMs'),
      json_extract(q.value,'$.releasedAtMs'),CASE WHEN json_extract(q.value,'$.quota.source')='claude-rate-limit'
        AND json_extract(q.value,'$.quota.resetsAtMs')>json_extract(q.value,'$.since')
        AND COALESCE(json_extract(q.value,'$.resetBoundExceeded'),0)=0 THEN 1 ELSE 0 END
    FROM json_each(CASE WHEN json_valid(${snapshot}) THEN ${snapshot} ELSE NULL END,'$.quotaWaits') q;`;
  db.exec(`CREATE TABLE run_quota_waits(scope_id TEXT NOT NULL,run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,since_ms INTEGER NOT NULL,deadline_ms INTEGER NOT NULL,resets_at_ms INTEGER,
    released_at_ms INTEGER,channel_held INTEGER NOT NULL CHECK(channel_held IN(0,1)),PRIMARY KEY(scope_id,run_id,attempt_id));
    CREATE INDEX run_quota_waits_active ON run_quota_waits(channel_id,deadline_ms DESC) WHERE released_at_ms IS NULL;
    CREATE INDEX run_quota_waits_channel ON run_quota_waits(channel_id,deadline_ms DESC) WHERE released_at_ms IS NULL AND channel_held=1;
    ${insert('r.scope_id', 'r.run_id', 'r.snapshot').replace('FROM json_each', 'FROM runs r, json_each')}
    CREATE TRIGGER run_quota_waits_insert AFTER INSERT ON runs BEGIN ${insert('NEW.scope_id', 'NEW.run_id', 'NEW.snapshot')} END;
    CREATE TRIGGER run_quota_waits_update AFTER UPDATE OF snapshot ON runs BEGIN
      DELETE FROM run_quota_waits WHERE scope_id=NEW.scope_id AND run_id=NEW.run_id;
      ${insert('NEW.scope_id', 'NEW.run_id', 'NEW.snapshot')} END;
    CREATE TRIGGER run_quota_waits_delete AFTER DELETE ON runs BEGIN
      DELETE FROM run_quota_waits WHERE scope_id=OLD.scope_id AND run_id=OLD.run_id; END;
    CREATE TABLE quota_release_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id));
    PRAGMA user_version=54;`);
}
