-- Add advisory-time extension events before deploying the timing writer.
-- Preserve all original event types and the schema-version bound; never accept arbitrary types.
begin;
alter table public.ai_practice_events drop constraint ai_practice_events_event_type_check;
alter table public.ai_practice_events add constraint ai_practice_events_event_type_check check (
  schema_version = 1 and event_type in (
    'session.started','workspace.saved','stage.changed','coding.finished',
    'session.paused','session.resumed','session.timing-extended','session.submitted','test.requested','test.completed',
    'interviewer.question','learner.answer-committed','assistant.requested','assistant.responded',
    'assistant.edit-proposed','assistant.edit-decided','coaching.ready','coaching.corrected',
    'operation.failed','job.cancelled','hint.opened','drill.completed','interview.interaction'
  )
);
comment on constraint ai_practice_events_event_type_check on public.ai_practice_events is
  'Strict application v1 event vocabulary. Apply this additive extension before new writers; readers must support every persisted event type.';
commit;
