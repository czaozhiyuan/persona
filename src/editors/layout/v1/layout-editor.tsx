import { useMemo, useState } from 'react';
import { resolveHierarchy } from '../../../engine/v1/hierarchy';
import type { InstancePath, PhysicalEnclosure, PhysicalFootprint, PhysicalPlacement } from '../../../model/v1/types';
import type { ProjectStore, ProjectStoreSnapshot } from '../../../state/v1/project-store';
import { updatePhysicalPlacement } from '../../../state/v1/physical-layout';
import { LayoutCanvas, physicalDragType } from './layout-canvas';
import { gridStepMm, inspectLayout, normalizeRotation } from './layout-geometry';
import type { LayoutPoint } from './layout-geometry';
import './layout.css';

const pathKey = (path: InstancePath) => JSON.stringify(path);
const rotations = [0, 90, 180, 270];

type LayoutOccurrence = {
  instancePath: InstancePath;
  key: string;
  name: string;
  label: string;
  home?: string;
  enclosure?: PhysicalEnclosure;
  suggested?: PhysicalFootprint;
};

function PositionFields({ placement, item }: { placement: PhysicalPlacement; item: LayoutOccurrence }) {
  const { rotationDeg, footprint } = placement;
  return <>
    <div className="v1-layout-coordinates">
      <label>X (mm)<input type="number" name="x" step="any" defaultValue={placement.xMm} required /></label>
      <label>Y (mm)<input type="number" name="y" step="any" defaultValue={placement.yMm} required /></label>
      <label>顺时针角度<select name="rotation" defaultValue={rotationDeg}>
        {[...new Set([...rotations, rotationDeg])].map(degree => <option key={degree} value={degree}>{degree}°</option>)}
      </select></label>
    </div>
    {!item.enclosure && <div className="v1-layout-size">
      <label>宽 (mm)<input type="number" name="width" step="any" defaultValue={footprint?.widthMm}
        placeholder={item.suggested?.widthMm.toString()} /></label>
      <label>深 (mm)<input type="number" name="depth" step="any" defaultValue={footprint?.depthMm}
        placeholder={item.suggested?.depthMm.toString()} /></label>
    </div>}
  </>;
}

function PendingItems({ items, place }: { items: readonly LayoutOccurrence[]; place: (key: string) => void }) {
  return <ul className="v1-layout-pending-list">{items.map(item => <li key={item.key}>
    <button type="button" draggable onDragStart={event => {
      event.dataTransfer.setData(physicalDragType, item.key);
      event.dataTransfer.effectAllowed = 'move';
    }} title={item.label} onClick={() => place(item.key)} aria-label={`放入 ${item.name}`}>
      {item.name}<span aria-hidden="true">＋</span>
    </button>
  </li>)}</ul>;
}

export function LayoutEditor({ store, state }: { store: ProjectStore; state: ProjectStoreSnapshot }) {
  const { project, selection } = state;
  const [requestedEnclosure, setRequestedEnclosure] = useState<{ key: string; scope: string }>();
  const [error, setError] = useState('');
  const [snap, setSnap] = useState(true);
  const { enclosures, placeable } = useMemo(() => {
    const enclosures: (LayoutOccurrence & { enclosure: PhysicalEnclosure })[] = [];
    const placeable = new Map<string, LayoutOccurrence>();
    const nearest = new Map<string, string>();
    for (const { instancePath, instance, definition } of resolveHierarchy(project).walkInstances()) {
      const key = pathKey(instancePath);
      const enclosure = definition.kind === 'module' ? definition.physicalEnclosure : undefined;
      const suggested = definition.kind === 'component' ? definition.physicalFootprint : undefined;
      const home = instancePath.length ? nearest.get(pathKey(instancePath.slice(0, -1))) : undefined;
      if (enclosure || home !== undefined) nearest.set(key, enclosure ? key : home!);
      if (!enclosure && definition.kind !== 'component') continue;
      const name = instance?.name ?? definition.name;
      const item = { instancePath, key, name, home, label: `${name} · ${instancePath.join(' / ') || '系统根层级'}`, enclosure, suggested };
      if (instance) placeable.set(key, item);
      if (enclosure) enclosures.push({ ...item, enclosure });
    }
    return { enclosures, placeable };
  }, [project]);
  const placements = project.layout?.physical ?? [];
  const byInstance = new Map(placements.map(item => [pathKey(item.instancePath), item]));
  const selectedKey = selection.instancePath && pathKey(selection.instancePath);
  const selectedPlacement = selectedKey ? byInstance.get(selectedKey) : undefined;
  const logicalPath = selection.instancePath ?? selection.modulePath;
  const logicalEnclosure = enclosures.reduce<typeof enclosures[number] | undefined>((nearest, item) => {
    const isAncestor = item.instancePath.every((id, index) => id === logicalPath[index]);
    return isAncestor && (!nearest || item.instancePath.length > nearest.instancePath.length) ? item : nearest;
  }, undefined);
  const scope = pathKey(selection.modulePath);
  const active = enclosures.find(item => selectedPlacement && item.key === pathKey(selectedPlacement.enclosurePath))
    ?? (selectedKey ? logicalEnclosure : undefined)
    ?? enclosures.find(item => requestedEnclosure?.scope === scope && item.key === requestedEnclosure.key)
    ?? logicalEnclosure ?? enclosures[0];

  if (!active) return <section className="panel v1-layout" aria-labelledby="layout-title">
    <h2 id="layout-title">机箱俯视布局</h2>
    <p className="empty">请先在框图中创建带物理包络的机箱。</p>
  </section>;

  const objects = placements.filter(item => pathKey(item.enclosurePath) === active.key).map(placement => {
    const item = placeable.get(pathKey(placement.instancePath))!;
    return { placement, ...item, footprint: item.enclosure ?? placement.footprint ?? item.suggested };
  });
  const selected = objects.find(item => item.key === selectedKey);
  const containers = new Set([active.key]);
  for (let parent = byInstance.get(active.key); parent; parent = byInstance.get(pathKey(parent.enclosurePath))) {
    containers.add(pathKey(parent.enclosurePath));
  }
  const unplaced = [...placeable.values()].filter(item => !containers.has(item.key) && !byInstance.has(item.key));
  const pending = unplaced.filter(item => item.home === active.key);
  const other = unplaced.filter(item => item.home !== active.key);
  const issues = inspectLayout(active.enclosure, objects);
  const warned = new Set(issues.flatMap(issue => [pathKey(issue.object.placement.instancePath),
    ...(issue.kind === 'overlap' ? [pathKey(issue.other.placement.instancePath)] : [])]));

  function chooseEnclosure(key: string) {
    setRequestedEnclosure({ key, scope });
    store.selectInstance(undefined);
    setError('');
  }

  function select(path?: InstancePath) {
    setRequestedEnclosure({ key: active!.key, scope });
    store.selectInstance(path);
    setError('');
  }

  function commitPlacement(placement: PhysicalPlacement) {
    const previous = byInstance.get(pathKey(placement.instancePath));
    if (previous && previous.xMm === placement.xMm && previous.yMm === placement.yMm
      && previous.rotationDeg === placement.rotationDeg && pathKey(previous.enclosurePath) === pathKey(placement.enclosurePath)
      && previous.footprint?.widthMm === placement.footprint?.widthMm && previous.footprint?.depthMm === placement.footprint?.depthMm) {
      setError('');
      return;
    }
    const result = store.commit(draft => updatePhysicalPlacement(draft, placement));
    if (result.ok) select(placement.instancePath);
    else setError(result.message);
  }

  function place(key: string, point: LayoutPoint = { x: gridStepMm, y: gridStepMm }) {
    const item = unplaced.find(candidate => candidate.key === key);
    if (item) commitPlacement({ instancePath: item.instancePath, enclosurePath: active!.instancePath,
      xMm: point.x, yMm: point.y, rotationDeg: 0 });
  }

  function saveFields(data: FormData, placement: PhysicalPlacement, rotation?: number) {
    const width = data.get('width');
    const depth = data.get('depth');
    if (Boolean(width) !== Boolean(depth)) {
      setError('请同时填写宽和深，或同时留空。');
      return;
    }
    const next = {
      ...placement,
      xMm: Number(data.get('x')), yMm: Number(data.get('y')),
      rotationDeg: rotation ?? Number(data.get('rotation')),
      footprint: width && depth ? { widthMm: Number(width), depthMm: Number(depth) } : undefined,
    };
    commitPlacement(next);
  }

  return <section className="panel v1-layout" aria-labelledby="layout-title">
    <div className="v1-layout-header">
      <div>
        <h2 id="layout-title">机箱俯视布局</h2>
        <p className="v1-layout-dimensions">
          {active.enclosure.widthMm} × {active.enclosure.depthMm} mm · 高 {active.enclosure.heightMm} mm
        </p>
      </div>
      <label>机箱
        <select value={active.key} onChange={event => chooseEnclosure(event.target.value)}>
          {enclosures.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
      </label>
    </div>
    <div className="v1-layout-content">
      <aside className="v1-layout-pending" aria-labelledby="layout-pending-title">
        <h3 id="layout-pending-title">待放置对象</h3>
        {pending.length ? <PendingItems items={pending} place={place} /> : <p className="v1-layout-note">本机箱暂无待放置对象。</p>}
        {other.length > 0 && <details>
          <summary>其他未放置对象</summary>
          <PendingItems items={other} place={place} />
        </details>}
      </aside>
      <div>
        <LayoutCanvas key={active.key} enclosure={active.enclosure} objects={objects} selectedKey={selectedKey}
          warned={warned} snap={snap} select={select} move={commitPlacement} drop={place} />
        <div className="v1-layout-canvas-options">
          <p className="v1-layout-note">左上角为原点，向右、向下为正。拖入或点击待放置对象即可摆放。</p>
          <label><input type="checkbox" checked={snap} onChange={event => setSnap(event.currentTarget.checked)} /> 吸附到 {gridStepMm} mm 网格</label>
        </div>
      </div>
      <aside className="v1-layout-tools" aria-label="位置与尺寸">
        <label>已放置对象
          <select value={selected?.key ?? ''} onChange={event => select(objects.find(item => item.key === event.target.value)?.instancePath)}>
            <option value="">请选择</option>
            {objects.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}
          </select>
        </label>
        {selected && <form className="v1-layout-placement" key={JSON.stringify(selected.placement)} onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
          const data = new FormData(form);
          const rotation = submitter?.name === 'rotate'
            ? normalizeRotation(Number(data.get('rotation')) + 90) : undefined;
          saveFields(data, selected.placement, rotation);
        }}>
          <p className="v1-layout-note">{selected.footprint
            ? `${selected.footprint.widthMm} × ${selected.footprint.depthMm} mm · ${selected.enclosure ? '机箱包络' : selected.placement.footprint ? '实例尺寸' : '定义参考尺寸'}`
            : '尺寸未设置'}</p>
          <PositionFields placement={selected.placement} item={selected} />
          {selected.suggested && <p className="v1-layout-note">宽深留空时使用定义参考尺寸。</p>}
          <div className="actions">
            <button type="submit">保存位置与尺寸</button>
            <button type="submit" name="rotate">顺时针转 90°</button>
            {selected.enclosure && <button type="button" onClick={() => chooseEnclosure(selected.key)}>进入子机箱</button>}
          </div>
        </form>}
        {error && <p className="error" role="alert">{error}</p>}
        {issues.length > 0 && <div className="v1-layout-issues" aria-label="占位提示" aria-live="polite">
          <h3>占位提示</h3>
          <ul>{issues.map(issue => <li key={JSON.stringify([issue.kind, issue.object.placement.instancePath,
            issue.kind === 'overlap' && issue.other.placement.instancePath])}>
            <button type="button" onClick={() => select(issue.object.placement.instancePath)}>{issue.object.name}</button>
            {issue.kind === 'outside' ? ' 超出机箱边界' : <>
              {' 与 '}<button type="button" onClick={() => select(issue.other.placement.instancePath)}>{issue.other.name}</button>{' 重叠'}</>}
          </li>)}</ul>
        </div>}
      </aside>
    </div>
  </section>;
}
