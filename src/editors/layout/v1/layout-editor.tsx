import { useMemo, useState } from 'react';
import { resolveHierarchy } from '../../../engine/v1/hierarchy';
import type { InstancePath, PhysicalEnclosure, PhysicalPlacement } from '../../../model/v1/types';
import type { ProjectStore, ProjectStoreSnapshot } from '../../../state/v1/project-store';
import { updatePhysicalPlacement } from '../../../state/v1/physical-layout';
import { LayoutCanvas } from './layout-canvas';
import './layout.css';

const pathKey = (path: InstancePath) => JSON.stringify(path);
const rotations = [0, 90, 180, 270];

type LayoutOccurrence = {
  instancePath: InstancePath;
  key: string;
  name: string;
  label: string;
  enclosure?: PhysicalEnclosure;
};

function PositionFields({ placement }: { placement?: PhysicalPlacement }) {
  const rotation = placement?.rotationDeg ?? 0;
  return <div className="v1-layout-coordinates">
    <label>X 坐标 (mm)<input type="number" name="x" step="any" defaultValue={placement?.xMm ?? 0} required /></label>
    <label>Y 坐标 (mm)<input type="number" name="y" step="any" defaultValue={placement?.yMm ?? 0} required /></label>
    <label>顺时针旋转<select name="rotation" defaultValue={rotation}>
      {[...new Set([...rotations, rotation])].map(degree => <option key={degree} value={degree}>{degree}°</option>)}
    </select></label>
  </div>;
}

function placementAt(data: FormData, instancePath: InstancePath, enclosurePath: InstancePath): PhysicalPlacement {
  return {
    instancePath, enclosurePath,
    xMm: Number(data.get('x')), yMm: Number(data.get('y')), rotationDeg: Number(data.get('rotation')),
  };
}

export function LayoutEditor({ store, state }: { store: ProjectStore; state: ProjectStoreSnapshot }) {
  const { project, selection } = state;
  const [requestedEnclosure, setRequestedEnclosure] = useState<string>();
  const [error, setError] = useState('');
  const { enclosures, placeable } = useMemo(() => {
    const enclosures: (LayoutOccurrence & { enclosure: PhysicalEnclosure })[] = [];
    const placeable = new Map<string, LayoutOccurrence>();
    for (const { instancePath, instance, definition } of resolveHierarchy(project).walkInstances()) {
      const enclosure = definition.kind === 'module' ? definition.physicalEnclosure : undefined;
      if (!enclosure && definition.kind !== 'component') continue;
      const name = instance?.name ?? definition.name;
      const key = pathKey(instancePath);
      const item = { instancePath, key, name, label: `${name} · ${instancePath.join(' / ') || '系统根层级'}`, enclosure };
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
  const logicalEnclosure = enclosures.find(item => item.key === pathKey(logicalPath))
    ?? enclosures.reduce<typeof enclosures[number] | undefined>((nearest, item) => {
      const isAncestor = item.instancePath.every((id, index) => id === logicalPath[index]);
      return isAncestor && (!nearest || item.instancePath.length > nearest.instancePath.length) ? item : nearest;
    }, undefined);
  const active = enclosures.find(item => item.key === requestedEnclosure)
    ?? enclosures.find(item => selectedPlacement && item.key === pathKey(selectedPlacement.enclosurePath))
    ?? logicalEnclosure ?? enclosures[0];

  if (!active) return <section className="panel v1-layout" aria-labelledby="layout-title">
    <h2 id="layout-title">机箱俯视布局</h2>
    <p className="empty">请先在逻辑拓扑中创建带物理包络的机箱。</p>
  </section>;

  const objects = placements.filter(item => pathKey(item.enclosurePath) === active.key).map(placement => {
    const item = placeable.get(pathKey(placement.instancePath))!;
    return { placement, ...item };
  });
  const selected = objects.find(item => item.key === selectedKey);
  const containers = new Set([active.key]);
  for (let parent = byInstance.get(active.key); parent; parent = byInstance.get(pathKey(parent.enclosurePath))) {
    containers.add(pathKey(parent.enclosurePath));
  }
  const unplaced = [...placeable.values()].filter(item => !containers.has(item.key) && !byInstance.has(item.key));

  function commitPlacement(placement: PhysicalPlacement) {
    const previous = byInstance.get(pathKey(placement.instancePath));
    if (previous && previous.xMm === placement.xMm && previous.yMm === placement.yMm
      && previous.rotationDeg === placement.rotationDeg && pathKey(previous.enclosurePath) === pathKey(placement.enclosurePath)) {
      setError('');
      return;
    }
    const result = store.commit(draft => updatePhysicalPlacement(draft, placement));
    setError(result.ok ? '' : result.message);
    if (result.ok) store.selectInstance(placement.instancePath);
  }

  return <section className="panel v1-layout" aria-labelledby="layout-title">
    <div className="v1-layout-header">
      <h2 id="layout-title">机箱俯视布局</h2>
      <label>机箱实例
        <select value={active.key} onChange={event => { setRequestedEnclosure(event.target.value); setError(''); }}>
          {enclosures.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
      </label>
    </div>
    <p className="v1-layout-dimensions">
      {active.enclosure.widthMm} × {active.enclosure.depthMm} mm · 高 {active.enclosure.heightMm} mm
    </p>
    <div className="v1-layout-content">
      <div>
        <LayoutCanvas key={active.key} enclosure={active.enclosure} objects={objects} selected={selection.instancePath}
          select={store.selectInstance} move={commitPlacement} />
        <p className="v1-layout-note">原点在机箱左上角，向右和向下为正。圆点和箭头标记器件位置与朝向。</p>
      </div>
      <div className="v1-layout-tools">
        <label>已放置对象
          <select value={selected?.key ?? ''} onChange={event => {
            store.selectInstance(objects.find(item => item.key === event.target.value)?.instancePath);
            setError('');
          }}>
            <option value="">请选择</option>
            {objects.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
        </label>
        {selected && <form key={JSON.stringify(selected.placement)} onSubmit={event => {
          event.preventDefault();
          commitPlacement(placementAt(new FormData(event.currentTarget), selected.instancePath, active.instancePath));
        }}>
          <PositionFields placement={selected.placement} />
          <button type="submit">保存位置</button>
        </form>}
        <form key={active.key} onSubmit={event => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const item = unplaced.find(entry => entry.key === data.get('instance'));
          if (item) commitPlacement(placementAt(data, item.instancePath, active.instancePath));
        }}>
          <label>待放置对象
            <select name="instance" required defaultValue="">
              <option value="">{unplaced.length ? '选择器件或子机箱' : '无待放置对象'}</option>
              {unplaced.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          {unplaced.length > 0 && <><PositionFields /><button type="submit">放入机箱</button></>}
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  </section>;
}
