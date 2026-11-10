-- Frozen v74 SQLite storage schema, exported from source at d4b436f3d; synthetic rows, never live data.
-- Every application table is populated; these are storage-shape probes, not domain acceptance records.
PRAGMA foreign_keys=ON;
BEGIN;
PRAGMA defer_foreign_keys=ON;
CREATE TABLE attempts(scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL, revision INTEGER NOT NULL,
    snapshot TEXT NOT NULL, PRIMARY KEY(scope_id, attempt_id));
CREATE TABLE attempt_receipts(scope_id TEXT NOT NULL, command_id TEXT NOT NULL, command TEXT NOT NULL,
    snapshot TEXT NOT NULL, PRIMARY KEY(scope_id, command_id));
CREATE TABLE dispatches(scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(scope_id, attempt_id));
CREATE TABLE runs(scope_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, policy TEXT NOT NULL, PRIMARY KEY(scope_id,run_id));
CREATE TABLE run_receipts(scope_id TEXT NOT NULL, command_id TEXT NOT NULL, command TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(scope_id,command_id));
CREATE TABLE execution_pools(pool_id TEXT PRIMARY KEY NOT NULL, policy TEXT NOT NULL);
CREATE TABLE cancellation_deliveries(scope_id TEXT NOT NULL,attempt_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,attempt_id));
CREATE TABLE run_workspace_custody(scope_id TEXT NOT NULL,run_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,run_id));
CREATE TABLE service_shutdown_commands(scope_id TEXT NOT NULL,service_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,service_id,command_id));
CREATE TABLE service_shutdown_outcomes(scope_id TEXT NOT NULL,service_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,service_id,command_id));
CREATE TABLE installation_ownership(singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),record TEXT NOT NULL);
CREATE TABLE model_activations(scope_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_version INTEGER NOT NULL,
    model_id TEXT NOT NULL,model_version INTEGER NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,provider_id,provider_version,model_id,model_version));
CREATE TABLE model_activation_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,command_id));
CREATE TABLE "model_invocations"(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
        allocation_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('claimed','responded','unknown','rejected','not-sent')),
        record TEXT NOT NULL,PRIMARY KEY(scope_id,invocation_id),UNIQUE(scope_id,command_id));
CREATE TABLE model_invocation_controls(scope_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
        send_state TEXT NOT NULL CHECK(send_state IN ('pending','permitted','prevented','unobserved')),record TEXT NOT NULL,
        PRIMARY KEY(scope_id,invocation_id),FOREIGN KEY(scope_id,invocation_id) REFERENCES "model_invocations"(scope_id,invocation_id));
CREATE TABLE model_invocation_cancellations(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
        record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id),UNIQUE(scope_id,invocation_id),
        FOREIGN KEY(scope_id,invocation_id) REFERENCES "model_invocations"(scope_id,invocation_id));
CREATE TABLE "model_invocation_content_purges"(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id),UNIQUE(scope_id,invocation_id),
        FOREIGN KEY(scope_id,invocation_id) REFERENCES "model_invocations"(scope_id,invocation_id));
CREATE TABLE "model_invocation_contents"(scope_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
        record TEXT,purge_command_id TEXT,PRIMARY KEY(scope_id,invocation_id),
        CHECK((record IS NOT NULL AND purge_command_id IS NULL) OR (record IS NULL AND purge_command_id IS NOT NULL)),
        FOREIGN KEY(scope_id,invocation_id) REFERENCES "model_invocations"(scope_id,invocation_id),
        FOREIGN KEY(scope_id,purge_command_id) REFERENCES "model_invocation_content_purges"(scope_id,command_id));
CREATE INDEX model_invocations_allocation_state ON model_invocations(scope_id,allocation_id,state);
CREATE INDEX model_invocations_allocation_identity
      ON model_invocations(scope_id,allocation_id,invocation_id COLLATE BINARY);
CREATE TABLE provider_spend_accounts(scope_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>=1),reservation_count INTEGER NOT NULL CHECK(reservation_count>=0),
      digest TEXT NOT NULL,record TEXT NOT NULL);
CREATE TABLE model_invocation_spend_reservations(scope_id TEXT NOT NULL,invocation_id TEXT NOT NULL,digest TEXT NOT NULL,record TEXT NOT NULL,
      PRIMARY KEY(scope_id,invocation_id),FOREIGN KEY(scope_id) REFERENCES provider_spend_accounts(scope_id),
      FOREIGN KEY(scope_id,invocation_id) REFERENCES model_invocations(scope_id,invocation_id));
CREATE TABLE provider_spend_audits(sequence INTEGER PRIMARY KEY AUTOINCREMENT,scope_id TEXT NOT NULL,
    budget_id TEXT NOT NULL,budget_revision INTEGER NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,digest TEXT NOT NULL,
    UNIQUE(scope_id,command_id));
CREATE INDEX provider_spend_audits_budget_latest
      ON provider_spend_audits(scope_id,budget_id,budget_revision,sequence DESC);
CREATE TABLE run_execution_intents(scope_id TEXT NOT NULL,run_id TEXT NOT NULL,actor_id TEXT NOT NULL,
    issuer TEXT NOT NULL,subject TEXT NOT NULL,admitted_at INTEGER NOT NULL,command_id TEXT NOT NULL,
    PRIMARY KEY(scope_id,run_id), UNIQUE(scope_id,command_id));
CREATE INDEX run_execution_intents_actor ON run_execution_intents(actor_id,issuer,subject,scope_id,run_id);
CREATE TABLE task_evaluation_observations(scope_id TEXT NOT NULL,run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
    attempt_revision INTEGER NOT NULL CHECK(attempt_revision>0),PRIMARY KEY(scope_id,run_id,attempt_id,attempt_revision));
CREATE TABLE workspace_integrations(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,intent TEXT NOT NULL,manifest TEXT,
    PRIMARY KEY(scope_id,command_id));
CREATE TABLE approval_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,operation TEXT NOT NULL,fingerprint TEXT NOT NULL,
    snapshot TEXT NOT NULL,PRIMARY KEY(scope_id,command_id));
CREATE TABLE approval_outbox(scope_id TEXT NOT NULL,approval_id TEXT NOT NULL,revision INTEGER NOT NULL,
    snapshot TEXT NOT NULL,PRIMARY KEY(scope_id,approval_id,revision));
CREATE TABLE workspace_deliveries(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,
    intent TEXT NOT NULL,delivered INTEGER NOT NULL CHECK(delivered IN(0,1)),PRIMARY KEY(scope_id,command_id));
CREATE TABLE effect_intents(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence>0),idempotency_key_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('claimed','settled','unknown','refused')),
    record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id),UNIQUE(scope_id,idempotency_key_hash),UNIQUE(target_kind,target_id,sequence));
CREATE TABLE worker_event_logs(scope_id TEXT NOT NULL,attempt_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,attempt_id));
CREATE TABLE "model_invocation_allocations"(scope_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
    max_calls INTEGER CHECK(max_calls IS NULL OR max_calls>0),max_in_flight INTEGER NOT NULL,lifetime_calls INTEGER NOT NULL,in_flight INTEGER NOT NULL,
    record TEXT NOT NULL,PRIMARY KEY(scope_id,allocation_id));
CREATE TABLE "model_invocation_allocation_checkpoints"(scope_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>=1),digest TEXT NOT NULL,PRIMARY KEY(scope_id,allocation_id),
      FOREIGN KEY(scope_id,allocation_id) REFERENCES "model_invocation_allocations"(scope_id,allocation_id));
CREATE TABLE agent_turns(scope_id TEXT NOT NULL,turn_id TEXT NOT NULL,principal_key TEXT NOT NULL,request_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','finished')),record TEXT NOT NULL,PRIMARY KEY(scope_id,turn_id));
CREATE TABLE agent_turn_tool_calls(scope_id TEXT NOT NULL,turn_id TEXT NOT NULL,round INTEGER NOT NULL CHECK(round>=1),
    call_index INTEGER NOT NULL CHECK(call_index>=0),record TEXT NOT NULL,PRIMARY KEY(scope_id,turn_id,round,call_index),
    FOREIGN KEY(scope_id,turn_id) REFERENCES agent_turns(scope_id,turn_id));
CREATE TABLE companies(company_id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE scope_registry(scope_id TEXT PRIMARY KEY NOT NULL,
    company_id TEXT NOT NULL REFERENCES companies(company_id),origin TEXT NOT NULL CHECK(origin IN('migration','start','admission')));
CREATE TABLE audit_events(scope_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>0),event_id TEXT NOT NULL,
    kind TEXT NOT NULL,at_ms INTEGER NOT NULL CHECK(at_ms>=0),key_id TEXT NOT NULL,mac TEXT NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,sequence),UNIQUE(scope_id,event_id));
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'AUDIT_APPEND_ONLY'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'AUDIT_APPEND_ONLY'); END;
CREATE TABLE audit_counters(scope_id TEXT NOT NULL,counter TEXT NOT NULL,count INTEGER NOT NULL CHECK(count>=0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=0),PRIMARY KEY(scope_id,counter));
CREATE TABLE model_catalog_channels(channel_id TEXT NOT NULL PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=1),
    record TEXT NOT NULL);
CREATE TABLE model_catalog_models(channel_id TEXT NOT NULL REFERENCES model_catalog_channels(channel_id),
    model_id TEXT NOT NULL CHECK(model_id<>''),revision INTEGER NOT NULL CHECK(revision>=1),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN('active','legacy','deprecated','retired')),record TEXT NOT NULL,PRIMARY KEY(channel_id,model_id));
CREATE TABLE model_catalog_activations(scope_id TEXT NOT NULL,channel_id TEXT NOT NULL,model_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=1),state TEXT NOT NULL CHECK(state IN('active','inactive')),record TEXT NOT NULL,
    PRIMARY KEY(scope_id,channel_id,model_id));
CREATE TABLE model_catalog_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id));
CREATE TABLE execution_pool_holds(pool_id TEXT NOT NULL PRIMARY KEY REFERENCES execution_pools(pool_id),
    revision INTEGER NOT NULL CHECK(revision>=1),state TEXT NOT NULL CHECK(state IN('held','open')),record TEXT NOT NULL);
CREATE TABLE execution_pool_hold_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,command_id));
CREATE TABLE decision_cases(scope_id TEXT NOT NULL,decision_id TEXT NOT NULL,snapshot TEXT NOT NULL,
  PRIMARY KEY(scope_id,decision_id));
CREATE TABLE decision_command_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,decision_id TEXT NOT NULL,receipt TEXT NOT NULL,
  PRIMARY KEY(scope_id,command_id),FOREIGN KEY(scope_id,decision_id) REFERENCES decision_cases(scope_id,decision_id));
CREATE TABLE execution_pool_capacities(pool_id TEXT NOT NULL PRIMARY KEY REFERENCES execution_pools(pool_id),record TEXT NOT NULL);
CREATE TABLE execution_pool_capacity_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id));
CREATE TABLE provider_spend_management(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,digest TEXT NOT NULL,
      PRIMARY KEY(scope_id,command_id));
CREATE TRIGGER provider_spend_management_no_update BEFORE UPDATE ON provider_spend_management BEGIN SELECT RAISE(ABORT,'PROVIDER_SPEND_APPEND_ONLY'); END;
CREATE TRIGGER provider_spend_management_no_delete BEFORE DELETE ON provider_spend_management BEGIN SELECT RAISE(ABORT,'PROVIDER_SPEND_APPEND_ONLY'); END;
CREATE INDEX model_invocation_spend_unreconciled_holds ON model_invocation_spend_reservations(scope_id,invocation_id COLLATE BINARY)
    WHERE json_extract(record,'$.disposition.state')='held' AND json_extract(record,'$.reconciliation') IS NULL;
CREATE TABLE "approvals"(scope_id TEXT NOT NULL,approval_id TEXT NOT NULL,subject_kind TEXT NOT NULL CHECK(subject_kind IN('task','agent-tool-call','operation','config-change','run-create')),
    run_id TEXT,task_id TEXT,action_digest TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(scope_id,approval_id),CHECK((subject_kind='task')=(run_id IS NOT NULL AND task_id IS NOT NULL)));
CREATE UNIQUE INDEX approvals_current_action ON approvals(scope_id,run_id,task_id,action_digest) WHERE current=1 AND subject_kind='task';
CREATE UNIQUE INDEX approvals_current_tool_call ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='agent-tool-call';
CREATE UNIQUE INDEX approvals_current_operation ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='operation';
CREATE UNIQUE INDEX approvals_current_config_change ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='config-change';
CREATE UNIQUE INDEX approvals_current_run_create ON approvals(scope_id,json_extract(snapshot,'$.request.subject.commandId')) WHERE current=1 AND subject_kind='run-create';
CREATE TABLE run_proposals(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,proposal_id TEXT NOT NULL,run_id TEXT NOT NULL,
    revision INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id),UNIQUE(scope_id,proposal_id));
CREATE TABLE run_proposal_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,command_id,revision));
CREATE TRIGGER run_proposal_receipts_no_update BEFORE UPDATE ON run_proposal_receipts BEGIN SELECT RAISE(ABORT,'RUN_PROPOSAL_APPEND_ONLY'); END;
CREATE TRIGGER run_proposal_receipts_no_delete BEFORE DELETE ON run_proposal_receipts BEGIN SELECT RAISE(ABORT,'RUN_PROPOSAL_APPEND_ONLY'); END;
CREATE TABLE run_quota_waits(scope_id TEXT NOT NULL,run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,since_ms INTEGER NOT NULL,deadline_ms INTEGER NOT NULL,resets_at_ms INTEGER,
    released_at_ms INTEGER,channel_held INTEGER NOT NULL CHECK(channel_held IN(0,1)),PRIMARY KEY(scope_id,run_id,attempt_id));
CREATE INDEX run_quota_waits_active ON run_quota_waits(channel_id,deadline_ms DESC) WHERE released_at_ms IS NULL;
CREATE INDEX run_quota_waits_channel ON run_quota_waits(channel_id,deadline_ms DESC) WHERE released_at_ms IS NULL AND channel_held=1;
CREATE TRIGGER run_quota_waits_insert AFTER INSERT ON runs BEGIN INSERT INTO run_quota_waits
    SELECT NEW.scope_id,NEW.run_id,json_extract(q.value,'$.identity.attemptId'),json_extract(q.value,'$.channelId'),
      json_extract(q.value,'$.since'),json_extract(q.value,'$.deadline'),json_extract(q.value,'$.quota.resetsAtMs'),
      json_extract(q.value,'$.releasedAtMs'),CASE WHEN json_extract(q.value,'$.quota.source')='claude-rate-limit'
        AND json_extract(q.value,'$.quota.resetsAtMs')>json_extract(q.value,'$.since')
        AND COALESCE(json_extract(q.value,'$.resetBoundExceeded'),0)=0 THEN 1 ELSE 0 END
    FROM json_each(CASE WHEN json_valid(NEW.snapshot) THEN NEW.snapshot ELSE NULL END,'$.quotaWaits') q; END;
CREATE TRIGGER run_quota_waits_update AFTER UPDATE OF snapshot ON runs BEGIN
      DELETE FROM run_quota_waits WHERE scope_id=NEW.scope_id AND run_id=NEW.run_id;
      INSERT INTO run_quota_waits
    SELECT NEW.scope_id,NEW.run_id,json_extract(q.value,'$.identity.attemptId'),json_extract(q.value,'$.channelId'),
      json_extract(q.value,'$.since'),json_extract(q.value,'$.deadline'),json_extract(q.value,'$.quota.resetsAtMs'),
      json_extract(q.value,'$.releasedAtMs'),CASE WHEN json_extract(q.value,'$.quota.source')='claude-rate-limit'
        AND json_extract(q.value,'$.quota.resetsAtMs')>json_extract(q.value,'$.since')
        AND COALESCE(json_extract(q.value,'$.resetBoundExceeded'),0)=0 THEN 1 ELSE 0 END
    FROM json_each(CASE WHEN json_valid(NEW.snapshot) THEN NEW.snapshot ELSE NULL END,'$.quotaWaits') q; END;
CREATE TRIGGER run_quota_waits_delete AFTER DELETE ON runs BEGIN
      DELETE FROM run_quota_waits WHERE scope_id=OLD.scope_id AND run_id=OLD.run_id; END;
CREATE TABLE quota_release_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id));
CREATE TABLE model_invocation_plan_usage(scope_id TEXT NOT NULL,invocation_id TEXT NOT NULL,record TEXT NOT NULL,digest TEXT NOT NULL,
    PRIMARY KEY(scope_id,invocation_id));
CREATE TRIGGER model_invocation_plan_usage_no_update BEFORE UPDATE ON model_invocation_plan_usage BEGIN SELECT RAISE(ABORT,'PLAN_USAGE_APPEND_ONLY'); END;
CREATE TRIGGER model_invocation_plan_usage_no_delete BEFORE DELETE ON model_invocation_plan_usage BEGIN SELECT RAISE(ABORT,'PLAN_USAGE_APPEND_ONLY'); END;
CREATE TABLE audit_checkpoints(scope_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=1),record TEXT NOT NULL,
    PRIMARY KEY(scope_id,sequence));
CREATE TRIGGER audit_checkpoints_no_update BEFORE UPDATE ON audit_checkpoints BEGIN SELECT RAISE(ABORT,'AUDIT_CHECKPOINT_APPEND_ONLY'); END;
CREATE TRIGGER audit_checkpoints_no_delete BEFORE DELETE ON audit_checkpoints BEGIN SELECT RAISE(ABORT,'AUDIT_CHECKPOINT_APPEND_ONLY'); END;
CREATE TABLE target_queue(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,target_key TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>0),
    revision INTEGER NOT NULL CHECK(revision>=0),state TEXT NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,command_id),UNIQUE(target_key,ordinal));
CREATE INDEX target_queue_open ON target_queue(target_key,ordinal) WHERE state NOT IN('settled','cancelled','expired','parked');
CREATE TABLE target_queue_events(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,command_id,revision),FOREIGN KEY(scope_id,command_id) REFERENCES target_queue(scope_id,command_id));
CREATE TRIGGER target_queue_events_no_update BEFORE UPDATE ON target_queue_events BEGIN SELECT RAISE(ABORT,'QUEUE_APPEND_ONLY'); END;
CREATE TRIGGER target_queue_events_no_delete BEFORE DELETE ON target_queue_events BEGIN SELECT RAISE(ABORT,'QUEUE_APPEND_ONLY'); END;
CREATE TABLE "workspace_adoptions"(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,repository TEXT NOT NULL,target_ref TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence>0),kind TEXT NOT NULL CHECK(kind IN('adopt','rollback')),intent TEXT NOT NULL,
    settled INTEGER NOT NULL CHECK(settled IN(0,1,2)),PRIMARY KEY(scope_id,command_id));
CREATE UNIQUE INDEX workspace_adoptions_sequence ON workspace_adoptions(repository,target_ref,sequence) WHERE settled<2;
CREATE TABLE "acceptance_metrics"(scope_id TEXT NOT NULL,producer_command_id TEXT NOT NULL,run_id TEXT NOT NULL,task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,outcome_kind TEXT NOT NULL,record TEXT NOT NULL,superseded_by TEXT,PRIMARY KEY(scope_id,producer_command_id,outcome_kind));
CREATE INDEX acceptance_metrics_attempt ON acceptance_metrics(scope_id,run_id,task_id,attempt_id,outcome_kind);
CREATE UNIQUE INDEX acceptance_metrics_current ON acceptance_metrics(scope_id,run_id,task_id,attempt_id,outcome_kind) WHERE superseded_by IS NULL;
CREATE TABLE memory_entries(id INTEGER PRIMARY KEY,scope_id TEXT NOT NULL,entry_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
    state TEXT NOT NULL CHECK(state IN('candidate','verified','retired')),seq INTEGER NOT NULL,record TEXT NOT NULL,UNIQUE(scope_id,entry_id));
CREATE INDEX memory_entries_recent ON memory_entries(scope_id,seq DESC);
CREATE TRIGGER memory_entries_no_delete BEFORE DELETE ON memory_entries BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TABLE memory_entry_revisions(scope_id TEXT NOT NULL,entry_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),record TEXT NOT NULL,
    PRIMARY KEY(scope_id,entry_id,revision),FOREIGN KEY(scope_id,entry_id) REFERENCES memory_entries(scope_id,entry_id));
CREATE TRIGGER memory_entry_revisions_no_delete BEFORE DELETE ON memory_entry_revisions BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TABLE memory_command_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,entry_id TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,command_id));
CREATE TRIGGER memory_command_receipts_no_update BEFORE UPDATE ON memory_command_receipts BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TRIGGER memory_command_receipts_no_delete BEFORE DELETE ON memory_command_receipts BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE VIRTUAL TABLE memory_search USING fts5(text,tokenize='unicode61 remove_diacritics 2');
CREATE INDEX effect_intents_producer_attempt ON effect_intents(scope_id,json_extract(record,'$.intent.producer.identity.attemptId'));
CREATE TABLE agent_definitions(scope_id TEXT NOT NULL,agent_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),parent_id TEXT,seq INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,agent_id));
CREATE TABLE agent_definition_revisions(scope_id TEXT NOT NULL,agent_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),record TEXT NOT NULL,PRIMARY KEY(scope_id,agent_id,revision));
CREATE TABLE skill_definitions(scope_id TEXT NOT NULL,skill_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),seq INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,skill_id));
CREATE TABLE skill_definition_revisions(scope_id TEXT NOT NULL,skill_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),content_digest TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,skill_id,revision));
CREATE TABLE agent_catalog_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('agent','skill')),item_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id));
CREATE INDEX agent_definitions_recent ON agent_definitions(scope_id,seq DESC);
CREATE INDEX skill_definitions_recent ON skill_definitions(scope_id,seq DESC);
CREATE TRIGGER agent_definitions_no_delete BEFORE DELETE ON agent_definitions BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER skill_definitions_no_delete BEFORE DELETE ON skill_definitions BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER agent_definition_revisions_no_update BEFORE UPDATE ON agent_definition_revisions BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER agent_definition_revisions_no_delete BEFORE DELETE ON agent_definition_revisions BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER skill_definition_revisions_no_update BEFORE UPDATE ON skill_definition_revisions BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER skill_definition_revisions_no_delete BEFORE DELETE ON skill_definition_revisions BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER agent_catalog_receipts_no_update BEFORE UPDATE ON agent_catalog_receipts BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER agent_catalog_receipts_no_delete BEFORE DELETE ON agent_catalog_receipts BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TABLE memory_entry_support(scope_id TEXT NOT NULL,entry_id TEXT NOT NULL,support_id TEXT NOT NULL,seq INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,support_id),FOREIGN KEY(scope_id,entry_id) REFERENCES memory_entries(scope_id,entry_id));
CREATE INDEX memory_entry_support_entry ON memory_entry_support(scope_id,entry_id,seq);
CREATE TABLE memory_extraction_receipts(scope_id TEXT NOT NULL,run_id TEXT NOT NULL,task_id TEXT NOT NULL,attempt_id TEXT NOT NULL,at_ms INTEGER NOT NULL,
    proposed INTEGER NOT NULL CHECK(proposed>=0),record TEXT NOT NULL,PRIMARY KEY(scope_id,run_id,task_id,attempt_id));
CREATE INDEX memory_extraction_receipts_window ON memory_extraction_receipts(scope_id,at_ms);
CREATE TABLE memory_extraction_cursors(scope_id TEXT PRIMARY KEY NOT NULL,record TEXT NOT NULL);
CREATE TABLE memory_evaluations(scope_id TEXT NOT NULL,record_id TEXT NOT NULL,entry_id TEXT NOT NULL,seq INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,record_id));
CREATE INDEX memory_evaluations_entry ON memory_evaluations(scope_id,entry_id,seq);
CREATE TABLE memory_contests(scope_id TEXT NOT NULL,contest_id TEXT NOT NULL,entry_id TEXT NOT NULL,opened_at_ms INTEGER NOT NULL,record TEXT NOT NULL,resolution TEXT,
    PRIMARY KEY(scope_id,contest_id));
CREATE INDEX memory_contests_open ON memory_contests(scope_id,entry_id) WHERE resolution IS NULL;
CREATE INDEX memory_contests_window ON memory_contests(scope_id,opened_at_ms);
CREATE TRIGGER memory_contests_resolve_once BEFORE UPDATE ON memory_contests WHEN OLD.resolution IS NOT NULL OR NEW.resolution IS NULL OR NEW.record IS NOT OLD.record
      OR NEW.scope_id IS NOT OLD.scope_id OR NEW.contest_id IS NOT OLD.contest_id OR NEW.entry_id IS NOT OLD.entry_id OR NEW.opened_at_ms IS NOT OLD.opened_at_ms
      BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TABLE memory_purges(scope_id TEXT NOT NULL,purge_id TEXT NOT NULL,entry_id TEXT NOT NULL,content_digest TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,purge_id));
CREATE INDEX memory_purges_digest ON memory_purges(scope_id,content_digest);
CREATE TRIGGER memory_entry_support_no_update BEFORE UPDATE ON memory_entry_support BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TRIGGER memory_entry_support_no_delete BEFORE DELETE ON memory_entry_support BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TRIGGER memory_extraction_receipts_no_update BEFORE UPDATE ON memory_extraction_receipts BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TRIGGER memory_extraction_receipts_no_delete BEFORE DELETE ON memory_extraction_receipts BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TRIGGER memory_evaluations_no_update BEFORE UPDATE ON memory_evaluations BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TRIGGER memory_evaluations_no_delete BEFORE DELETE ON memory_evaluations BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TRIGGER memory_purges_no_update BEFORE UPDATE ON memory_purges BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TRIGGER memory_purges_no_delete BEFORE DELETE ON memory_purges BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TRIGGER memory_contests_no_delete BEFORE DELETE ON memory_contests BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TRIGGER memory_extraction_cursors_no_delete BEFORE DELETE ON memory_extraction_cursors BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TRIGGER memory_entry_revisions_tombstone_only BEFORE UPDATE ON memory_entry_revisions WHEN NOT (NEW.scope_id=OLD.scope_id AND NEW.entry_id=OLD.entry_id
      AND NEW.revision=OLD.revision AND json_valid(NEW.record) AND json_valid(OLD.record) AND json_extract(NEW.record,'$.value.content.purged') IS 1
      AND json_extract(OLD.record,'$.value.content.purged') IS NOT 1) BEGIN SELECT RAISE(ABORT,'MEMORY_APPEND_ONLY'); END;
CREATE TABLE recovery_cases(scope_id TEXT NOT NULL,case_id TEXT NOT NULL,run_id TEXT NOT NULL,task_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('open','gated','decided','applied','escalated')),revision INTEGER NOT NULL CHECK(revision>0),record TEXT NOT NULL,PRIMARY KEY(scope_id,case_id));
CREATE INDEX recovery_cases_task ON recovery_cases(scope_id,run_id,task_id,state);
CREATE TRIGGER recovery_cases_no_delete BEFORE DELETE ON recovery_cases BEGIN SELECT RAISE(ABORT,'RECOVERY_CASE_APPEND_ONLY'); END;
CREATE TRIGGER recovery_cases_forward_only BEFORE UPDATE ON recovery_cases WHEN NEW.scope_id IS NOT OLD.scope_id OR NEW.case_id IS NOT OLD.case_id
      OR NEW.run_id IS NOT OLD.run_id OR NEW.task_id IS NOT OLD.task_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.revision IS NOT OLD.revision+1
      OR OLD.state IN('applied','escalated') BEGIN SELECT RAISE(ABORT,'RECOVERY_CASE_APPEND_ONLY'); END;
CREATE TABLE agent_standings(scope_id TEXT NOT NULL,agent_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),work_class TEXT NOT NULL,
    standing TEXT NOT NULL CHECK(standing IN('candidate','active','redesign-required','retired')),standing_revision INTEGER NOT NULL CHECK(standing_revision>0),record TEXT NOT NULL,
    PRIMARY KEY(scope_id,agent_id,revision,work_class));
CREATE INDEX agent_standings_class ON agent_standings(scope_id,work_class,standing,agent_id);
CREATE TRIGGER agent_standings_forward_only BEFORE UPDATE ON agent_standings WHEN NEW.scope_id IS NOT OLD.scope_id OR NEW.agent_id IS NOT OLD.agent_id OR NEW.revision IS NOT OLD.revision
      OR NEW.work_class IS NOT OLD.work_class OR NEW.standing_revision IS NOT OLD.standing_revision+1 BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TABLE agent_standing_revisions(scope_id TEXT NOT NULL,agent_id TEXT NOT NULL,revision INTEGER NOT NULL,work_class TEXT NOT NULL,standing_revision INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,agent_id,revision,work_class,standing_revision));
CREATE TABLE agent_standing_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id));
CREATE TRIGGER agent_standings_no_delete BEFORE DELETE ON agent_standings BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER agent_standing_revisions_no_update BEFORE UPDATE ON agent_standing_revisions BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER agent_standing_revisions_no_delete BEFORE DELETE ON agent_standing_revisions BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER agent_standing_receipts_no_update BEFORE UPDATE ON agent_standing_receipts BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER agent_standing_receipts_no_delete BEFORE DELETE ON agent_standing_receipts BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TABLE skill_signer_keys(scope_id TEXT NOT NULL,key_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('active','revoked')),
    revision INTEGER NOT NULL CHECK(revision IN(1,2)),seq INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,key_id));
CREATE TRIGGER skill_signer_keys_revoke_only BEFORE UPDATE ON skill_signer_keys WHEN NEW.scope_id IS NOT OLD.scope_id OR NEW.key_id IS NOT OLD.key_id OR OLD.state IS NOT 'active'
      OR NEW.state IS NOT 'revoked' OR NEW.revision IS NOT 2 BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TABLE skill_signer_key_revisions(scope_id TEXT NOT NULL,key_id TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,key_id,revision));
CREATE TABLE skill_signer_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id));
CREATE TRIGGER skill_signer_keys_no_delete BEFORE DELETE ON skill_signer_keys BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER skill_signer_key_revisions_no_update BEFORE UPDATE ON skill_signer_key_revisions BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER skill_signer_key_revisions_no_delete BEFORE DELETE ON skill_signer_key_revisions BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER skill_signer_receipts_no_update BEFORE UPDATE ON skill_signer_receipts BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER skill_signer_receipts_no_delete BEFORE DELETE ON skill_signer_receipts BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TABLE catalog_evolution_positions(scope_id TEXT PRIMARY KEY NOT NULL,position INTEGER NOT NULL CHECK(position>0),record TEXT NOT NULL);
CREATE TRIGGER catalog_evolution_positions_forward BEFORE UPDATE ON catalog_evolution_positions WHEN NEW.scope_id IS NOT OLD.scope_id OR NEW.position<=OLD.position
      BEGIN SELECT RAISE(ABORT,'CATALOG_EVOLUTION_POSITION_CONFLICT'); END;
CREATE TRIGGER catalog_evolution_positions_no_delete BEFORE DELETE ON catalog_evolution_positions BEGIN SELECT RAISE(ABORT,'CATALOG_EVOLUTION_POSITION_CONFLICT'); END;
CREATE TABLE catalog_suggestions(scope_id TEXT NOT NULL,suggestion_id TEXT NOT NULL,kind TEXT NOT NULL,key_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('open','decided','dismissed','superseded')),state_revision INTEGER NOT NULL CHECK(state_revision>0),seq INTEGER NOT NULL,record TEXT NOT NULL,
    state_record TEXT NOT NULL,PRIMARY KEY(scope_id,suggestion_id));
CREATE INDEX catalog_suggestions_key ON catalog_suggestions(scope_id,key_digest,state);
CREATE INDEX catalog_suggestions_open ON catalog_suggestions(scope_id,state,seq);
CREATE TRIGGER catalog_suggestions_state_once BEFORE UPDATE ON catalog_suggestions WHEN NEW.scope_id IS NOT OLD.scope_id OR NEW.suggestion_id IS NOT OLD.suggestion_id
      OR NEW.kind IS NOT OLD.kind OR NEW.key_digest IS NOT OLD.key_digest OR NEW.seq IS NOT OLD.seq OR NEW.record IS NOT OLD.record OR OLD.state IS NOT 'open' OR NEW.state IS 'open'
      OR NEW.state_revision IS NOT OLD.state_revision+1 BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TABLE catalog_suggestion_states(scope_id TEXT NOT NULL,suggestion_id TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,suggestion_id,revision));
CREATE TABLE catalog_evolution_windows(scope_id TEXT NOT NULL,key_digest TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,key_digest));
CREATE TRIGGER catalog_evolution_windows_no_delete BEFORE DELETE ON catalog_evolution_windows BEGIN SELECT RAISE(ABORT,'CATALOG_EVOLUTION_POSITION_CONFLICT'); END;
CREATE TRIGGER catalog_suggestions_no_delete BEFORE DELETE ON catalog_suggestions BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER catalog_suggestion_states_no_update BEFORE UPDATE ON catalog_suggestion_states BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TRIGGER catalog_suggestion_states_no_delete BEFORE DELETE ON catalog_suggestion_states BEGIN SELECT RAISE(ABORT,'AGENT_CATALOG_APPEND_ONLY'); END;
CREATE TABLE hub_sources(scope_id TEXT NOT NULL,hub_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('active','removed')),
    revision INTEGER NOT NULL CHECK(revision>0),record TEXT NOT NULL,PRIMARY KEY(scope_id,hub_id));
CREATE TABLE hub_installs(scope_id TEXT NOT NULL,hub_id TEXT NOT NULL,package_id TEXT NOT NULL,version TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('installed','retired')),revision INTEGER NOT NULL CHECK(revision>0),seq INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,hub_id,package_id,version));
CREATE INDEX hub_installs_current ON hub_installs(scope_id,hub_id,package_id,seq DESC);
CREATE TABLE hub_revocation_snapshots(scope_id TEXT NOT NULL,hub_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>0),record TEXT NOT NULL,PRIMARY KEY(scope_id,hub_id,sequence));
CREATE TABLE hub_revocation_entries(scope_id TEXT NOT NULL,hub_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,hub_id,kind,id));
CREATE TABLE hub_client_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id));
CREATE TRIGGER hub_sources_no_delete BEFORE DELETE ON hub_sources BEGIN SELECT RAISE(ABORT,'HUB_APPEND_ONLY'); END;
CREATE TRIGGER hub_sources_forward BEFORE UPDATE ON hub_sources WHEN NEW.scope_id!=OLD.scope_id OR NEW.hub_id!=OLD.hub_id OR NEW.revision!=OLD.revision+1 BEGIN SELECT RAISE(ABORT,'HUB_APPEND_ONLY'); END;
CREATE TRIGGER hub_installs_no_delete BEFORE DELETE ON hub_installs BEGIN SELECT RAISE(ABORT,'HUB_APPEND_ONLY'); END;
CREATE TRIGGER hub_installs_forward BEFORE UPDATE ON hub_installs WHEN NEW.scope_id!=OLD.scope_id OR NEW.hub_id!=OLD.hub_id OR NEW.package_id!=OLD.package_id OR NEW.version!=OLD.version OR NEW.revision!=OLD.revision+1 BEGIN SELECT RAISE(ABORT,'HUB_APPEND_ONLY'); END;
CREATE TRIGGER hub_feed_no_delete BEFORE DELETE ON hub_revocation_snapshots BEGIN SELECT RAISE(ABORT,'HUB_APPEND_ONLY'); END;
CREATE TRIGGER hub_feed_forward BEFORE UPDATE ON hub_revocation_snapshots BEGIN SELECT RAISE(ABORT,'HUB_APPEND_ONLY'); END;
CREATE TRIGGER hub_revocation_no_delete BEFORE DELETE ON hub_revocation_entries BEGIN SELECT RAISE(ABORT,'HUB_APPEND_ONLY'); END;
CREATE TRIGGER hub_receipts_no_delete BEFORE DELETE ON hub_client_receipts BEGIN SELECT RAISE(ABORT,'HUB_APPEND_ONLY'); END;
CREATE TRIGGER hub_receipts_no_update BEFORE UPDATE ON hub_client_receipts BEGIN SELECT RAISE(ABORT,'HUB_APPEND_ONLY'); END;
CREATE TABLE provider_spend_period_history(scope_id TEXT NOT NULL,checkpoint_revision INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,checkpoint_revision));
CREATE TRIGGER provider_spend_period_history_no_update BEFORE UPDATE ON provider_spend_period_history BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER provider_spend_period_history_no_delete BEFORE DELETE ON provider_spend_period_history BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TABLE capacity_resources(resource_key TEXT PRIMARY KEY NOT NULL,binding_kind TEXT NOT NULL,binding_id TEXT NOT NULL,
    execution_slots INTEGER NOT NULL CHECK(execution_slots>0),in_flight_slots INTEGER NOT NULL CHECK(in_flight_slots>0),UNIQUE(binding_kind,binding_id));
CREATE TABLE run_capacity_resources(scope_id TEXT NOT NULL,run_id TEXT NOT NULL,task_id TEXT NOT NULL,resource_key TEXT NOT NULL,
      PRIMARY KEY(scope_id,run_id,task_id),FOREIGN KEY(scope_id,run_id) REFERENCES runs(scope_id,run_id),FOREIGN KEY(resource_key) REFERENCES capacity_resources(resource_key));
CREATE INDEX run_capacity_resources_key ON run_capacity_resources(resource_key);
CREATE TRIGGER capacity_resources_no_update BEFORE UPDATE ON capacity_resources BEGIN SELECT RAISE(ABORT,'immutable capacity resource'); END;
CREATE TRIGGER capacity_resources_no_delete BEFORE DELETE ON capacity_resources BEGIN SELECT RAISE(ABORT,'immutable capacity resource'); END;
CREATE TRIGGER run_capacity_resources_no_update BEFORE UPDATE ON run_capacity_resources BEGIN SELECT RAISE(ABORT,'immutable resource binding'); END;
CREATE TRIGGER run_capacity_resources_no_delete BEFORE DELETE ON run_capacity_resources BEGIN SELECT RAISE(ABORT,'immutable resource binding'); END;
PRAGMA user_version=74;

INSERT INTO "attempts"("scope_id","attempt_id","revision","snapshot") VALUES('scope_id','attempt_id',1,'{"schemaVersion":1,"scopeId":"scope_id","attemptId":"attempt_id","revision":1}');
INSERT INTO "attempt_receipts"("scope_id","command_id","command","snapshot") VALUES('scope_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id"}','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id"}');
INSERT INTO "dispatches"("scope_id","attempt_id","record") VALUES('scope_id','attempt_id','{"schemaVersion":1,"scopeId":"scope_id","attemptId":"attempt_id"}');
INSERT INTO "runs"("scope_id","run_id","revision","snapshot","policy") VALUES('scope_id','run_id',1,'{"schemaVersion":4,"identity":{"scopeId":"scope_id","runId":"run_id","layoutRevision":"layout"},"revision":1,"state":{"kind":"running"},"cancelRequested":false,"progress":[{"taskId":"task_id","phase":"executing"}],"quotaWaits":[]}','{"schemaVersion":2,"poolId":"pool_id","capacity":{"executionSlots":2,"inFlightSlots":2},"ordering":["task_id"]}');
INSERT INTO "run_receipts"("scope_id","command_id","command","snapshot") VALUES('scope_id','command_id','{"action":"apply-task-evaluation","evaluation":{"identity":{"scopeId":"scope_id","runId":"run_id","attemptId":"attempt_id"}}}','{"revision":1,"identity":{"runId":"run_id"},"progress":[],"bindings":[]}');
INSERT INTO "execution_pools"("pool_id","policy") VALUES('pool_id','{"schemaVersion":1,"poolId":"pool_id"}');
INSERT INTO "cancellation_deliveries"("scope_id","attempt_id","record") VALUES('scope_id','attempt_id','{"schemaVersion":1,"scopeId":"scope_id","attemptId":"attempt_id"}');
INSERT INTO "run_workspace_custody"("scope_id","run_id","record") VALUES('scope_id','run_id','{"schemaVersion":1,"scopeId":"scope_id","runId":"run_id"}');
INSERT INTO "service_shutdown_commands"("scope_id","service_id","command_id","record") VALUES('scope_id','service_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","serviceId":"service_id","commandId":"command_id"}');
INSERT INTO "service_shutdown_outcomes"("scope_id","service_id","command_id","record") VALUES('scope_id','service_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","serviceId":"service_id","commandId":"command_id"}');
INSERT INTO "installation_ownership"("singleton","record") VALUES(1,'{"schemaVersion":1,"singleton":1}');
INSERT INTO "model_activations"("scope_id","provider_id","provider_version","model_id","model_version","revision","record") VALUES('scope_id','provider_id',1,'model_id',1,1,'{"schemaVersion":1,"scopeId":"scope_id","providerId":"provider_id","providerVersion":1,"modelId":"model_id","modelVersion":1,"revision":1}');
INSERT INTO "model_activation_receipts"("scope_id","command_id","record") VALUES('scope_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id"}');
INSERT INTO "model_invocations"("scope_id","command_id","invocation_id","allocation_id","state","record") VALUES('scope_id','command_id','invocation_id','allocation_id','claimed','{"schemaVersion":4,"claim":{"scopeId":"scope_id","invocationId":"invocation_id"},"profile":{"adapter":{"id":"fixture-adapter","definition":{"configDir":"fixture-login","ownerUid":1}}},"outcome":null}');
INSERT INTO "model_invocation_controls"("scope_id","invocation_id","send_state","record") VALUES('scope_id','invocation_id','pending','{"schemaVersion":1,"scopeId":"scope_id","invocationId":"invocation_id","sendState":"pending"}');
INSERT INTO "model_invocation_cancellations"("scope_id","command_id","invocation_id","record") VALUES('scope_id','command_id','invocation_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id","invocationId":"invocation_id"}');
INSERT INTO "model_invocation_content_purges"("scope_id","command_id","invocation_id","record") VALUES('scope_id','command_id','invocation_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id","invocationId":"invocation_id"}');
INSERT INTO "model_invocation_contents"("scope_id","invocation_id","record","purge_command_id") VALUES('scope_id','invocation_id','{"schemaVersion":1,"content":"retained text"}',NULL);
INSERT INTO "provider_spend_accounts"("scope_id","revision","reservation_count","digest","record") VALUES('scope_id',1,1,'digest','{"schemaVersion":1,"scopeId":"scope_id","revision":1,"reservationCount":1,"digest":"digest"}');
INSERT INTO "model_invocation_spend_reservations"("scope_id","invocation_id","digest","record") VALUES('scope_id','invocation_id','digest','{"schemaVersion":1,"scopeId":"scope_id","invocationId":"invocation_id","digest":"digest"}');
INSERT INTO "provider_spend_audits"("sequence","scope_id","budget_id","budget_revision","command_id","record","digest") VALUES(1,'scope_id','budget_id',1,'command_id','{"schemaVersion":1,"sequence":1,"scopeId":"scope_id","budgetId":"budget_id","budgetRevision":1,"commandId":"command_id","digest":"digest"}','digest');
INSERT INTO "run_execution_intents"("scope_id","run_id","actor_id","issuer","subject","admitted_at","command_id") VALUES('scope_id','run_id','actor_id','issuer','subject',1,'command_id');
INSERT INTO "task_evaluation_observations"("scope_id","run_id","attempt_id","attempt_revision") VALUES('scope_id','run_id','attempt_id',1);
INSERT INTO "workspace_integrations"("scope_id","command_id","intent","manifest") VALUES('scope_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id"}',NULL);
INSERT INTO "approval_receipts"("scope_id","command_id","operation","fingerprint","snapshot") VALUES('scope_id','command_id','operation','fingerprint','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id","operation":"operation","fingerprint":"fingerprint"}');
INSERT INTO "approval_outbox"("scope_id","approval_id","revision","snapshot") VALUES('scope_id','approval_id',1,'{"schemaVersion":1,"scopeId":"scope_id","approvalId":"approval_id","revision":1}');
INSERT INTO "workspace_deliveries"("scope_id","command_id","intent","delivered") VALUES('scope_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id","delivered":0}',0);
INSERT INTO "effect_intents"("scope_id","command_id","target_kind","target_id","sequence","idempotency_key_hash","state","record") VALUES('scope_id','command_id','target_kind','target_id',1,'idempotency_key_hash','claimed','{"schemaVersion":1,"sequence":1,"state":"claimed","intent":{"command":{"commandId":"command_id","scopeId":"scope_id","compensates":"original","target":{"kind":"target_kind","id":"target_id"}},"producer":{"identity":{"attemptId":"attempt_id"}}}}');
INSERT INTO "worker_event_logs"("scope_id","attempt_id","record") VALUES('scope_id','attempt_id','{"schemaVersion":1,"scopeId":"scope_id","attemptId":"attempt_id"}');
INSERT INTO "model_invocation_allocations"("scope_id","allocation_id","max_calls","max_in_flight","lifetime_calls","in_flight","record") VALUES('scope_id','allocation_id',NULL,1,1,1,'{"schemaVersion":1,"scopeId":"scope_id","allocationId":"allocation_id","maxCalls":null,"maxInFlight":1,"lifetimeCalls":1,"inFlight":1}');
INSERT INTO "model_invocation_allocation_checkpoints"("scope_id","allocation_id","revision","digest") VALUES('scope_id','allocation_id',1,'digest');
INSERT INTO "agent_turns"("scope_id","turn_id","principal_key","request_digest","state","record") VALUES('scope_id','turn_id','principal_key','request_digest','running','{"schemaVersion":1,"scopeId":"scope_id","turnId":"turn_id","principalKey":"principal_key","requestDigest":"request_digest","state":"running"}');
INSERT INTO "agent_turn_tool_calls"("scope_id","turn_id","round","call_index","record") VALUES('scope_id','turn_id',1,1,'{"schemaVersion":1,"scopeId":"scope_id","turnId":"turn_id","round":1,"callIndex":1}');
INSERT INTO "companies"("company_id") VALUES('company_id');
INSERT INTO "scope_registry"("scope_id","company_id","origin") VALUES('scope_id','company_id','start');
INSERT INTO "audit_events"("scope_id","sequence","event_id","kind","at_ms","key_id","mac","record") VALUES('scope_id',1,'event_id','kind',1,'key_id','mac','{"schemaVersion":1,"scopeId":"scope_id","sequence":1,"eventId":"event_id","kind":"kind","atMs":1,"keyId":"key_id","mac":"mac"}');
INSERT INTO "audit_counters"("scope_id","counter","count","updated_at_ms") VALUES('scope_id','counter',1,1);
INSERT INTO "model_catalog_channels"("channel_id","revision","record") VALUES('channel_id',1,'{"schemaVersion":1,"channelId":"channel_id","revision":1}');
INSERT INTO "model_catalog_models"("channel_id","model_id","revision","lifecycle","record") VALUES('channel_id','model_id',1,'active','{"schemaVersion":1,"channelId":"channel_id","modelId":"model_id","revision":1,"lifecycle":"active"}');
INSERT INTO "model_catalog_activations"("scope_id","channel_id","model_id","revision","state","record") VALUES('scope_id','channel_id','model_id',1,'active','{"schemaVersion":1,"scopeId":"scope_id","channelId":"channel_id","modelId":"model_id","revision":1,"state":"active"}');
INSERT INTO "model_catalog_receipts"("scope_id","command_id","record") VALUES('scope_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id"}');
INSERT INTO "execution_pool_holds"("pool_id","revision","state","record") VALUES('pool_id',1,'held','{"schemaVersion":1,"poolId":"pool_id","revision":1,"state":"held"}');
INSERT INTO "execution_pool_hold_receipts"("scope_id","command_id","record") VALUES('scope_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id"}');
INSERT INTO "decision_cases"("scope_id","decision_id","snapshot") VALUES('scope_id','decision_id','{"schemaVersion":1,"scopeId":"scope_id","decisionId":"decision_id"}');
INSERT INTO "decision_command_receipts"("scope_id","command_id","decision_id","receipt") VALUES('scope_id','command_id','decision_id','receipt');
INSERT INTO "execution_pool_capacities"("pool_id","record") VALUES('pool_id','{"schemaVersion":1,"poolId":"pool_id"}');
INSERT INTO "execution_pool_capacity_receipts"("scope_id","command_id","record") VALUES('scope_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id"}');
INSERT INTO "provider_spend_management"("scope_id","command_id","record","digest") VALUES('scope_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id","digest":"digest"}','digest');
INSERT INTO "approvals"("scope_id","approval_id","subject_kind","run_id","task_id","action_digest","revision","snapshot","current") VALUES('scope_id','approval_id','task','run_id','task_id','action_digest',1,'{"schemaVersion":1,"scopeId":"scope_id","approvalId":"approval_id","subjectKind":"task","runId":null,"taskId":null,"actionDigest":"action_digest","revision":1,"current":1}',1);
INSERT INTO "run_proposals"("scope_id","command_id","proposal_id","run_id","revision","record") VALUES('scope_id','command_id','proposal_id','run_id',1,'{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id","proposalId":"proposal_id","runId":"run_id","revision":1}');
INSERT INTO "run_proposal_receipts"("scope_id","command_id","revision","record") VALUES('scope_id','command_id',1,'{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id","revision":1}');
INSERT INTO "run_quota_waits"("scope_id","run_id","attempt_id","channel_id","since_ms","deadline_ms","resets_at_ms","released_at_ms","channel_held") VALUES('scope_id','run_id','attempt_id','channel_id',1,1,NULL,NULL,0);
INSERT INTO "quota_release_receipts"("scope_id","command_id","record") VALUES('scope_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id"}');
INSERT INTO "model_invocation_plan_usage"("scope_id","invocation_id","record","digest") VALUES('scope_id','invocation_id','{"schemaVersion":1,"scopeId":"scope_id","invocationId":"invocation_id","digest":"digest"}','digest');
INSERT INTO "audit_checkpoints"("scope_id","sequence","record") VALUES('scope_id',1,'{"schemaVersion":1,"scopeId":"scope_id","sequence":1}');
INSERT INTO "target_queue"("scope_id","command_id","target_key","ordinal","revision","state","record") VALUES('scope_id','command_id','target_key',1,1,'state','{"schemaVersion":1,"epoch":2,"request":{"identity":{"runId":"run_id"},"reattempt":{"sourceCommandId":"source"},"submittedAt":2,"deliveryIntent":{"kind":"delivery"}},"effectCommandIds":["a","b","c","run_id"],"outcome":"conflict-needs-reattempt","reason":"PATCH_BASE_ADVANCED"}');
INSERT INTO "target_queue_events"("scope_id","command_id","revision","record") VALUES('scope_id','command_id',1,'{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id","revision":1}');
INSERT INTO "workspace_adoptions"("scope_id","command_id","repository","target_ref","sequence","kind","intent","settled") VALUES('scope_id','command_id','repository','target_ref',1,'adopt','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id","repository":"repository","targetRef":"target_ref","sequence":1,"kind":"adopt","settled":0}',0);
INSERT INTO "acceptance_metrics"("scope_id","producer_command_id","run_id","task_id","attempt_id","outcome_kind","record","superseded_by") VALUES('scope_id','producer_command_id','run_id','task_id','attempt_id','outcome_kind','{"schemaVersion":1,"scopeId":"scope_id","producerCommandId":"producer_command_id","runId":"run_id","taskId":"task_id","attemptId":"attempt_id","outcomeKind":"outcome_kind","supersededBy":null}',NULL);
INSERT INTO "memory_entries"("id","scope_id","entry_id","revision","state","seq","record") VALUES(1,'scope_id','entry_id',1,'candidate',1,'{"schemaVersion":1,"id":1,"scopeId":"scope_id","entryId":"entry_id","revision":1,"state":"candidate","seq":1}');
INSERT INTO "memory_entry_revisions"("scope_id","entry_id","revision","record") VALUES('scope_id','entry_id',1,'{"schemaVersion":1,"scopeId":"scope_id","entryId":"entry_id","revision":1}');
INSERT INTO "memory_command_receipts"("scope_id","command_id","entry_id","revision","record") VALUES('scope_id','command_id','entry_id',1,'{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id","entryId":"entry_id","revision":1}');
INSERT INTO "memory_search"("text") VALUES('migration retained text');
INSERT INTO "agent_definitions"("scope_id","agent_id","revision","parent_id","seq","record") VALUES('scope_id','agent_id',1,NULL,1,'{"schemaVersion":1,"scopeId":"scope_id","agentId":"agent_id","revision":1,"parentId":null,"seq":1}');
INSERT INTO "agent_definition_revisions"("scope_id","agent_id","revision","record") VALUES('scope_id','agent_id',1,'{"schemaVersion":1,"scopeId":"scope_id","agentId":"agent_id","revision":1}');
INSERT INTO "skill_definitions"("scope_id","skill_id","revision","seq","record") VALUES('scope_id','skill_id',1,1,'{"schemaVersion":1,"scopeId":"scope_id","skillId":"skill_id","revision":1,"seq":1}');
INSERT INTO "skill_definition_revisions"("scope_id","skill_id","revision","content_digest","record") VALUES('scope_id','skill_id',1,'content_digest','{"schemaVersion":1,"scopeId":"scope_id","skillId":"skill_id","revision":1,"contentDigest":"content_digest"}');
INSERT INTO "agent_catalog_receipts"("scope_id","command_id","kind","item_id","revision","record") VALUES('scope_id','command_id','agent','item_id',1,'{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id","kind":"agent","itemId":"item_id","revision":1}');
INSERT INTO "memory_entry_support"("scope_id","entry_id","support_id","seq","record") VALUES('scope_id','entry_id','support_id',1,'{"schemaVersion":1,"value":{"source":{"runId":"run_id","attemptId":"attempt_id"}}}');
INSERT INTO "memory_extraction_receipts"("scope_id","run_id","task_id","attempt_id","at_ms","proposed","record") VALUES('scope_id','run_id','task_id','attempt_id',1,1,'{"schemaVersion":1,"scopeId":"scope_id","runId":"run_id","taskId":"task_id","attemptId":"attempt_id","atMs":1,"proposed":1}');
INSERT INTO "memory_extraction_cursors"("scope_id","record") VALUES('scope_id','{"schemaVersion":1,"scopeId":"scope_id"}');
INSERT INTO "memory_evaluations"("scope_id","record_id","entry_id","seq","record") VALUES('scope_id','record_id','entry_id',1,'{"schemaVersion":1,"scopeId":"scope_id","recordId":"record_id","entryId":"entry_id","seq":1}');
INSERT INTO "memory_contests"("scope_id","contest_id","entry_id","opened_at_ms","record","resolution") VALUES('scope_id','contest_id','entry_id',1,'{"schemaVersion":1,"scopeId":"scope_id","contestId":"contest_id","entryId":"entry_id","openedAtMs":1,"resolution":null}',NULL);
INSERT INTO "memory_purges"("scope_id","purge_id","entry_id","content_digest","record") VALUES('scope_id','purge_id','entry_id','content_digest','{"schemaVersion":1,"scopeId":"scope_id","purgeId":"purge_id","entryId":"entry_id","contentDigest":"content_digest"}');
INSERT INTO "recovery_cases"("scope_id","case_id","run_id","task_id","attempt_id","state","revision","record") VALUES('scope_id','case_id','run_id','task_id','attempt_id','open',1,'{"schemaVersion":1,"scopeId":"scope_id","caseId":"case_id","runId":"run_id","taskId":"task_id","attemptId":"attempt_id","state":"open","revision":1}');
INSERT INTO "agent_standings"("scope_id","agent_id","revision","work_class","standing","standing_revision","record") VALUES('scope_id','agent_id',1,'work_class','candidate',1,'{"schemaVersion":1,"scopeId":"scope_id","agentId":"agent_id","revision":1,"workClass":"work_class","standing":"candidate","standingRevision":1}');
INSERT INTO "agent_standing_revisions"("scope_id","agent_id","revision","work_class","standing_revision","record") VALUES('scope_id','agent_id',1,'work_class',1,'{"schemaVersion":1,"scopeId":"scope_id","agentId":"agent_id","revision":1,"workClass":"work_class","standingRevision":1}');
INSERT INTO "agent_standing_receipts"("scope_id","command_id","record") VALUES('scope_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id"}');
INSERT INTO "skill_signer_keys"("scope_id","key_id","state","revision","seq","record") VALUES('scope_id','key_id','active',1,1,'{"schemaVersion":1,"scopeId":"scope_id","keyId":"key_id","state":"active","revision":1,"seq":1}');
INSERT INTO "skill_signer_key_revisions"("scope_id","key_id","revision","record") VALUES('scope_id','key_id',1,'{"schemaVersion":1,"scopeId":"scope_id","keyId":"key_id","revision":1}');
INSERT INTO "skill_signer_receipts"("scope_id","command_id","record") VALUES('scope_id','command_id','{"schemaVersion":1,"scopeId":"scope_id","commandId":"command_id"}');
INSERT INTO "catalog_evolution_positions"("scope_id","position","record") VALUES('scope_id',1,'{"schemaVersion":1,"scopeId":"scope_id","position":1}');
INSERT INTO "catalog_suggestions"("scope_id","suggestion_id","kind","key_digest","state","state_revision","seq","record","state_record") VALUES('scope_id','suggestion_id','kind','key_digest','open',1,1,'{"schemaVersion":1,"scopeId":"scope_id","suggestionId":"suggestion_id","kind":"kind","keyDigest":"key_digest","state":"open","stateRevision":1,"seq":1}','{"schemaVersion":1,"scopeId":"scope_id","suggestionId":"suggestion_id","kind":"kind","keyDigest":"key_digest","state":"open","stateRevision":1,"seq":1}');
INSERT INTO "catalog_suggestion_states"("scope_id","suggestion_id","revision","record") VALUES('scope_id','suggestion_id',1,'{"schemaVersion":1,"scopeId":"scope_id","suggestionId":"suggestion_id","revision":1}');
INSERT INTO "catalog_evolution_windows"("scope_id","key_digest","record") VALUES('scope_id','key_digest','{"schemaVersion":1,"scopeId":"scope_id","keyDigest":"key_digest"}');
INSERT INTO "hub_sources"("scope_id","hub_id","state","revision","record") VALUES('scope_id','hub_id','active',1,'{"schemaVersion":1,"scopeId":"scope_id","hubId":"hub_id","state":"active","revision":1}');
INSERT INTO "hub_installs"("scope_id","hub_id","package_id","version","state","revision","seq","record") VALUES('scope_id','hub_id','package_id','version','installed',1,1,'{"schemaVersion":1,"scopeId":"scope_id","hubId":"hub_id","packageId":"package_id","version":"version","state":"installed","revision":1,"seq":1}');
INSERT INTO "hub_revocation_snapshots"("scope_id","hub_id","sequence","record") VALUES('scope_id','hub_id',1,'{"schemaVersion":1,"scopeId":"scope_id","hubId":"hub_id","sequence":1}');
INSERT INTO "hub_revocation_entries"("scope_id","hub_id","kind","id","record") VALUES('scope_id','hub_id','kind','id','{"schemaVersion":1,"scopeId":"scope_id","hubId":"hub_id","kind":"kind","id":"id"}');
INSERT INTO "hub_client_receipts"("scope_id","command_id","record") VALUES('scope_id','command_id','{"schemaVersion":1,"value":{"result":{"kind":"revocations","hubId":"hub_id"}}}');
INSERT INTO "provider_spend_period_history"("scope_id","checkpoint_revision","record") VALUES('scope_id',1,'{"schemaVersion":1,"scopeId":"scope_id","checkpointRevision":1}');
INSERT INTO "capacity_resources"("resource_key","binding_kind","binding_id","execution_slots","in_flight_slots") VALUES('resource_key','binding_kind','binding_id',1,1);
INSERT INTO "run_capacity_resources"("scope_id","run_id","task_id","resource_key") VALUES('scope_id','run_id','task_id','resource_key');
-- Coexisting v74 variants that empty-schema upgrades miss: bounded/unbounded calls,
-- released holds, purged content, terminal/parked Runs and every invocation/effect state.
INSERT INTO model_invocation_allocations VALUES('scope_id','bounded',50,2,26,0,'{"schemaVersion":1,"scopeId":"scope_id","allocationId":"bounded","maxCalls":50,"maxInFlight":2,"lifetimeCalls":26,"inFlight":0}');
INSERT INTO model_invocations SELECT scope_id,'purged','purged',allocation_id,'responded',json_set(record,'$.claim.invocationId','purged','$.outcome',json('{"state":"responded"}')) FROM model_invocations WHERE invocation_id='invocation_id';
INSERT INTO model_invocation_content_purges VALUES('scope_id','purged','purged','{"schemaVersion":1,"command":{"scopeId":"scope_id","commandId":"purged","invocationId":"purged"}}');
INSERT INTO model_invocation_contents VALUES('scope_id','purged',NULL,'purged');
INSERT INTO model_invocations SELECT scope_id,'unknown','unknown',allocation_id,'unknown',json_set(record,'$.claim.invocationId','unknown','$.outcome',json('{"state":"unknown"}')) FROM model_invocations WHERE invocation_id='invocation_id';
INSERT INTO model_invocations SELECT scope_id,'rejected','rejected',allocation_id,'rejected',json_set(record,'$.claim.invocationId','rejected','$.outcome',json('{"state":"rejected"}')) FROM model_invocations WHERE invocation_id='invocation_id';
INSERT INTO model_invocations SELECT scope_id,'not-sent','not-sent',allocation_id,'not-sent',json_set(record,'$.claim.invocationId','not-sent','$.outcome',json('{"state":"not-sent"}')) FROM model_invocations WHERE invocation_id='invocation_id';
INSERT INTO runs SELECT scope_id,'terminal',revision,json_set(snapshot,'$.identity.runId','terminal','$.state.kind','terminal'),policy FROM runs WHERE run_id='run_id';
INSERT INTO runs SELECT scope_id,'parked',revision,json_set(snapshot,'$.identity.runId','parked','$.state.kind','parked','$.state.reason','quota-exhausted','$.state.deadline',100),policy FROM runs WHERE run_id='run_id';
INSERT INTO run_capacity_resources VALUES('scope_id','terminal','task_id','resource_key');
INSERT INTO run_capacity_resources VALUES('scope_id','parked','task_id','resource_key');
INSERT INTO effect_intents SELECT scope_id,'settled',target_kind,target_id,2,'settled','settled',json_set(record,'$.intent.command.commandId','settled','$.sequence',2,'$.state','settled') FROM effect_intents WHERE command_id='command_id';
INSERT INTO effect_intents SELECT scope_id,'unknown',target_kind,target_id,3,'unknown','unknown',json_set(record,'$.intent.command.commandId','unknown','$.sequence',3,'$.state','unknown') FROM effect_intents WHERE command_id='command_id';
INSERT INTO effect_intents SELECT scope_id,'refused',target_kind,target_id,4,'refused','refused',json_set(record,'$.intent.command.commandId','refused','$.sequence',4,'$.state','refused') FROM effect_intents WHERE command_id='command_id';
UPDATE run_quota_waits SET channel_held=1;
INSERT INTO run_quota_waits SELECT scope_id,run_id,'released',channel_id,since_ms,deadline_ms,resets_at_ms,2,1 FROM run_quota_waits WHERE attempt_id='attempt_id';
UPDATE approvals SET snapshot=json_set(snapshot,'$.status','pending','$.runId','run_id','$.taskId','task_id');
UPDATE target_queue SET state='settled';
UPDATE dispatches SET record='{"schemaVersion":1,"request":{"identity":{"scopeId":"scope_id","runId":"run_id","attemptId":"attempt_id"}},"terminal":null}';
COMMIT;
