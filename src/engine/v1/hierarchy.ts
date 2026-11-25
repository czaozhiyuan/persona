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
  | { status: 'branched'; chain: readonly EndpointRef[]; branches: readonly PortResolution[] }
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

  function mappedVoltage(portId: string): number | undefined {
    const values = new Set<number | undefined>();
    const pending = [{ owner: item, portId, ancestors: new Set<string>() }];
    while (pending.length && values.size <= 1) {
      const { owner, portId, ancestors } = pending.pop()!;
      const parent = owner.definition;
      // Library drafts can contain a cycle before project validation.
      if (parent.kind !== 'module' || ancestors.has(parent.id)) { values.add(undefined); continue; }
      ancestors.add(parent.id);
      const mappings = parent.portMappings?.filter(mapping => mapping.portId === portId) ?? [];
      if (!mappings.length) values.add(undefined);
      for (const { target } of mappings) {
        const slot = parent.instances.find(child => child.id === target.instanceId);
        const definition = slot && definitions.get(slot.definitionId);
        const port = definition?.ports.find(child => child.id === target.portId);
        if (!slot || !definition || !port) { values.add(undefined); continue; }
        const instancePath = [...owner.instancePath, slot.id];
        const instance = applySettings(slot, settingsByPath?.get(JSON.stringify(instancePath)));
        const parameters = readChildParameters(definition, instance, parent, owner.parameters, () => owner.instancePath);
        if (port.inputVoltageV || port.outputVoltageV) values.add(portVoltage(port, { parameters }));
        else pending.push({ owner: { definition, parameters, instancePath }, portId: port.id,
          ancestors: mappings.length === 1 ? ancestors : new Set(ancestors) });
      }
    }
    return values.size === 1 ? values.values().next().value : undefined;
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
    const result: PortResolution[] = [];
    const pending = [{ current: endpoint, definition: resolveInstance(endpoint.instancePath)?.definition, chain: [] as EndpointRef[], result }];
    while (pending.length) {
      const { current, definition, chain, result } = pending.pop()!;
      if (!definition?.ports.some(port => port.id === current.portId)) {
        result.push({ status: 'invalid_reference', chain, endpoint: current });
        continue;
      }
      chain.push(current);
      if (definition.kind === 'component') { result.push({ status: 'resolved', chain }); continue; }
      const mappings = definition.portMappings?.filter(mapping => mapping.portId === current.portId) ?? [];
      if (!mappings.length) { result.push({ status: 'unmapped', chain }); continue; }
      const branches: PortResolution[] = [];
      if (mappings.length > 1) result.push({ status: 'branched', chain, branches });
      for (let i = mappings.length - 1; i >= 0; i--) {
        const { target } = mappings[i];
        const slot = definition.instances.find(item => item.id === target.instanceId);
        pending.push({ current: { instancePath: [...current.instancePath, target.instanceId], portId: target.portId },
          definition: slot && definitions.get(slot.definitionId),
          chain: mappings.length > 1 ? [...chain] : chain, result: mappings.length > 1 ? branches : result });
      }
    }
    return result[0];
  }

  return { resolveInstance, resolvePort, walkInstances };
}
