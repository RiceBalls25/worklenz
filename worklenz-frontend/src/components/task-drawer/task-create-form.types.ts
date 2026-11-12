/** Unpersisted inputs; taskId only exists after QUICK_TASK commits. */
export interface TaskCreateFormState {
  name: string;
  status_id: string | null;
  priority_id: string | null;
  phase_id: string | null;
  assignee_ids: string[];
  label_ids: string[];
  start_date: string | null;
  end_date: string | null;
  description: string;
}

export const createEmptyTaskForm = (): TaskCreateFormState => ({
  name: '',
  status_id: null,
  priority_id: null,
  phase_id: null,
  assignee_ids: [],
  label_ids: [],
  start_date: null,
  end_date: null,
  description: '',
});
