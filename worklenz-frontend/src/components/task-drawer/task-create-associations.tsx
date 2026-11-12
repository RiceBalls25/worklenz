import { useState } from 'react';
import { Alert, Button, Input, Select, Space, Typography, message } from 'antd';
import { useTranslation } from 'react-i18next';
import { tasksApiService } from '@/api/tasks/tasks.api.service';
import AttachmentsUpload from './shared/info-tab/attachments/attachments-upload';
import type { TaskCreateRelations } from './task-create-associations.types';

interface Props {
  projectId: string | null | undefined;
  drafts: TaskCreateRelations;
  onChange: (next: TaskCreateRelations) => void;
  disabled: boolean;
  maxFileSizeMb: number;
  parentTaskId: string | null;
}

const stateText = (state: string, error?: string) =>
  state === 'done' ? '已保存' : state === 'saving' ? '正在保存' :
  state === 'unknown' ? `待核查/重试：${error || '结果未知'}` : '待创建';

/** Extra fields inside the ONE existing TaskDrawer, not a second modal/drawer. */
export default function TaskCreateAssociations({
  projectId, drafts, onChange, disabled, maxFileSizeMb, parentTaskId,
}: Props) {
  const { t } = useTranslation('task-drawer/task-drawer');
  const [taskOptions, setTaskOptions] = useState<{ label: string; value: string }[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchText, setSearchText] = useState('');

  const addSubtask = () => {
    const name = (drafts.subtaskInput || '').trim();
    if (!name || disabled) return;
    onChange({ ...drafts, subtaskInput: '', subtasks: [...drafts.subtasks, {
      id: crypto.randomUUID(), requestId: crypto.randomUUID(), name, state: 'pending',
    }] });
  };

  const search = async (query: string) => {
    setSearchText(query);
    if (!projectId || !query.trim()) { setTaskOptions([]); return; }
    setSearchLoading(true);
    try {
      // Existing searchTask accepts undefined taskId while creating a draft.
      const result = await tasksApiService.searchTask(undefined, projectId, query.trim());
      if (result.done) setTaskOptions(result.body || []);
      else message.error(result.message || '任务搜索失败');
    } catch {
      message.error('无法搜索可依赖的任务');
    } finally {
      setSearchLoading(false);
    }
  };

  const addDependency = (id: string) => {
    if (disabled || drafts.dependencies.some(dep => dep.relatedTaskId === id)) return;
    const label = taskOptions.find(item => item.value === id)?.label || id;
    onChange({ ...drafts, dependencies: [...drafts.dependencies, {
      id: crypto.randomUUID(), relatedTaskId: id, label, state: 'pending',
    }] });
    setTaskOptions([]);
    setSearchText('');
  };

  const addFiles = (files: File[]) => {
    if (disabled) return;
    const maxBytes = maxFileSizeMb * 1024 * 1024;
    const valid = files.filter(file => file.size <= maxBytes);
    const invalid = files.filter(file => file.size > maxBytes);
    if (invalid.length) message.error(`文件超过 ${maxFileSizeMb} MB 限制：${invalid.map(f => f.name).join('、')}`);
    if (valid.length) onChange({ ...drafts, attachments: [
      ...drafts.attachments,
      ...valid.map(file => ({ id: crypto.randomUUID(), file, state: 'pending' as const })),
    ] });
  };

  return (
    <section style={{ margin: '12px 0 28px', display: 'grid', gap: 18 }}>
      <Alert type="info" showIcon message={parentTaskId
        ? `主任务已创建 (${parentTaskId.slice(0, 8)}...)。仅重试尚未确认的关联项。`
        : '以下内容暂存于浏览器；点击「确定创建」后才会创建主任务并关联保存。'} />

      <div>
        <Typography.Text strong>子任务（创建前填写）</Typography.Text>
        <Space.Compact style={{ width: '100%', marginTop: 8 }}>
          <Input value={drafts.subtaskInput || ''} disabled={disabled} placeholder="子任务名称"
            onChange={e => onChange({ ...drafts, subtaskInput: e.target.value })} onPressEnter={addSubtask} />
          <Button disabled={disabled || !(drafts.subtaskInput || '').trim()} onClick={addSubtask}>添加</Button>
        </Space.Compact>
        {drafts.subtasks.map(item => (
          <div key={item.id} style={{ padding: '6px 0', display: 'flex', gap: 8 }}>
            <span style={{ flex: 1 }}>{item.name} · {stateText(item.state, item.error)}</span>
            {item.state === 'pending' && <Button size="small" disabled={disabled} onClick={() =>
              onChange({ ...drafts, subtasks: drafts.subtasks.filter(x => x.id !== item.id) })}>移除</Button>}
          </div>
        ))}
      </div>

      <div>
        <Typography.Text strong>依赖关系（Blocked by）</Typography.Text>
        <Select showSearch filterOption={false} allowClear value={undefined}
          searchValue={searchText} onSearch={search} onSelect={addDependency}
          options={taskOptions} loading={searchLoading} disabled={disabled}
          placeholder="搜索已有任务，设为当前任务的前置依赖"
          style={{ width: '100%', marginTop: 8 }} />
        {drafts.dependencies.map(item => (
          <div key={item.id} style={{ padding: '6px 0', display: 'flex', gap: 8 }}>
            <span style={{ flex: 1 }}>{item.label} · {stateText(item.state, item.error)}</span>
            {item.state === 'pending' && <Button size="small" disabled={disabled} onClick={() =>
              onChange({ ...drafts, dependencies: drafts.dependencies.filter(x => x.id !== item.id) })}>移除</Button>}
          </div>
        ))}
      </div>

      <div>
        <Typography.Text strong>附件（确认创建后上传）</Typography.Text>
        <div style={{ marginTop: 8 }}>
          {!disabled && <AttachmentsUpload t={t} loadingTask={false} uploading={false}
            onFilesSelected={addFiles} maxFileSizeMb={maxFileSizeMb} showUpgradeLink={false} />}
        </div>
        {drafts.attachments.map(item => (
          <div key={item.id} style={{ padding: '6px 0', display: 'flex', gap: 8 }}>
            <span style={{ flex: 1, overflowWrap: 'anywhere' }}>
              {item.file.name} ({(item.file.size / 1024).toFixed(1)} KB) · {stateText(item.state, item.error)}
            </span>
            {item.state === 'pending' && <Button size="small" disabled={disabled} onClick={() =>
              onChange({ ...drafts, attachments: drafts.attachments.filter(x => x.id !== item.id) })}>移除</Button>}
          </div>
        ))}
      </div>
    </section>
  );
}
