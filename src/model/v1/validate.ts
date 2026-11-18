import type { Instance, InstancePath, ModuleDefinition, PortDefinition, Project } from './types';
import type { ParameterDefinition } from './parameters';
import { channelSetsOverlap, validateConversionProfile, validateDevice, validatePortConstraints } from './validate-device';
import { parameterCanFeed, validateParameterDefinition, validateParameterValue } from './validate-parameters';
import { indexById, requireValid } from './validation';

type Definition = Project['componentDefinitions'][number] | ModuleDefinition;
const portTypes = new Set(['RF', 'OPTICAL', 'DC_POWER', 'CONTROL']);

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

function validatePhysicalContainment(parentByPlacement: ReadonlyMap<string, string>): void {
  const checked = new Set<string>();
  for (const start of parentByPlacement.keys()) {
    const chain = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && !checked.has(current)) {
      requireValid(!chain.has(current), `Physical containment cycle at ${current}`);
      chain.add(current);
      current = parentByPlacement.get(current);
    }
    for (const key of chain) checked.add(key);
  }
}

/** Validates typed V1 domain data. Parsing and schema validation belong to storage. */
export function validateProject(project: Project): void {
  requireValid(project.id.trim(), 'Project ID must not be blank');
  const definitions = indexById<Definition>([...project.componentDefinitions, ...project.moduleDefinitions], 'Definitions');
  const root = definitions.get(project.rootModuleDefinitionId);
  requireValid(root?.kind === 'module', `Root definition "${project.rootModuleDefinitionId}" must reference a module`);

  const portsByDefinition = new Map<string, Map<string, PortDefinition>>();
  const paramsByDefinition = new Map<string, Map<string, ParameterDefinition>>();
  const childrenByModule = new Map<string, Map<string, Instance>>();
  for (const definition of definitions.values()) {
    const ports = indexById(definition.ports, `Ports of "${definition.id}"`);
    for (const port of ports.values()) {
      requireValid(portTypes.has(port.type) && (port.direction === 'in' || port.direction === 'out'),
        `Invalid type or direction for port "${port.id}" in "${definition.id}"`);
      validatePortConstraints(port, `Port "${port.id}" in "${definition.id}"`);
    }
    portsByDefinition.set(definition.id, ports);
    const parameters = indexById(definition.parameters ?? [], `Parameters of "${definition.id}"`);
    for (const parameter of parameters.values()) {
      validateParameterDefinition(parameter, `Parameter "${parameter.id}" in "${definition.id}"`);
    }
    paramsByDefinition.set(definition.id, parameters);
    if (definition.kind === 'component') validateDevice(definition, ports, parameters);
  }
  for (const profile of indexById(project.conversionProfiles ?? [], 'Conversion profiles').values()) {
    validateConversionProfile(profile);
  }

  for (const module of project.moduleDefinitions) {
    const children = indexById(module.instances, `Instances in "${module.id}"`);
    childrenByModule.set(module.id, children);
    for (const instance of children.values()) {
      const definition = definitions.get(instance.definitionId);
      requireValid(definition,
        `Instance "${instance.id}" in "${module.id}" references unknown definition "${instance.definitionId}"`);
      const context = `Instance "${instance.id}" in "${module.id}"`;
      if (definition.kind === 'component' && definition.switchStates) {
        requireValid(definition.switchStates.some(state => state.id === instance.switchStateId),
          `${context}: missing or unknown switch state "${instance.switchStateId}"`);
      } else {
        requireValid(instance.switchStateId === undefined, `${context}: only optical switch instances accept switch states`);
      }
      for (const [id, value] of Object.entries(instance.parameterOverrides ?? {})) {
        const parameter = paramsByDefinition.get(definition.id)?.get(id);
        requireValid(parameter?.overridable, `${context}: parameter "${id}" is not exposed for override`);
        validateParameterValue(parameter, value, `${context}, parameter "${id}"`);
      }
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
      requireValid(channelSetsOverlap(port, target), `Mapping "${port.id}" in "${module.id}" has no shared optical channel`);
      mapped.add(port.id);
    }
    const mappedParameters = new Set<string>();
    for (const mapping of module.parameterMappings ?? []) {
      const context = `Parameter mapping "${mapping.parameterId}" in "${module.id}"`;
      const source = paramsByDefinition.get(module.id)?.get(mapping.parameterId);
      requireValid(source, `${context}: unknown module parameter`);
      const child = children.get(mapping.target.instanceId);
      requireValid(child, `${context}: must target a direct child`);
      const target = paramsByDefinition.get(child.definitionId)?.get(mapping.target.parameterId);
      requireValid(target?.overridable, `${context}: child parameter is not exposed for override`);
      requireValid(parameterCanFeed(source, target), `${context}: incompatible parameter types, units or accepted values`);
      const key = JSON.stringify([child.id, target.id]);
      requireValid(!mappedParameters.has(key), `${context}: child parameter has multiple mappings`);
      mappedParameters.add(key);
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
  const parentByPlacement = new Map<string, string>();
  for (const placement of project.layout?.physical ?? []) {
    const key = JSON.stringify(placement.instancePath);
    const placed = definitionAtPath(placement.instancePath);
    requireValid(placement.instancePath.length && placed && (placed.kind === 'component' || placed.physicalEnclosure),
      `Physical placement must reference a component or enclosure module instance: ${key}`);
    const enclosure = definitionAtPath(placement.enclosurePath);
    requireValid(enclosure?.kind === 'module' && enclosure.physicalEnclosure,
      `Physical placement ${key} must reference an enclosure module instance`);
    requireValid(!parentByPlacement.has(key), `Duplicate physical placement: ${key}`);
    requireValid(Number.isFinite(placement.xMm) && Number.isFinite(placement.yMm) && placement.rotationDeg % 90 === 0,
      `Invalid physical coordinates or rotation: ${key}`);
    parentByPlacement.set(key, JSON.stringify(placement.enclosurePath));
  }
  validatePhysicalContainment(parentByPlacement);
  const positions = new Set<string>();
  for (const placement of project.layout?.topology ?? []) {
    const key = JSON.stringify(placement.instancePath);
    requireValid(placement.instancePath.length && definitionAtPath(placement.instancePath),
      `Topology placement must reference an instance: ${key}`);
    requireValid(!positions.has(key), `Duplicate topology placement: ${key}`);
    requireValid(Number.isFinite(placement.x) && Number.isFinite(placement.y), `Invalid topology coordinates: ${key}`);
    positions.add(key);
  }
}
