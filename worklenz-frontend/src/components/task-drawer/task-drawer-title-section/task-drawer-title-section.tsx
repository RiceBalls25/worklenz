import React, { ChangeEvent, useEffect, useRef, useState } from 'react';
import { Flex, Input, InputRef, Skeleton, Typography } from '@/shared/antd-imports';
import { useAppSelector } from '@/hooks/useAppSelector';
import { useAppDispatch } from '@/hooks/useAppDispatch';
import { updateSelectedTaskName } from '@/features/task-drawer/task-drawer.slice';
import { updateTask } from '@/features/task-management/task-management.slice';
import { useSocket } from '@/socket/socketContext';
import { SocketEvents } from '@/shared/socket-events';
import { store } from '@/app/store';
import { Task } from '@/types/task-management.types';
import { TFunction } from 'i18next';
import TaskHierarchyBreadcrumb from '../task-hierarchy-breadcrumb/task-hierarchy-breadcrumb';
import { decodeHtmlEntities } from '@/utils/html-entities';
import { isSoftwareProjectType } from '@/lib/project/software-project';
import './task-drawer-title-section.css';

type Props = {
  inputRef: React.RefObject<InputRef | null>;
  t: TFunction;
  canCreateTask?: boolean;

  // 创建模式下，由父级提供未提交的标题
  createName?: string;
  onCreateNameChange?: (name: string) => void;
  createDisabled?: boolean;
};

const TaskDrawerTitleSection = ({
  inputRef,
  t,
  canCreateTask = true,
  createName,
  onCreateNameChange,
  createDisabled = false,
}: Props) => {
  const dispatch = useAppDispatch();
  const { socket, connected } = useSocket();
  const [isEditing, setIsEditing] = useState(false);

  const { taskFormViewModel, selectedTaskId, loadingTask, drawerMode } = useAppSelector(
    state => state.taskDrawerReducer
  );
  const isCreateMode = drawerMode === 'create';
  const projectName = useAppSelector(state => state.projectReducer.project?.name ?? null);
  const isSoftwareProject = useAppSelector(state =>
    isSoftwareProjectType(state.projectReducer.project?.project_type)
  );
  const taskManagementEntity = useAppSelector(state =>
    selectedTaskId ? state.taskManagement.entities[selectedTaskId] : null
  );

  // Try to get name from drawer state first, then fallback to task management entity
  const drawerTaskName = taskFormViewModel?.task?.name;
  const entityTaskName = taskManagementEntity?.title || taskManagementEntity?.name;
  const decodedTaskName = decodeHtmlEntities(drawerTaskName || entityTaskName);
  const [taskName, setTaskName] = useState<string>(decodedTaskName);
  // Snapshot the name at the moment editing starts so the blur handler can
  // compare against the true pre-edit value. We cannot use taskFormViewModel.task.name
  // for this because onTaskNameChange updates it live via Redux dispatch.
  const originalNameRef = React.useRef<string>(decodedTaskName);

  useEffect(() => {
    if (isEditing) return;

    if (isCreateMode) {
      if (createName !== undefined) {
        setTaskName(createName);
      }
    } else {
      setTaskName(decodedTaskName);
    }
  }, [isCreateMode, createName, decodedTaskName, isEditing]);

  // const onTaskNameChange = (e: ChangeEvent<HTMLInputElement>) => {
  //   const newName = e.currentTarget.value;
  //   setTaskName(newName);
  //   // Update Redux slices optimistically so the task list row and drawer stay in sync
  //   if (selectedTaskId) {
  //     dispatch(updateSelectedTaskName({ id: selectedTaskId, name: newName }));
  //     const currentTask = store.getState().taskManagement.entities[selectedTaskId];
  //     if (currentTask) {
  //       dispatch(
  //         updateTask({
  //           ...currentTask,
  //           title: newName,
  //           updatedAt: new Date().toISOString(),
  //           updated_at: new Date().toISOString(),
  //         } as Task)
  //       );
  //     }
  //   }
  // };
  const onTaskNameChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newName = e.currentTarget.value;
    setTaskName(newName);

    // create：只修改前端待提交表单
    if (isCreateMode) {
      onCreateNameChange?.(newName);
      return;
    }

    // edit：保留原有 Redux 乐观更新
    if (selectedTaskId) {
      dispatch(
        updateSelectedTaskName({
          id: selectedTaskId,
          name: newName,
        })
      );

      const currentTask = store.getState().taskManagement.entities[selectedTaskId];

      if (currentTask) {
        dispatch(
          updateTask({
            ...currentTask,
            title: newName,
            updatedAt: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } as Task)
        );
      }
    }
  };
  const handleStartEditing = () => {
    if (!canCreateTask) return;
    // Capture the name before the user starts typing so blur can detect a real change
    originalNameRef.current = isCreateMode ? (createName ?? taskName) : decodedTaskName || taskName;
    setIsEditing(true);
  };

  const emitNameChange = (name: string) => {
    if (isCreateMode) return;
    if (!selectedTaskId || !connected || !name.trim()) return;
    // Only emit if the name actually changed from what it was before editing started
    if (name.trim() === originalNameRef.current.trim()) return;
    socket?.emit(
      SocketEvents.TASK_NAME_CHANGE.toString(),
      JSON.stringify({
        task_id: selectedTaskId,
        name: name.trim(),
        parent_task: taskFormViewModel?.task?.parent_task_id,
      })
    );
  };

  const handleInputBlur = () => {
    setIsEditing(false);
    emitNameChange(taskName);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isCreateMode && e.key === 'Escape') {
      inputRef.current?.blur();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      setIsEditing(false);
      emitNameChange(taskName);
    } else if (e.key === 'Escape') {
      // Revert to original name on Escape
      setTaskName(originalNameRef.current);
      if (selectedTaskId) {
        dispatch(updateSelectedTaskName({ id: selectedTaskId, name: originalNameRef.current }));
        const currentTask = store.getState().taskManagement.entities[selectedTaskId];
        if (currentTask) {
          dispatch(
            updateTask({
              ...currentTask,
              title: originalNameRef.current,
              updatedAt: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            } as Task)
          );
        }
      }
      setIsEditing(false);
    }
  };

  // Show loading skeleton only if we're loading AND we don't have any task name (from drawer or entities)
  const isLoadingTaskName = !isCreateMode && loadingTask && !drawerTaskName && !entityTaskName;

  return (
    <div className="task-drawer-title-section">
      {/* Breadcrumb: project name / parent task */}
      <TaskHierarchyBreadcrumb t={t} projectName={isSoftwareProject ? null : projectName} />

      {/* Large task name */}
      <div className="task-drawer-title-name">
        {isLoadingTaskName ? (
          <Skeleton.Input active size="large" style={{ width: '100%', height: 40 }} />
        ) : isCreateMode || isEditing ? (
          <Input
            ref={inputRef}
            disabled={isCreateMode && createDisabled}
            value={taskName}
            onChange={onTaskNameChange}
            onBlur={handleInputBlur}
            onKeyDown={handleInputKeyDown}
            placeholder={t('taskHeader.taskNamePlaceholder')}
            className="task-name-input task-name-input--large"
            style={{
              width: '100%',
              border: 'none',
              padding: 0,
              boxShadow: 'none',
              fontSize: '22px',
              fontWeight: 700,
            }}
            showCount={true}
            maxLength={250}
            autoFocus
          />
        ) : (
          <Typography.Title
            level={4}
            onClick={handleStartEditing}
            className="task-name-display task-name-display--large"
            style={{
              margin: 0,
              cursor: canCreateTask ? 'text' : 'default',
              lineHeight: 1.3,
              fontWeight: 700,
              fontSize: '22px',
            }}
          >
            {taskName || t('taskHeader.taskNamePlaceholder')}
          </Typography.Title>
        )}
      </div>
    </div>
  );
};

export default React.memo(TaskDrawerTitleSection);
