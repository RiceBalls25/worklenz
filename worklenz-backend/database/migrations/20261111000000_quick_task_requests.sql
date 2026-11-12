-- Apply once BEFORE deploying the new QUICK_TASK handler.
CREATE TABLE IF NOT EXISTS quick_task_requests (
  user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  project_id uuid NOT NULL,
  payload_hash text NOT NULL,
  task_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX IF NOT EXISTS quick_task_requests_created_at_idx
  ON quick_task_requests (created_at);
