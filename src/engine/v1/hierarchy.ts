import type { SwitchState } from '../../model/v1/device';
import type { ParameterValue } from '../../model/v1/parameters';
import type { ComponentDefinition, EndpointRef, Instance, InstancePath, ModuleDefinition, Project } from '../../model/v1/types';
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
  readonly parameters: ReadonlyMap<string, EffectiveParameter>;
  readonly switchState?: SwitchState;
};

/** The chain starts at the requested port and includes each verified mapping target. */
export type PortResolution =
  | { status: 'resolved' | 'unmapped'; chain: readonly EndpointRef[] }
  | { status: 'invalid_reference'; chain: readonly EndpointRef[]; endpoint: EndpointRef };

function readParameters(definition: Definition, instance?: Instance): Map<string, EffectiveParameter> {
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
  // Validation guarantees the root and all child definitions exist.
  const root = project.moduleDefinitions.find(definition => definition.id === project.rootModuleDefinitionId)!;

  function resolveInstance(instancePath: InstancePath): ResolvedInstance | undefined {
    let definition: Definition = root;
    let instance: Instance | undefined;
    let parameters = readParameters(root);
    for (const [depth, instanceId] of instancePath.entries()) {
      if (definition.kind !== 'module') return undefined;
      instance = definition.instances.find(child => child.id === instanceId);
      if (!instance) return undefined;

      const childDefinition: Definition = definitions.get(instance.definitionId)!;
      const childParameters = readParameters(childDefinition, instance);
      for (const mapping of definition.parameterMappings ?? []) {
        if (mapping.target.instanceId !== instanceId) continue;
        const parameter = parameters.get(mapping.parameterId);
        if (parameter) {
          childParameters.set(mapping.target.parameterId, {
            value: parameter.value,
            source: { kind: 'mapped', instancePath: instancePath.slice(0, depth), parameterId: mapping.parameterId },
          });
        }
      }
      definition = childDefinition;
      parameters = childParameters;
    }
    const switchStateId = instance?.switchStateId;
    const switchState = definition.kind === 'component' && switchStateId !== undefined
      ? definition.switchStates?.find(state => state.id === switchStateId)
      : undefined;
    return { instancePath: [...instancePath], instance, definition, parameters, switchState };
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

  return { resolveInstance, resolvePort };
}
