import db from "../config/db";
import { createHash } from "crypto";

interface ICreatedQuickTask {
  id: string;
  project_id: string;
  issue_type?: string;
  status?: string | null;
  chart_start?: string;
  [key: string]: unknown;
}

interface IQuickTaskCreationRow {
  task: ICreatedQuickTask | null;
}

const QUICK_TASK_ISSUE_TYPES = ["task", "story", "bug"];

/**
 * A repeated (user, requestId) creates at most one task, even when two sockets
 * race. A unique insert + PostgreSQL row lock serializes duplicate attempts.
 * Request records and the task are committed in the SAME transaction.
 */
export async function createQuickTaskRecord(
  body: string,
  projectId: string,
  issueType?: string,
  options?: { requestId?: string; userId?: string }
): Promise<{ rows: IQuickTaskCreationRow[]; replayed: boolean }> {
  const input = JSON.parse(body);
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({ ...input, request_id: undefined, issueType }))
    .digest("hex");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (options?.requestId && options.userId) {
      await client.query(
        `INSERT INTO quick_task_requests (user_id, request_id, project_id, payload_hash)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
         ON CONFLICT (user_id, request_id) DO NOTHING`,
        [options.userId, options.requestId, projectId, payloadHash]
      );
      const claimed = await client.query<{
        project_id: string;
        payload_hash: string;
        task_response: ICreatedQuickTask | null;
      }>(
        `SELECT project_id, payload_hash, task_response
           FROM quick_task_requests
          WHERE user_id = $1::uuid AND request_id = $2::uuid FOR UPDATE`,
        [options.userId, options.requestId]
      );
      const record = claimed.rows[0];
      if (!record || record.project_id !== projectId || record.payload_hash !== payloadHash) {
        throw new Error("REQUEST_ID_REUSED_WITH_DIFFERENT_PAYLOAD");
      }
      if (record.task_response) {
        await client.query("COMMIT");
        return { rows: [{ task: record.task_response }], replayed: true };
      }
    }

    const result = await client.query<IQuickTaskCreationRow>(
      "SELECT create_quick_task($1) AS task;",
      [body]
    );
    const [row] = result.rows;
    if (!row?.task?.id) throw new Error("QUICK_TASK_CREATE_FAILED");

    // Existing SQL function already creates the base task and its default phase,
    // status, priority and optional creator assignment.
    if (issueType && QUICK_TASK_ISSUE_TYPES.includes(issueType) && issueType !== "task") {
      const update = await client.query(
        "UPDATE tasks SET issue_type = $2 WHERE id = $1 AND project_id = $3;",
        [row.task.id, issueType, projectId]
      );
      if (update.rowCount !== 1) throw new Error("Created task not found in its project");
    }

    // Optional associations use the SAME connection and transaction as task insert.
    const ids = (value: unknown): string[] => {
      if (value == null) return [];
      if (!Array.isArray(value) || value.some(id =>
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      )) throw new Error("INVALID_ASSOCIATION_ID");
      return [...new Set(value)];
    };
    for (const memberId of ids(input.assignee_ids)) {
      await client.query(
        "SELECT create_task_assignee($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
        [memberId, projectId, row.task.id, input.reporter_id]
      );
    }
    for (const labelId of ids(input.label_ids)) {
      const label = await client.query(
        `INSERT INTO task_labels(task_id, label_id)
         SELECT $1::uuid, id FROM team_labels
         WHERE id = $2::uuid AND team_id = (SELECT team_id FROM projects WHERE id = $3::uuid)
         ON CONFLICT DO NOTHING RETURNING label_id`,
        [row.task.id, labelId, projectId]
      );
      if (label.rowCount !== 1) {
        const exists = await client.query(
          "SELECT 1 FROM task_labels WHERE task_id=$1::uuid AND label_id=$2::uuid",
          [row.task.id, labelId]
        );
        if (!exists.rowCount) throw new Error("INVALID_TASK_LABEL");
      }
    }

    // Re-read the complete task after writing its associations.
    const refreshed = await client.query<IQuickTaskCreationRow>(
      "SELECT get_single_task($1::uuid) AS task;",
      [row.task.id]
    );
    const finalTask = refreshed.rows[0]?.task;
    if (!finalTask) throw new Error("QUICK_TASK_READBACK_FAILED");
    if (options?.requestId && options.userId) {
      await client.query(
        `UPDATE quick_task_requests SET task_response = $3::jsonb
         WHERE user_id = $1::uuid AND request_id = $2::uuid`,
        [options.userId, options.requestId, JSON.stringify(finalTask)]
      );
    }
    await client.query("COMMIT");
    return { rows: [{ task: finalTask }], replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
