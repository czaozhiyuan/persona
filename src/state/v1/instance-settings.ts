import { moduleName } from './module-name';
import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { InstancePath, InstanceSettings, Project } from '../../model/v1/types';

export function editInstanceSettings(project: Project, instancePath: InstancePath,
  change: (current: InstanceSettings) => InstanceSettings): Project {
  const key = JSON.stringify(instancePath);
  const previous = project.instanceSettings ?? [];
  const current = previous.find(item => JSON.stringify(item.instancePath) === key);
  const { name: requested, switchStateId, parameterOverrides } = change(current ?? { instancePath });
  let name = requested;
  if (requested !== current?.name) {
    const owner = resolveHierarchy(project).resolveInstance(instancePath);
    if (owner?.definition.kind === 'module' && requested !== undefined) {
      name = moduleName(project, requested, { except: instancePath });
    }
  }
  const instanceSettings = previous.filter(item => JSON.stringify(item.instancePath) !== key);
  if (name !== undefined || switchStateId !== undefined || Object.keys(parameterOverrides ?? {}).length) {
    instanceSettings.push({ instancePath, name, switchStateId, parameterOverrides });
  }
  return { ...project, instanceSettings: instanceSettings.length ? instanceSettings : undefined };
}
