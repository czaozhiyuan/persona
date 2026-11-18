import type { Instance, InstancePath, ModuleDefinition, PortDefinition, Project } from './types';

type Definition = Project['componentDefinitions'][number] | ModuleDefinition;
const portTypes = new Set(['RF', 'OPTICAL', 'DC_POWER', 'CONTROL']);

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function indexById<T extends { id: string }>(items: readonly T[], context: string): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    requireValid(item.id.trim(), `${context}: ID must not be blank`);
    requireValid(!index.has(item.id), `${context}: duplicate ID "${item.id}"`);
    index.set(item.id, item);
  }
  return index;
}

function validateAcyclic(modules: readonly ModuleDefinition[], definitions: ReadonlyMap<string, Definition>): void {
  const complete = new Set<string>();
  const active = new Set<string>();
  for (const module of modules) {
    if (complete.has(module.id)) continue;
    const stack = [{ module, nextChild: 0 }];
    active.add(module.id);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.nextChild === frame.module.instances.length) {
        stack.pop();
        active.delete(frame.module.id);
        complete.add(frame.module.id);
        continue;
      }
      const child = definitions.get(frame.module.instances[frame.nextChild++].definitionId);
      if (child?.kind !== 'module' || complete.has(child.id)) continue;
      if (active.has(child.id)) {
        const cycle = stack.slice(stack.findIndex(entry => entry.module.id === child.id)).map(entry => entry.module.id);
        throw new Error(`Module definition cycle: ${[...cycle, child.id].join(' -> ')}`);
      }
      active.add(child.id);
      stack.push({ module: child, nextChild: 0 });
    }
  }
}

/** Validates typed V1 domain data. Parsing and schema validation belong to storage. */
export function validateProject(project: Project): void {
  requireValid(project.id.trim(), 'Project ID must not be blank');
  const definitions = indexById<Definition>([...project.componentDefinitions, ...project.moduleDefinitions], 'Definitions');
  const root = definitions.get(project.rootModuleDefinitionId);
  requireValid(root?.kind === 'module', `Root definition "${project.rootModuleDefinitionId}" must reference a module`);

  const portsByDefinition = new Map<string, Map<string, PortDefinition>>();
  const childrenByModule = new Map<string, Map<string, Instance>>();
  for (const definition of definitions.values()) {
    const ports = indexById(definition.ports, `Ports of "${definition.id}"`);
    for (const port of ports.values()) {
      requireValid(portTypes.has(port.type) && (port.direction === 'in' || port.direction === 'out'),
        `Invalid type or direction for port "${port.id}" in "${definition.id}"`);
    }
    portsByDefinition.set(definition.id, ports);
  }

  for (const module of project.moduleDefinitions) {
    const children = indexById(module.instances, `Instances in "${module.id}"`);
    childrenByModule.set(module.id, children);
    for (const instance of children.values()) {
      requireValid(definitions.has(instance.definitionId),
        `Instance "${instance.id}" in "${module.id}" references unknown definition "${instance.definitionId}"`);
    }
    const mapped = new Set<string>();
    for (const mapping of module.portMappings ?? []) {
      const port = portsByDefinition.get(module.id)?.get(mapping.portId);
      requireValid(port, `Unknown public port "${mapping.portId}" in "${module.id}"`);
      requireValid(!mapped.has(port.id), `Duplicate mapping for port "${port.id}" in "${module.id}"`);
      const child = children.get(mapping.target.instanceId);
      requireValid(child, `Mapping "${port.id}" in "${module.id}" must target a direct child`);
      const target = portsByDefinition.get(child.definitionId)?.get(mapping.target.portId);
      requireValid(target, `Mapping "${port.id}" in "${module.id}" references unknown child port "${mapping.target.portId}"`);
      requireValid(port.type === target.type && port.direction === target.direction,
        `Mapping "${port.id}" in "${module.id}" must preserve port type and direction`);
      mapped.add(port.id);
    }
    if (module.physicalEnclosure) {
      const { widthMm, depthMm, heightMm } = module.physicalEnclosure;
      requireValid([widthMm, depthMm, heightMm].every(value => Number.isFinite(value) && value > 0),
        `Enclosure "${module.id}" must have positive finite dimensions in mm`);
    }
  }
  validateAcyclic(project.moduleDefinitions, definitions);

  const definitionAtPath = (path: InstancePath): Definition | undefined => {
    let current: Definition = root;
    for (const id of path) {
      const child: Instance | undefined = childrenByModule.get(current.id)?.get(id);
      if (!child) return undefined;
      // All child definition references were checked before looking up paths.
      current = definitions.get(child.definitionId)!;
    }
    return current;
  };
  const positions = new Set<string>();
  for (const placement of project.layout?.physical ?? []) {
    const key = JSON.stringify(placement.instancePath);
    requireValid(definitionAtPath(placement.instancePath)?.kind === 'component',
      `Physical placement must reference a component instance: ${key}`);
    const enclosure = definitionAtPath(placement.enclosurePath);
    requireValid(enclosure?.kind === 'module' && enclosure.physicalEnclosure,
      `Physical placement ${key} must reference an enclosure module instance`);
    requireValid(!positions.has(key), `Duplicate physical placement: ${key}`);
    requireValid(Number.isFinite(placement.xMm) && Number.isFinite(placement.yMm) && placement.rotationDeg % 90 === 0,
      `Invalid physical coordinates or rotation: ${key}`);
    positions.add(key);
  }
  positions.clear();
  for (const placement of project.layout?.topology ?? []) {
    const key = JSON.stringify(placement.instancePath);
    requireValid(placement.instancePath.length && definitionAtPath(placement.instancePath),
      `Topology placement must reference an instance: ${key}`);
    requireValid(!positions.has(key), `Duplicate topology placement: ${key}`);
    requireValid(Number.isFinite(placement.x) && Number.isFinite(placement.y), `Invalid topology coordinates: ${key}`);
    positions.add(key);
  }
}
