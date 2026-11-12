import { TabsProps, Tabs, Button, Result, Alert, Flex, Tooltip } from '@/shared/antd-imports';
import { Modal, message } from 'antd';
import TaskDetailsForm from './shared/info-tab/task-details-form';
import { TaskCreateFormState, createEmptyTaskForm } from './task-create-form.types';
import TaskCreateAssociations from './task-create-associations';
import { createEmptyTaskRelations, hasUnfinishedRelations } from './task-create-associations.types';
import type { TaskCreateRelations } from './task-create-associations.types';
import { persistTaskCreateAssociations } from './task-create-associations.service';
import { hasBusinessFeatureAccess } from '@/utils/subscription-utils';
import { useSocket } from '@/socket/socketContext';
import { SocketEvents } from '@/shared/socket-events';
import { fetchTasksV3 } from '@/features/task-management/task-management.slice';
import { setRefreshTimestamp } from '@/features/project/project.slice';
import { fetchStatuses } from '@/features/taskAttributes/taskStatusSlice';
import { useTaskDrawerStatuses } from '@/hooks/useTaskDrawerStatuses';
import Drawer from 'antd/es/drawer';
import { InputRef } from 'antd/es/input';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { PlusOutlined, CloseOutlined, ArrowLeftOutlined } from '@/shared/antd-imports';

import { useAppSelector } from '@/hooks/useAppSelector';
import { useAppDispatch } from '@/hooks/useAppDispatch';
import {
  setSelectedTaskId,
  setShowTaskDrawer,
  setTaskFormViewModel,
  setTaskSubscribers,
  setTimeLogEditing,
  setTargetDrawerTab,
  fetchTask,
  setTaskAccessFrom,
} from '@/features/task-drawer/task-drawer.slice';

import './task-drawer.css';
import TaskDrawerHeader from './task-drawer-header/task-drawer-header';
import TaskDrawerTitleSection from './task-drawer-title-section/task-drawer-title-section';
import TaskDrawerActivityLog from './shared/activity-log/task-drawer-activity-log';
import TaskDrawerInfoTab from './shared/info-tab/task-drawer-info-tab';
import TaskDrawerTimeLog from './shared/time-log/task-drawer-time-log';
import TimeLogForm from './shared/time-log/time-log-form';
import { DEFAULT_TASK_NAME } from '@/shared/constants';
import useTaskDrawerUrlSync from '@/hooks/useTaskDrawerUrlSync';
import useTaskDrawerNavigation from '@/hooks/useTaskDrawerNavigation';
import InfoTabFooter from './shared/info-tab/info-tab-footer';
import { CrownOutlined } from '@ant-design/icons';
import { useAuthService } from '@/hooks/useAuth';
import { isFreeUser } from '@/utils/subscription-utils';
import { toggleUpgradeModal } from '@/features/admin-center/admin-center.slice';
import useTaskCreationPermission from '@/hooks/useTaskCreationPermission';
import { fetchPriorities } from '@/features/taskAttributes/taskPrioritySlice';
import { fetchLabels } from '@/features/taskAttributes/taskLabelSlice';
import { getTeamMembers } from '@/features/team-members/team-members.slice';
import { fetchPhasesByProjectId } from '@/features/projects/singleProject/phase/phases.slice';
import { getProject } from '@/features/project/project.slice';
import { isSoftwareProjectType } from '@/lib/project/software-project';
import CustomColumnModal from '@/pages/projects/projectView/taskList/task-list-table/custom-columns/custom-column-modal/custom-column-modal';

const TaskDrawer = () => {
  const { t, ready } = useTranslation('task-drawer/task-drawer');
  const { t: tCommon } = useTranslation('common');
  const [activeTab, setActiveTab] = useState<string>('info');
  const [refreshTimeLogTrigger, setRefreshTimeLogTrigger] = useState(0);
  const { canCreateTask } = useTaskCreationPermission();
  const { showTaskDrawer, timeLogEditing, taskAccessDenied, taskAccessFrom, targetDrawerTab } =
    useAppSelector(state => state.taskDrawerReducer);
  const { taskFormViewModel, selectedTaskId, drawerMode } = useAppSelector(
    state => state.taskDrawerReducer
  );
  const isCreateMode = drawerMode === 'create';
  const { socket, connected } = useSocket();
  const statuses = useTaskDrawerStatuses();
  const [createForm, setCreateForm] = useState<TaskCreateFormState>(createEmptyTaskForm);
  const [createStatus, setCreateStatus] = useState<'idle' | 'submitting' | 'unknown' | 'associating' | 'partial'>('idle');
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [createRelations, setCreateRelations] = useState<TaskCreateRelations>(createEmptyTaskRelations);
  const relationsRef = useRef<TaskCreateRelations>(createEmptyTaskRelations());
  const associatingRef = useRef(false);
  const createdTaskIdRef = useRef<string | null>(null);
  const updateCreateRelations = (next: TaskCreateRelations) => {
    if (createStatus !== 'idle') return;
    relationsRef.current = next;
    setCreateRelations(next);
  };
  const requestIdRef = useRef<string | null>(null);
  const submittedBodyRef = useRef<Record<string, unknown> | null>(null);
  const cleanupSocketRef = useRef<(() => void) | null>(null);
  const updateCreateForm = (patch: Partial<TaskCreateFormState>) => {
    if (createStatus === 'idle') setCreateForm(prev => ({ ...prev, ...patch }));
  };
  const { projectId, project } = useAppSelector(state => state.projectReducer);
  const priorities = useAppSelector(state => state.priorityReducer.priorities);
  const labels = useAppSelector(state => state.taskLabelsReducer.labels);
  const teamMembers = useAppSelector(state => state.teamMembersReducer.teamMembers);

  const authService = useAuthService();
  const currentSession = authService.getCurrentSession();
  const isFree = isFreeUser(currentSession);
  const taskNameInputRef = useRef<InputRef>(null);
  const isClosingManually = useRef(false);
  const hydratedProjectIdRef = useRef<string | null>(null);

  // Check if user is a guest in this project
  const isGuest = project?.is_guest === true;
  // TVR-13: parent of assigned-only subtask is view-only
  const isAssigneeScopeReadonly = !!taskFormViewModel?.task?.assignee_scope_readonly;
  const isTaskReadOnly = isGuest || isAssigneeScopeReadonly;
  const isSoftwareProject = isSoftwareProjectType(project?.project_type);

  const { clearTaskFromUrl } = useTaskDrawerUrlSync();
  useTaskDrawerNavigation();

  useEffect(() => {
    if (taskNameInputRef.current?.input?.value === DEFAULT_TASK_NAME) {
      taskNameInputRef.current.focus();
    }
  }, [showTaskDrawer]);

  const dispatch = useAppDispatch();

  useEffect(() => {
    if (showTaskDrawer && isCreateMode) {
      cleanupSocketRef.current?.();
      cleanupSocketRef.current = null;
      setCreateForm(createEmptyTaskForm());
      relationsRef.current = createEmptyTaskRelations();
      setCreateRelations(relationsRef.current);
      createdTaskIdRef.current = null;
      setCreatedTaskId(null);
      associatingRef.current = false;
      setCreateStatus('idle');
      requestIdRef.current = null;
      submittedBodyRef.current = null;
      setActiveTab('info');
    }
  }, [showTaskDrawer, isCreateMode]);

  // Socket callbacks and timers must never survive an unmount.
  useEffect(() => () => { cleanupSocketRef.current?.(); }, []);

  const persistRelationsAfterCreation = async (taskId: string) => {
    if (associatingRef.current) return;
    if (!socket || !projectId || !currentSession?.id || !currentSession.team_id) {
      setCreateStatus('partial');
      message.error('主任务已创建，但当前无法保存关联项；请保持抽屉并重试');
      return;
    }
    associatingRef.current = true;
    setCreateStatus('associating');
    try {
      const allSaved = await persistTaskCreateAssociations({
        socket,
        projectId,
        parentTaskId: taskId,
        reporterId: currentSession.id,
        teamId: currentSession.team_id,
        drafts: relationsRef.current,
        onProgress: progress => {
          relationsRef.current = progress;
          setCreateRelations({
            ...progress,
            subtasks: [...progress.subtasks],
            dependencies: [...progress.dependencies],
            attachments: [...progress.attachments],
          });
        },
      });
      dispatch(fetchTasksV3(projectId));
      dispatch(setRefreshTimestamp());
      if (allSaved) {
        setCreateStatus('idle');
        dispatch(setShowTaskDrawer(false));
        message.success('主任务及全部关联内容创建成功');
      } else {
        setCreateStatus('partial');
        message.warning('主任务已创建，部分关联内容结果未知或失败；请核查提示并重试');
      }
    } catch (error) {
      setCreateStatus('partial');
      message.error(error instanceof Error ? error.message : '关联保存失败，请重试');
    } finally {
      associatingRef.current = false;
    }
  };

  const handleConfirmCreate = () => {
    if (createStatus === 'submitting' || createStatus === 'associating') return;
    if (createdTaskIdRef.current) {
      void persistRelationsAfterCreation(createdTaskIdRef.current);
      return;
    }
    if (!projectId || !currentSession?.id || !canCreateTask) {
      message.error('项目或创建权限不可用');
      return;
    }
    if (!createForm.name.trim()) {
      message.warning('请填写任务标题');
      return;
    }
    if (createForm.start_date && createForm.end_date && createForm.end_date < createForm.start_date) {
      message.warning('截止日期不能早于开始日期');
      return;
    }
    if (!socket || !connected) {
      message.error('Socket 未连接，已保留填写内容');
      return;
    }

    // Never lose a typed child name if the user clicks Confirm without clicking Add.
    // Flush it ONCE before the main task is submitted; after a timeout, the
    // same stable subtask requestId remains available for a safe retry.
    const pendingSubtaskName = (relationsRef.current.subtaskInput || '').trim();
    if (pendingSubtaskName) {
      const next = {
        ...relationsRef.current,
        subtaskInput: '',
        subtasks: [...relationsRef.current.subtasks, {
          id: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          name: pendingSubtaskName,
          state: 'pending' as const,
        }],
      };
      relationsRef.current = next;
      setCreateRelations(next);
    }

    // If last attempt timed out, reuse EXACTLY the same payload and request ID.
    // A new ID here could create a duplicate task after a lost success response.
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    if (!submittedBodyRef.current) {
      submittedBodyRef.current = {
        request_id: requestIdRef.current,
        project_id: projectId,
        reporter_id: currentSession.id,
        team_id: currentSession.team_id,
        // Do NOT serialize File objects, children or dependency drafts into QUICK_TASK.
        name: createForm.name.trim(),
        status_id: createForm.status_id,
        priority_id: createForm.priority_id,
        phase_id: createForm.phase_id,
        assignee_ids: createForm.assignee_ids,
        label_ids: createForm.label_ids,
        start_date: createForm.start_date,
        end_date: createForm.end_date,
        description: createForm.description,
      };
    }
    const eventName = SocketEvents.QUICK_TASK.toString();
    const reqId = requestIdRef.current;
    cleanupSocketRef.current?.();
    setCreateStatus('submitting');
    let timer: ReturnType<typeof setTimeout>;
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(eventName, onResponse);
      socket.off('disconnect', onDisconnect);
      if (cleanupSocketRef.current === cleanup) cleanupSocketRef.current = null;
    };
    const markUnknown = (reason: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      setCreateStatus('unknown');
      message.warning(reason);
    };
    const onDisconnect = () => markUnknown('连接中断：结果未知，请重新连接后使用同一请求重试');
    const onResponse = (reply: {
      request_id?: string; success?: boolean;
      task?: { id?: string }; message?: string;
    }) => {
      if (reply?.request_id !== reqId || finished) return;
      finished = true;
      cleanup();
      if (reply.success && reply.task?.id) {
        createdTaskIdRef.current = reply.task.id;
        setCreatedTaskId(reply.task.id);
        requestIdRef.current = null;
        submittedBodyRef.current = null;
        if (!hasUnfinishedRelations(relationsRef.current)) {
          setCreateStatus('idle');
          dispatch(setShowTaskDrawer(false));
          dispatch(fetchTasksV3(projectId));
          dispatch(setRefreshTimestamp());
          message.success('创建成功');
        } else {
          void persistRelationsAfterCreation(reply.task.id);
        }
      } else {
        requestIdRef.current = null;
        submittedBodyRef.current = null;
        setCreateStatus('idle');
        message.error(reply.message || '创建失败，填写内容已保留');
      }
    };
    socket.on(eventName, onResponse);
    socket.on('disconnect', onDisconnect);
    timer = setTimeout(() => markUnknown('等待回执超时：结果未知，重试不会重复创建'), 12000);
    cleanupSocketRef.current = cleanup;
    try {
      socket.emit(eventName, JSON.stringify(submittedBodyRef.current));
    } catch {
      markUnknown('发送失败：请检查连接后使用原请求重试');
    }
  };

  // Deep-link: open a specific drawer tab (e.g. Time Log from recent logs)
  // Only apply targetDrawerTab after the correct task has been loaded (selectedTaskId is set)
  useEffect(() => {
    if (!showTaskDrawer || !targetDrawerTab || !selectedTaskId) return;

    if (isSoftwareProject) {
      dispatch(setTargetDrawerTab(null));
      return;
    }

    if (isFree && (targetDrawerTab === 'timeLog' || targetDrawerTab === 'activityLog')) {
      dispatch(toggleUpgradeModal());
      dispatch(setTargetDrawerTab(null));
      return;
    }

    setActiveTab(targetDrawerTab);
    dispatch(setTargetDrawerTab(null));
  }, [showTaskDrawer, targetDrawerTab, selectedTaskId, isFree, isSoftwareProject, dispatch]);

  useEffect(() => {
    if (!showTaskDrawer || taskAccessDenied) return;

    if (projectId && !statuses.length) dispatch(fetchStatuses(projectId));

    if (!priorities.length) {
      dispatch(fetchPriorities());
    }

    if (!labels.length) {
      dispatch(fetchLabels());
    }

    if (!teamMembers?.data?.length) {
      dispatch(
        getTeamMembers({ index: 0, size: 100, field: null, order: null, search: null, all: true })
      );
    }

    if (projectId) {
      if (hydratedProjectIdRef.current !== projectId) {
        hydratedProjectIdRef.current = projectId;
        dispatch(fetchPhasesByProjectId(projectId));
      }

      if (project?.id !== projectId) {
        dispatch(getProject(projectId));
      }

      if (
        drawerMode === 'edit' &&
        selectedTaskId &&
        (taskFormViewModel?.task?.id !== selectedTaskId || !taskFormViewModel?.task?.name)
      ) {
        dispatch(
          fetchTask({
            taskId: selectedTaskId,
            projectId,
            from: taskAccessFrom,
          })
        );
      }
    }
  }, [
    dispatch,
    labels.length,
    priorities.length,
    project,
    projectId,
    selectedTaskId,
    drawerMode,
    statuses.length,
    showTaskDrawer,
    taskAccessDenied,
    taskAccessFrom,
    taskFormViewModel?.task?.id,
    taskFormViewModel?.task?.name,
    teamMembers?.data?.length,
  ]);

  const handleBackToParent = () => {
    if (taskFormViewModel?.task?.parent_task_id && projectId) {
      const accessFrom = taskAccessFrom;
      dispatch(setSelectedTaskId(taskFormViewModel.task.parent_task_id));
      dispatch(setTaskAccessFrom(accessFrom));
      dispatch(
        fetchTask({
          taskId: taskFormViewModel.task.parent_task_id,
          projectId,
          from: accessFrom,
        })
      );
    }
  };

  const handleOnClose = (
    e?: React.MouseEvent<Element, MouseEvent> | React.KeyboardEvent<Element>
  ) => {
    if (isCreateMode && (createStatus === 'submitting' || createStatus === 'associating')) {
      message.info('正在提交，请等待结果或超时提示');
      return;
    }
    if (isCreateMode && createdTaskIdRef.current && createStatus === 'partial') {
      Modal.confirm({
        title: '主任务已创建，关联内容尚未全部确认',
        content: `任务 ID：${createdTaskIdRef.current}。关闭会丢失此处的失败关联草稿；可以稍后进入任务详情核查。建议先重试未完成项。`,
        okText: '关闭并自行核查', cancelText: '继续重试',
        onOk: () => dispatch(setShowTaskDrawer(false)),
      });
      return;
    }
    if (isCreateMode && createStatus === 'unknown') {
      Modal.confirm({
        title: '任务创建结果尚不明确',
        content: '可能已经保存到数据库。建议保持此窗口，连接恢复后重试同一请求进行结果核查。仍然关闭吗？',
        okText: '仍然关闭', cancelText: '保留并重试',
        onOk: () => {
          cleanupSocketRef.current?.();
          dispatch(setShowTaskDrawer(false));
          setActiveTab('info');
        },
      });
      return;
    }
    isClosingManually.current = true;
    setActiveTab('info');
    clearTaskFromUrl();

    const isClickOutsideDrawer =
      e?.target && (e.target as HTMLElement).classList.contains('ant-drawer-mask');

    if (isClickOutsideDrawer || taskAccessDenied || !taskFormViewModel?.task?.is_sub_task) {
      dispatch(setShowTaskDrawer(false));
    } else {
      handleBackToParent();
    }

    setTimeout(() => {
      isClosingManually.current = false;
    }, 100);
  };

  const handleAfterOpenChange = (open: boolean) => {
    if (!open && !showTaskDrawer) {
      dispatch(setSelectedTaskId(null));
      dispatch(setTaskFormViewModel({}));
      dispatch(setTaskSubscribers([]));
    }
  };

  const handleTabChange = (key: string) => {
    if (isFree && (key === 'timeLog' || key === 'activityLog')) {
      dispatch(toggleUpgradeModal());
      return;
    }
    setActiveTab(key);
  };

  const handleCancelTimeLog = () => {
    dispatch(setTimeLogEditing({ isEditing: false, logBeingEdited: null }));
  };

  const handleAddTimeLog = () => {
    if (isTaskReadOnly) return;
    dispatch(setTimeLogEditing({ isEditing: true, logBeingEdited: null }));
  };

  const refreshTimeLogs = () => setRefreshTimeLogTrigger(prev => prev + 1);

  const handleTimeLogSubmitSuccess = () => {
    handleCancelTimeLog();
    refreshTimeLogs();
  };

  const handlePremiumTabClick = () => dispatch(toggleUpgradeModal());

  const tabItems: TabsProps['items'] = [
    {
      key: 'info',
      label: t('taskInfoTab.title', { defaultValue: 'Info' }),
      children: <TaskDrawerInfoTab t={t} canCreateTask={canCreateTask} isGuest={isTaskReadOnly} />,
    },
    {
      key: 'timeLog',
      label: isFree ? (
        <Tooltip title={tCommon('upgrade-plan', { defaultValue: 'Upgrade Plan' })} placement="top">
          <div
            style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}
            onClick={handlePremiumTabClick}
          >
            <span>{t('taskTimeLogTab.title', { defaultValue: 'Time Log' })}</span>
            <CrownOutlined style={{ fontSize: '14px', color: '#faad14' }} />
          </div>
        </Tooltip>
      ) : (
        t('taskTimeLogTab.title', { defaultValue: 'Time Log' })
      ),
      children: (
        <TaskDrawerTimeLog t={t} refreshTrigger={refreshTimeLogTrigger} isGuest={isTaskReadOnly} />
      ),
      disabled: isFree,
    },
    {
      key: 'activityLog',
      label: isFree ? (
        <Tooltip title={tCommon('upgrade-plan', { defaultValue: 'Upgrade Plan' })} placement="top">
          <div
            style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}
            onClick={handlePremiumTabClick}
          >
            <span>{t('taskActivityLogTab.title', { defaultValue: 'Activity Log' })}</span>
            <CrownOutlined style={{ fontSize: '14px', color: '#faad14' }} />
          </div>
        </Tooltip>
      ) : (
        t('taskActivityLogTab.title', { defaultValue: 'Activity Log' })
      ),
      children: <TaskDrawerActivityLog />,
      disabled: isFree,
    },
  ];

  const renderFooter = () => {
    if (isCreateMode) {
      return (
        <Flex gap={12} justify="end">
          <Button onClick={() => handleOnClose()} disabled={createStatus === 'submitting' || createStatus === 'associating'}>
            {createdTaskId ? '关闭' : '取消'}
          </Button>
          <Button type="primary" loading={createStatus === 'submitting' || createStatus === 'associating'}
            disabled={!canCreateTask || (!createdTaskId && !createForm.name.trim()) || !connected}
            onClick={handleConfirmCreate}>
            {createdTaskId ? '重试未完成的关联' : createStatus === 'unknown' ? '重试 / 核查结果' : '确定创建'}
          </Button>
        </Flex>
      );
    }
    if (taskAccessDenied) return null;
    if (activeTab === 'info' || isSoftwareProject) return <InfoTabFooter />;
    if (activeTab === 'timeLog') {
      if (isTaskReadOnly) return null;
      if (timeLogEditing.isEditing) {
        return (
          <TimeLogForm
            onCancel={handleCancelTimeLog}
            onSubmitSuccess={handleTimeLogSubmitSuccess}
            initialValues={timeLogEditing.logBeingEdited || undefined}
            mode={timeLogEditing.logBeingEdited ? 'edit' : 'create'}
            allowReassign={!!timeLogEditing.logBeingEdited}
          />
        );
      }
      return (
        <Flex justify="center" style={{ width: '100%', padding: '16px 0 0' }}>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleAddTimeLog}
            style={{ width: '100%' }}
            disabled={isTaskReadOnly}
          >
            {t('taskTimeLogTab.addTimeLog', { defaultValue: 'Add Time Log' })}
          </Button>
        </Flex>
      );
    }
    return null;
  };

  const isSubTask =
    taskFormViewModel?.task?.is_sub_task || !!taskFormViewModel?.task?.parent_task_id;

  const drawerProps = {
    open: showTaskDrawer,
    onClose: handleOnClose,
    maskClosable: false,
    mask: false,
    afterOpenChange: handleAfterOpenChange,
    width: isSoftwareProject ? SOFTWARE_DRAWER_WIDTH : 720,
    destroyOnHidden: false,
    title: taskAccessDenied ? (
      t('taskAccessDenied.title', { defaultValue: 'No access' })
    ) : (
      isCreateMode ? '创建任务' :
      <TaskDrawerHeader t={t} canCreateTask={canCreateTask} isGuest={isTaskReadOnly} />
    ),
    closeIcon: !isCreateMode && !taskAccessDenied && isSubTask ? <ArrowLeftOutlined /> : <CloseOutlined />,
    footer: renderFooter(),
    styles: {
      body: {
        padding: 0,
        overflow: 'auto',
        height:
          activeTab === 'timeLog' && timeLogEditing.isEditing
            ? 'calc(100% - 220px)'
            : 'calc(100% - 180px)',
      },
      footer: {
        padding: '0 24px 16px',
        width: '100%',
        height: 'auto',
        boxSizing: 'border-box' as const,
        overflow: activeTab === 'timeLog' ? 'visible' : 'hidden',
      },
    },
  };

  return (
    <>
      <Drawer {...drawerProps}>
        {taskAccessDenied ? (
          <div style={{ padding: '48px 24px' }} role="status" aria-live="polite">
            <Result
              status="403"
              title={t('taskAccessDenied.title', { defaultValue: 'No access' })}
              subTitle={t('taskAccessDenied.subtitle', {
                defaultValue:
                  'You can only open tasks assigned to you in this project. Ask a project manager to assign you if you need access.',
              })}
              extra={
                <Button type="primary" onClick={() => handleOnClose()}>
                  {t('taskAccessDenied.close', { defaultValue: 'Close' })}
                </Button>
              }
            />
          </div>
        ) : (
          <>
            {isAssigneeScopeReadonly && (
              <div style={{ padding: '12px 24px 0' }} role="status">
                <Alert
                  type="info"
                  showIcon
                  message={t('assigneeScopeReadonly.title', {
                    defaultValue: 'View only',
                  })}
                  description={t('assigneeScopeReadonly.description', {
                    defaultValue:
                      'You are assigned to a subtask of this task. You can view the parent for context but cannot edit it.',
                  })}
                />
              </div>
            )}
            {/* Project name + task name — below the header, above the tabs */}
            <TaskDrawerTitleSection
              inputRef={taskNameInputRef}
              t={t}
              canCreateTask={canCreateTask && !isTaskReadOnly}
              createName={createForm.name}
              createDisabled={createStatus !== 'idle'}
              onCreateNameChange={name => updateCreateForm({ name })}
            />

            <div style={{ padding: '0 24px' }}>
              {isCreateMode ? (
                <>
                  <TaskDetailsForm
                    createForm={createForm}
                    onCreateFormChange={updateCreateForm}
                    createDisabled={createStatus !== 'idle'}
                    canCreateTask={canCreateTask}
                    isGuest={isTaskReadOnly}
                  />
                  <TaskCreateAssociations
                    projectId={projectId}
                    drafts={createRelations}
                    onChange={updateCreateRelations}
                    disabled={createStatus !== 'idle' || !canCreateTask || isTaskReadOnly}
                    parentTaskId={createdTaskId}
                    maxFileSizeMb={hasBusinessFeatureAccess(currentSession) ? 250 : 25}
                  />
                </>
              ) : isSoftwareProject ? (
                <TaskDrawerInfoTab t={t} canCreateTask={canCreateTask} isGuest={isTaskReadOnly} />
              ) : (
                <Tabs
                  type="card"
                  items={tabItems}
                  onChange={handleTabChange}
                  activeKey={activeTab}
                />
              )}
            </div>
          </>
        )}
      </Drawer>
      {createPortal(
        <CustomColumnModal projectId={projectId} />,
        document.body,
        'task-drawer-custom-column-modal'
      )}
    </>
  );
};

const SOFTWARE_DRAWER_WIDTH = 'min(520px, 100vw)';

export default TaskDrawer;
