import { isPowerPort } from '../../model/v1/types';
import { portVoltage } from '../../model/v1/display-names';
import type { SwitchState } from '../../model/v1/device';
import type { ParameterValue } from '../../model/v1/parameters';
import type { ComponentDefinition, EndpointRef, Instance, InstancePath, InstanceSettings, ModuleDefinition, Project } from '../../model/v1/types';
import { validateProject } from '../../model/v1/validate';

type Definition = ComponentDefinition | ModuleDefinition;

type ParameterSource =
  | { kind: 'default' }
  | { kind: 'override' }
  | { kind: 'mapped'; instancePath: InstancePath; parameterId: string };

type EffectiveParameter = {
  readonly value: ParameterValue;
  readonly source: ParameterSource;
};

export type ResolvedInstance = {
  readonly instancePath: InstancePath;
  readonly definition: Definition;
  /** The root is a definition without a containing instance. */
  readonly instance?: Instance;
  readonly settings?: InstanceSettings;
  readonly parameters: ReadonlyMap<string, EffectiveParameter>;
  readonly switchState?: SwitchState;
  readonly mappedVoltages?: ReadonlyMap<string, number>;
};

/** The chain starts at the requested port and includes each verified mapping target. */
export type PortResolution =
  | { status: 'resolved' | 'unmapped'; chain: readonly EndpointRef[] }
  | { status: 'invalid_reference'; chain: readonly EndpointRef[]; endpoint: EndpointRef };

export function readParameters(definition: Definition, instance?: Instance): Map<string, EffectiveParameter> {
  const parameters = new Map<string, EffectiveParameter>();
  const overrides = instance?.parameterOverrides;
  for (const parameter of definition.parameters ?? []) {
    if (overrides && Object.hasOwn(overrides, parameter.id)) {
      parameters.set(parameter.id, { value: overrides[parameter.id], source: { kind: 'override' } });
    } else if (parameter.defaultValue !== undefined) {
      parameters.set(parameter.id, { value: parameter.defaultValue, source: { kind: 'default' } });
    }
  }
  return parameters;
}

export function readChildParameters(
  definition: Definition, instance: Instance, parent: ModuleDefinition,
  parentParameters: ReadonlyMap<string, EffectiveParameter>, parentPath: () => InstancePath,
): Map<string, EffectiveParameter> {
  const parameters = readParameters(definition, instance);
  for (const mapping of parent.parameterMappings ?? []) {
    if (mapping.target.instanceId !== instance.id) continue;
    const parameter = parentParameters.get(mapping.parameterId);
    if (parameter) {
      parameters.set(mapping.target.parameterId, {
        value: parameter.value,
        source: { kind: 'mapped', instancePath: parentPath(), parameterId: mapping.parameterId },
      });
    }
  }
  return parameters;
}

function applySettings(slot: Instance, settings?: InstanceSettings): Instance {
  if (!settings) return slot;
  return {
    ...slot,
    name: settings.name ?? slot.name,
    switchStateId: settings.switchStateId ?? slot.switchStateId,
    parameterOverrides: settings.parameterOverrides
      ? { ...slot.parameterOverrides, ...settings.parameterOverrides } : slot.parameterOverrides,
  };
}

/** An undeclared module voltage label follows its mapping without adding a budget constraint. */
export function withMappedVoltages(item: ResolvedInstance, definitions: ReadonlyMap<string, Definition>,
  settingsByPath?: ReadonlyMap<string, InstanceSettings>): ResolvedInstance {
  if (item.definition.kind !== 'module' || !item.definition.portMappings?.length) return item;
  const voltages = new Map<string, number>();
  for (const port of item.definition.ports) {
    if (!isPowerPort(port.type) || port.inputVoltageV || port.outputVoltageV) continue;
    const value = mappedVoltage(port.id);
    if (value !== undefined) voltages.set(port.id, value);
  }
  return voltages.size ? { ...item, mappedVoltages: voltages } : item;

  function mappedVoltage(portId: string) {
    let { definition, parameters, instancePath } = item;
    const visited = new Set<string>();
    // A library draft can temporarily contain a cycle before validation.
    while (definition.kind === 'module' && !visited.has(definition.id)) {
      visited.add(definition.id);
      const target = definition.portMappings?.find(m => m.portId === portId)?.target;
      const slot = target && definition.instances.find(i => i.id === target.instanceId);
      const child = slot && definitions.get(slot.definitionId);
      const port = child?.ports.find(p => p.id === target?.portId);
      if (!slot || !child || !port) return;
      const path = [...instancePath, slot.id];
      const instance = applySettings(slot, settingsByPath?.get(JSON.stringify(path)));
      parameters = readChildParameters(child, instance, definition, parameters, () => instancePath);
      if (port.inputVoltageV || port.outputVoltageV) return portVoltage(port, { parameters });
      definition = child;
      instancePath = path;
      portId = port.id;
    }
  }
}

function selectedSwitchState(definition: Definition, instance?: Instance): SwitchState | undefined {
  return definition.kind === 'component'
    ? definition.switchStates?.find(state => state.id === instance?.switchStateId)
    : undefined;
}

/**
 * Validates a V1 snapshot using the domain rules, then resolves occurrences on demand.
 * Use a new resolver when the project changes. Definitions and values are borrowed from the snapshot.
 */
export function resolveHierarchy(project: Project) {
  validateProject(project);
  const definitions = new Map<string, Definition>();
  for (const definition of [...project.moduleDefinitions, ...project.componentDefinitions]) {
    definitions.set(definition.id, definition);
  }
  const settingsByPath = new Map(project.instanceSettings?.map(item => [JSON.stringify(item.instancePath), item]));
  // Validation guarantees the root and all child definitions exist.
  const root = project.moduleDefinitions.find(definition => definition.id === project.rootModuleDefinitionId)!;

  function resolveInstance(instancePath: InstancePath): ResolvedInstance | undefined {
    let definition: Definition = root;
    let instance: Instance | undefined;
    let settings: InstanceSettings | undefined;
    let parameters = readParameters(root);
    for (const [depth, instanceId] of instancePath.entries()) {
      if (definition.kind !== 'module') return undefined;
      const slot = definition.instances.find(child => child.id === instanceId);
      if (!slot) return undefined;
      settings = settingsByPath.size ? settingsByPath.get(JSON.stringify(instancePath.slice(0, depth + 1))) : undefined;
      instance = applySettings(slot, settings);

      const childDefinition: Definition = definitions.get(instance.definitionId)!;
      parameters = readChildParameters(childDefinition, instance, definition, parameters, () => instancePath.slice(0, depth));
      definition = childDefinition;
    }
    return withMappedVoltages({ instancePath: [...instancePath], instance, settings, definition, parameters,
      switchState: selectedSwitchState(definition, instance) }, definitions, settingsByPath);
  }

  /** Walks occurrences from the root, reusing each parent's resolved parameters. */
  function* walkInstances(): IterableIterator<ResolvedInstance> {
    const pending = [resolveInstance([])!];
    while (pending.length > 0) {
      const parent = pending.pop()!;
      yield parent;
      if (parent.definition.kind !== 'module') continue;
      const children = parent.definition.instances;
      for (let i = children.length - 1; i >= 0; i--) {
        const slot = children[i];
        const instancePath = [...parent.instancePath, slot.id];
        const settings = settingsByPath.get(JSON.stringify(instancePath));
        const instance = applySettings(slot, settings);
        const definition = definitions.get(instance.definitionId)!;
        pending.push(withMappedVoltages({
          instancePath, instance, settings, definition,
          parameters: readChildParameters(definition, instance, parent.definition, parent.parameters, () => parent.instancePath),
          switchState: selectedSwitchState(definition, instance),
        }, definitions, settingsByPath));
      }
    }
  }

  function resolvePort(endpoint: EndpointRef): PortResolution {
    const chain: EndpointRef[] = [];
    const occurrence = resolveInstance(endpoint.instancePath);
    let definition = occurrence?.definition;
    let current: EndpointRef = { instancePath: [...endpoint.instancePath], portId: endpoint.portId };
    while (definition && definition.ports.some(port => port.id === current.portId)) {
      chain.push(current);
      if (definition.kind === 'component') return { status: 'resolved', chain };
      const mapping = definition.portMappings?.find(item => item.portId === current.portId);
      if (!mapping) return { status: 'unmapped', chain };

      const { instanceId, portId } = mapping.target;
      const child = definition.instances.find(item => item.id === instanceId);
      definition = child && definitions.get(child.definitionId);
      current = { instancePath: [...current.instancePath, instanceId], portId };
    }
    return { status: 'invalid_reference', chain, endpoint: current };
  }

  return { resolveInstance, resolvePort, walkInstances };
}
