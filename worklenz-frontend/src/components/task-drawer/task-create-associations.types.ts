/** Ephemeral create-mode drafts. Nothing here is sent with the main QUICK_TASK payload. */
export type DraftSaveState = 'pending' | 'saving' | 'done' | 'unknown';

export interface DraftSubtask {
  id: string;
  name: string;
  requestId: string;
  state: DraftSaveState;
  createdTaskId?: string;
  error?: string;
}

export interface DraftDependency {
  id: string;
  relatedTaskId: string;
  label: string;
  state: DraftSaveState;
  error?: string;
}

export interface DraftAttachment {
  id: string;
  file: File;
  state: DraftSaveState;
  fileId?: string;
  uploadUrl?: string;
  uploadExpiresAt?: number;
  uploaded?: boolean;
  error?: string;
}

export interface TaskCreateRelations {
  /** Still-typed child name; submitting also queues it, even without clicking Add. */
  subtaskInput?: string;
  subtasks: DraftSubtask[];
  dependencies: DraftDependency[];
  attachments: DraftAttachment[];
}

export const createEmptyTaskRelations = (): TaskCreateRelations => ({
  subtasks: [],
  dependencies: [],
  attachments: [],
});

export const hasUnfinishedRelations = (drafts: TaskCreateRelations): boolean =>
  [...drafts.subtasks, ...drafts.dependencies, ...drafts.attachments]
    .some(item => item.state !== 'done');
