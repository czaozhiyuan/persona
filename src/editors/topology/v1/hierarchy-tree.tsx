import { portDirectionLabels } from '../../../model/v1/types';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import type { InstancePath, Project } from '../../../model/v1/types';
import { moveWiringSummary, planInstanceMove } from '../../../state/v1/reparent-instance';
import { createPathNames, structureLocations } from '../../../workbench/v1/structure-scope';
import type { ApprovedMove } from './reparent-drop';
import { definitionIcon, DeviceIcon } from './device-icon';
import { hierarchyChildren, hierarchyKey } from './hierarchy-view';

const dragType = 'application/x-persona-hierarchy-instance';

type Hover = { key: string; label: string; locations: readonly string[]; plan?: ApprovedMove; error?: string };
type TreeDrag = { base: Project; source: InstancePath; hover?: Hover };

type Props = {
  project: Project;
  focusMoved?: InstancePath;
  move: (base: Project, plan: ApprovedMove) => string | undefined;
  instances: readonly ResolvedInstance[];
  modulePath: InstancePath;
  selected: readonly InstancePath[];
  expanded: ReadonlySet<string>;
  toggle: (path: InstancePath) => void;
  select: (path: InstancePath, extend: boolean) => void;
  enter: (path: InstancePath) => void;
  navigatePort: (path: InstancePath, portId: string) => void;
};

export function HierarchyTree({ project, focusMoved, move, instances, modulePath, selected, expanded, toggle, select, enter, navigatePort }: Props) {
  const { showName, showPath } = createPathNames(instances);
  const tree = useRef<HTMLDivElement>(null);
  const drag = useRef<TreeDrag | undefined>(undefined);
  const [hover, setHover] = useState<Hover>();
  const [notice, setNotice] = useState<string>();
  const renderedHover = useRef<Hover | undefined>(undefined);
  useLayoutEffect(() => { renderedHover.current = hover; }, [hover]);
  useEffect(() => {
    if (!focusMoved) return;
    const row = tree.current?.querySelector(`[data-hierarchy-key="${CSS.escape(hierarchyKey(focusMoved))}"]`);
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focusMoved]);

  function endDrag() {
    drag.current = undefined;
    setHover(undefined);
  }

  function clearHover() {
    if (drag.current) drag.current.hover = undefined;
    setHover(undefined);
  }

  function dragOver(event: DragEvent<HTMLLIElement>, item: ResolvedInstance) {
    const session = drag.current;
    if (!session || !event.dataTransfer.types.includes(dragType)) return;
    event.preventDefault();
    const key = hierarchyKey(item.instancePath);
    if (session.hover?.key !== key) {
      const plan = item.definition.kind === 'module' ? planInstanceMove(session.base, session.source, item.instancePath) : undefined;
      const name = showName(item.instancePath);
      session.hover = {
        key, label: `移入：${name}`,
        plan: plan?.ok ? plan : undefined,
        error: plan ? (plan.ok ? undefined : plan.message) : '请选择一个模块条目。',
        locations: plan?.ok && plan.affected.length > 1 ? structureLocations(instances, plan.affected.map(item => item.from)) : [],
      };
      setHover(session.hover);
    }
    event.dataTransfer.dropEffect = session.hover.plan ? 'move' : 'none';
  }

  function drop(event: DragEvent<HTMLLIElement>, path: InstancePath) {
    const session = drag.current;
    if (!session || !event.dataTransfer.types.includes(dragType)) return;
    event.preventDefault();
    const rendered = renderedHover.current;
    const preview = rendered?.key === hierarchyKey(path) && rendered === session.hover ? rendered : undefined;
    setNotice(preview?.plan ? move(session.base, preview.plan) : preview?.error ?? '请等目标显示移动预览后再松手。');
    endDrag();
  }
  const children = hierarchyChildren(instances);
  const root = instances[0];
  const pending = root ? [root] : [];
  const rows: ResolvedInstance[] = [];
  const active = hierarchyKey(modulePath);
  const selectedKeys = new Set(selected.map(hierarchyKey));
  while (pending.length) {
    const occurrence = pending.pop()!;
    rows.push(occurrence);
    if (expanded.has(hierarchyKey(occurrence.instancePath))) {
      for (const child of [...(children.get(hierarchyKey(occurrence.instancePath)) ?? [])].reverse()) pending.push(child);
    }
  }
  return <div ref={tree} className="v1-hierarchy-tree" aria-label="工程结构"
    onDragLeave={event => {
      if (drag.current && !(event.relatedTarget instanceof Element && event.currentTarget.contains(event.relatedTarget))) clearHover();
    }}
    onDragOver={event => {
      if (drag.current && event.target instanceof Element && !event.target.closest('[data-hierarchy-key]')) clearHover();
    }}>
    {(hover || notice) && <div className="v1-tree-drop-overlay">
      <div className="v1-tree-drop-notice" role={notice ? 'alert' : 'status'} data-blocked={!!(hover?.error || notice)}>
        {notice ?? hover?.error ?? hover?.label}
        {hover?.plan && !notice && <div>{moveWiringSummary(hover.plan.wiring)}</div>}
        {!!hover?.locations.length && <div>共享结构影响范围：{hover.locations.join('、')}</div>}
      </div>
    </div>}
    <ul>
      {rows.map(item => {
        const { instancePath, instance, definition } = item;
        const key = hierarchyKey(instancePath);
        const name = showName(instancePath);
        const open = expanded.has(key);
        const module = definition.kind === 'module';
        const hasChildren = !!children.get(key)?.length || (module && definition.ports.length > 0);
        return <Fragment key={key}><li data-hierarchy-key={key}
          data-drop={hover?.key === key ? (hover.error ? 'blocked' : 'allowed') : undefined}
          style={{ paddingInlineStart: 4 + instancePath.length * 14 }}
          onDragOver={event => dragOver(event, item)} onDrop={event => drop(event, instancePath)}>
          {hasChildren ? <button type="button" className="v1-hierarchy-disclosure" aria-expanded={open}
            aria-label={`${open ? '折叠' : '展开'} ${name}`} onClick={() => toggle(instancePath)}>{open ? '▾' : '▸'}</button>
            : <span className="v1-hierarchy-disclosure" />}
          <button type="button" className="v1-hierarchy-entry" title={showPath(instancePath)}
            draggable={!!instance}
            onDragStart={event => {
              if (!instance) return;
              drag.current = { base: project, source: instancePath };
              setNotice(undefined);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(dragType, key);
            }}
            onDragEnd={endDrag}
            aria-label={`选中 ${name}`}
            aria-current={key === active ? 'location' : undefined} aria-pressed={selectedKeys.has(key)}
            onClick={event => select(instancePath, event.ctrlKey || event.shiftKey || event.metaKey)}
            onDoubleClick={module ? () => enter(instancePath) : undefined}>
            <DeviceIcon iconKey={definitionIcon(definition)} size={16} />
            <span>{name}</span>
          </button>
        </li>
          {open && module && definition.ports.map(port => <li className="v1-tree-port" key={port.id}
            style={{ paddingInlineStart: 4 + (instancePath.length + 1) * 14 }}>
            <button type="button" onClick={() => navigatePort(instancePath, port.id)}
              title={`对外端口 · ${portTypeLabels[port.type]} · ${portDirectionLabels[port.direction]}`}>
              <span aria-hidden="true">{port.direction === 'bidirectional' ? '↔' : port.direction === 'in' ? '↦' : '↤'}</span> {portDisplayName(port, false, definition.ports, item)}
            </button>
          </li>)}
        </Fragment>;
      })}
    </ul>
  </div>;
}
