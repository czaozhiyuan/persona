import { resolveHierarchy } from '../../../engine/v1/hierarchy';
import type { PortDefinition } from '../../../model/v1/types';
import { updateDefinitionPort } from '../../../state/v1/module-ports';
import type { ProjectStore } from '../../../state/v1/project-store';
import { planPortDeletion } from '../../../state/v1/topology-edits';
import { createPathNames } from '../structure-scope';

export function savePort(store: ProjectStore, definitionId: string, next: PortDefinition) {
  const base = store.getSnapshot().project;
  const board = base.componentDefinitions.find(d => d.id === definitionId && d.controlRouting);
  const port = board?.ports.find(p => p.id === next.id);
  if (port?.type === 'CONTROL' && (port.type !== next.type || port.direction !== next.direction)) {
    // Every wire, mapping and transfer at the old unidirectional control terminal becomes incompatible.
    const plan = planPortDeletion(base, definitionId, port.id, next)!;
    const impacts = plan.impacts.filter(item => item.kind !== '端口');
    if (impacts.length) {
      const { showPath } = createPathNames([...resolveHierarchy(base).walkInstances()]);
      const details = impacts.map(item => `${item.kind} · ${item.name}（${item.paths.map(showPath).join('、')}）`);
      if (!window.confirm(['修改此控制端口将解绑以下引用，是否继续？', ...details].join('\n'))) return;
      return store.commit(() => plan.project);
    }
  }
  return store.commit(project => updateDefinitionPort(project, definitionId, next));
}
