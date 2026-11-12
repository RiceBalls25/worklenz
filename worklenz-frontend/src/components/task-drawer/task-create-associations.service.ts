/** Save associations ONLY AFTER the main QUICK_TASK has committed and returned its taskId.
 * Each subtask uses a stable request ID. HTTP operations reconcile before retrying.
 * Files retain their presign/confirm progress so a retry does not silently create a
 * new upload record. These operations are NOT one cross-service transaction.
 */
import type { Socket } from 'socket.io-client';
import { SocketEvents } from '@/shared/socket-events';
import { taskDependenciesApiService } from '@/api/tasks/task-dependencies.api.service';
import taskAttachmentsApiService from '@/api/tasks/task-attachments.api.service';
import { IDependencyType } from '@/types/tasks/task-dependency.types';
import type {
  TaskCreateRelations, DraftSubtask, DraftDependency, DraftAttachment,
} from './task-create-associations.types';

type SaveContext = {
  socket: Socket;
  projectId: string;
  parentTaskId: string;
  teamId: string;
  reporterId: string;
  drafts: TaskCreateRelations;
  onProgress: (drafts: TaskCreateRelations) => void;
};

const readableError = (error: unknown): string => {
  const e = error as {
    response?: { status?: number; data?: { message?: string; error?: string } };
    message?: string;
  } | null;
  const detail = e?.response?.data?.message || e?.response?.data?.error ||
    e?.message || String(error);
  return e?.response?.status ? `HTTP ${e.response.status}: ${detail}` : detail;
};

function sendSubtask(socket: Socket, body: Record<string, unknown>, requestId: string): Promise<string> {
  const event = SocketEvents.QUICK_TASK.toString();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, response);
      socket.off('disconnect', disconnect);
    };
    const finish = (err?: Error, taskId?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else if (taskId) resolve(taskId);
      else reject(new Error('子任务回执缺少 ID'));
    };
    const response = (reply: {
      request_id?: string;
      success?: boolean;
      task?: { id?: string };
      message?: string;
    }) => {
      // Other QUICK_TASK events must never resolve this subtask.
      if (reply?.request_id !== requestId) return;
      if (reply.success && reply.task?.id) finish(undefined, reply.task.id);
      else finish(new Error(reply.message || '创建子任务失败'));
    };
    const disconnect = () => finish(new Error('Socket 连接中断，子任务结果未知'));
    const timer = setTimeout(() => finish(new Error('子任务回执超时，结果未知')), 12000);
    socket.on(event, response);
    socket.on('disconnect', disconnect);
    try {
      socket.emit(event, JSON.stringify(body));
    } catch (error) {
      finish(new Error(readableError(error)));
    }
  });
}

async function saveSubtask(ctx: SaveContext, item: DraftSubtask): Promise<void> {
  if (item.createdTaskId) return;
  const body = {
    request_id: item.requestId,
    project_id: ctx.projectId,
    parent_task_id: ctx.parentTaskId,
    name: item.name.trim(),
    team_id: ctx.teamId,
    reporter_id: ctx.reporterId,
  };
  item.createdTaskId = await sendSubtask(ctx.socket, body, item.requestId);
}

async function saveDependency(ctx: SaveContext, item: DraftDependency): Promise<void> {
  // A lost HTTP response may follow a successful insert. Read before retry.
  const current = await taskDependenciesApiService.getTaskDependencies(ctx.parentTaskId);
  if (!current.done) throw new Error(current.message || '无法核查依赖关系');
  if (current.body?.some(dep => dep.related_task_id === item.relatedTaskId)) return;
  const result = await taskDependenciesApiService.createTaskDependency({
    task_id: ctx.parentTaskId,
    related_task_id: item.relatedTaskId,
    dependency_type: IDependencyType.BLOCKED_BY,
  });
  if (!result.done) throw new Error(result.message || '保存依赖关系失败');
}

async function saveAttachment(ctx: SaveContext, item: DraftAttachment): Promise<void> {
  if (!item.fileId || !item.uploadUrl) {
    let response;
    try {
      response = await taskAttachmentsApiService.presignTaskAttachment(
        ctx.parentTaskId, ctx.projectId, item.file.name, item.file.size,
        item.file.type || 'application/octet-stream'
      );
    } catch (error) {
      throw new Error(`附件预签名请求失败：${readableError(error)}`);
    }
    if (!response.done || !response.body) {
      throw new Error(`附件预签名接口返回失败：${response.message || '获取附件上传地址失败'}`);
    }
    item.fileId = response.body.file_id;
    item.uploadUrl = response.body.upload_url;
    item.uploadExpiresAt = Date.now() + response.body.expires_in * 1000;
    ctx.onProgress({ ...ctx.drafts });
  }
  if (!item.uploaded) {
    if (item.uploadExpiresAt && item.uploadExpiresAt <= Date.now()) {
      // Never blindly re-presign: that would leave a second DB upload record.
      throw new Error('上传链接已过期；为避免重复附件，请打开已创建任务后核查并处理');
    }
    try {
      await taskAttachmentsApiService.uploadDirect(item.uploadUrl, item.file);
    } catch (error) {
      throw new Error(`附件直传对象存储失败：${readableError(error)}`);
    }
    item.uploaded = true;
    ctx.onProgress({ ...ctx.drafts });
  }
  // If confirmation's HTTP reply is lost, retry with the SAME fileId.
  let confirmation;
  try {
    confirmation = await taskAttachmentsApiService.confirmTaskAttachment(
      item.fileId, ctx.parentTaskId
    );
  } catch (error) {
    throw new Error(`附件确认请求失败：${readableError(error)}`);
  }
  if (!confirmation.done) throw new Error(`附件确认接口返回失败：${confirmation.message || '确认附件失败'}`);
}

/** Idempotent best-effort coordinator. Successes are never run again. */
export async function persistTaskCreateAssociations(ctx: SaveContext): Promise<boolean> {
  const run = async <T extends DraftSubtask | DraftDependency | DraftAttachment>(
    items: T[], save: (ctx: SaveContext, item: T) => Promise<void>
  ) => {
    for (const item of items) {
      if (item.state === 'done') continue;
      item.state = 'saving';
      item.error = undefined;
      ctx.onProgress({ ...ctx.drafts });
      try {
        await save(ctx, item);
        item.state = 'done';
      } catch (error) {
        // An exception / lost reply does NOT prove a write was rolled back.
        item.state = 'unknown';
        item.error = readableError(error);
      }
      ctx.onProgress({ ...ctx.drafts });
    }
  };
  // Serial subtask inserts avoid races in the existing sort-order constraint.
  await run(ctx.drafts.subtasks, saveSubtask);
  await run(ctx.drafts.dependencies, saveDependency);
  await run(ctx.drafts.attachments, saveAttachment);
  return [...ctx.drafts.subtasks, ...ctx.drafts.dependencies, ...ctx.drafts.attachments]
    .every(item => item.state === 'done');
}
