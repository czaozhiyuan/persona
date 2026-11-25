import { wireEndpoints, wireRouteKey } from './wire-route';
import { isSupplyOutput } from './types';
import type { Instance, InstancePath, ModuleDefinition, PhysicalFootprint, PortDefinition, Project } from './types';
import type { ParameterDefinition } from './parameters';
import { channelSetsOverlap, validateDevice, validatePortConstraints } from './validate-device';
import { canMapDirection } from './types';
import { parameterCanFeed, validateParameterDefinition, validateParameterValue } from './validate-parameters';
import { validateModuleTopology, validateNamedLinks } from './validate-topology';
import { indexById, requireValid } from './validation';

type Definition = Project['componentDefinitions'][number] | ModuleDefinition;
const portTypes = new Set(['RF', 'OPTICAL', 'DC_POWER', 'AC_POWER', 'CONTROL']);

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
        throw new Error(`模块定义存在循环引用： ${[...cycle, child.id].join(' -> ')}`);
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
      requireValid(!chain.has(current), `物理包含关系存在循环： ${current}`);
      chain.add(current);
      current = parentByPlacement.get(current);
    }
    for (const key of chain) checked.add(key);
  }
}

function validFootprint({ widthMm, depthMm }: PhysicalFootprint): boolean {
  return [widthMm, depthMm].every(value => Number.isFinite(value) && value > 0);
}

/** Validates typed V1 domain data. Parsing and schema validation belong to storage. */
export function validateProject(project: Project): void {
  requireValid(project.id.trim(), '工程 ID 不得为空');
  const definitions = indexById<Definition>([...project.componentDefinitions, ...project.moduleDefinitions], '工程定义');
  const root = definitions.get(project.rootModuleDefinitionId);
  requireValid(root?.kind === 'module', `根定义「${project.rootModuleDefinitionId}」必须引用模块`);

  const portsByDefinition = new Map<string, Map<string, PortDefinition>>();
  const paramsByDefinition = new Map<string, Map<string, ParameterDefinition>>();
  const childrenByModule = new Map<string, Map<string, Instance>>();
  for (const definition of definitions.values()) {
    const parameters = indexById(definition.parameters ?? [], `定义「${definition.id}」的参数`);
    for (const parameter of parameters.values()) {
      validateParameterDefinition(parameter, `定义「${definition.id}」的参数「${parameter.id}」`);
    }
    paramsByDefinition.set(definition.id, parameters);
    const ports = indexById(definition.ports, `定义「${definition.id}」的端口`);
    for (const port of ports.values()) {
      requireValid(portTypes.has(port.type) && (port.direction === 'in' || port.direction === 'out'
        || (port.direction === 'bidirectional' && port.type === 'OPTICAL')),
        `定义「${definition.id}」的端口「${port.id}」类型或方向无效`);
      requireValid(!port.opticalEmitter || definition.kind === 'component', `定义「${definition.id}」：请在实际器件的光输出端口设置光源。`);
      requireValid(port.supplyCapacity === undefined || isSupplyOutput(definition, port), `定义「${definition.id}」：仅电源的直流输出端口可设置供电容量。`);
      validatePortConstraints(port, parameters, `定义「${definition.id}」的端口「${port.id}」`);
    }
    portsByDefinition.set(definition.id, ports);
    if (definition.kind === 'component') {
      if (definition.physicalFootprint) requireValid(validFootprint(definition.physicalFootprint),
        `器件「${definition.id}」的宽和深须为以 mm 计量的有限正数`);
      validateDevice(definition, ports, parameters);
    }
  }

  function validateOverrides(definition: Definition, overrides: Instance['parameterOverrides'], context: string) {
    for (const [id, value] of Object.entries(overrides ?? {})) {
      const parameter = paramsByDefinition.get(definition.id)?.get(id);
      requireValid(parameter?.overridable, `${context}: 参数「${id}」未开放覆盖`);
      validateParameterValue(parameter, value, `${context}的参数「${id}」`);
    }
  }

  for (const module of project.moduleDefinitions) {
    const children = indexById(module.instances, `模块「${module.id}」的实例`);
    childrenByModule.set(module.id, children);
    for (const instance of children.values()) {
      const definition = definitions.get(instance.definitionId);
      requireValid(definition,
        `模块「${module.id}」的实例「${instance.id}」引用了不存在的定义「${instance.definitionId}」`);
      const context = `模块「${module.id}」的实例「${instance.id}」`;
      if (definition.kind === 'component' && definition.switchStates) {
        requireValid(definition.switchStates.some(state => state.id === instance.switchStateId),
          `${context}: 光开关状态缺失或无效「${instance.switchStateId}」`);
      } else {
        requireValid(instance.switchStateId === undefined, `${context}: 仅光开关实例可以设置开关状态`);
      }
      validateOverrides(definition, instance.parameterOverrides, context);
    }
    validateModuleTopology(module, endpoint => {
      const child = children.get(endpoint.instanceId);
      return child && portsByDefinition.get(child.definitionId)?.get(endpoint.portId);
    });
    const mapped = new Set<string>();
    for (const mapping of module.portMappings ?? []) {
      const port = portsByDefinition.get(module.id)?.get(mapping.portId);
      requireValid(port, `模块「${module.id}」没有对外端口「${mapping.portId}」`);
      requireValid(!mapped.has(port.id), `模块「${module.id}」的端口「${port.id}」存在重复映射`);
      const child = children.get(mapping.target.instanceId);
      requireValid(child, `模块「${module.id}」的端口「${port.id}」须映射到直接子实例`);
      const target = portsByDefinition.get(child.definitionId)?.get(mapping.target.portId);
      requireValid(target, `模块「${module.id}」的端口「${port.id}」映射到不存在的子实例端口「${mapping.target.portId}」`);
      requireValid(port.type === target.type && canMapDirection(port.direction, target.direction),
        `模块「${module.id}」的端口「${port.id}」映射前后须保持端口类型和方向一致`);
      requireValid(channelSetsOverlap(port, target), `模块「${module.id}」的端口「${port.id}」与映射端口没有共同的光通道`);
      mapped.add(port.id);
    }
    const mappedParameters = new Set<string>();
    for (const mapping of module.parameterMappings ?? []) {
      const context = `模块「${module.id}」的参数映射「${mapping.parameterId}」`;
      const source = paramsByDefinition.get(module.id)?.get(mapping.parameterId);
      requireValid(source, `${context}: 模块参数不存在`);
      const child = children.get(mapping.target.instanceId);
      requireValid(child, `${context}: 目标必须是直接子实例`);
      const target = paramsByDefinition.get(child.definitionId)?.get(mapping.target.parameterId);
      requireValid(target?.overridable, `${context}: 子实例参数未开放覆盖`);
      requireValid(parameterCanFeed(source, target), `${context}: 参数类型、单位或允许的取值不兼容`);
      const key = JSON.stringify([child.id, target.id]);
      requireValid(!mappedParameters.has(key), `${context}: 子实例参数存在多条映射`);
      mappedParameters.add(key);
    }
    if (module.physicalEnclosure) {
      const { widthMm, depthMm, heightMm } = module.physicalEnclosure;
      requireValid([widthMm, depthMm, heightMm].every(value => Number.isFinite(value) && value > 0),
        `机箱「${module.id}」的尺寸须为以 mm 计量的有限正数`);
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
  const occurrenceSettings = new Set<string>();
  for (const settings of project.instanceSettings ?? []) {
    const key = JSON.stringify(settings.instancePath);
    const context = `实例设置 ${key}`;
    const definition = definitionAtPath(settings.instancePath);
    requireValid(settings.instancePath.length && definition, `${context}：必须引用现有实例`);
    requireValid(!occurrenceSettings.has(key), `${context}：路径重复`);
    requireValid(settings.name === undefined || settings.name.trim(), `${context}：名称不能为空`);
    if (settings.switchStateId !== undefined) {
      requireValid(definition.kind === 'component' && definition.switchStates?.some(state => state.id === settings.switchStateId),
        `${context}：光开关状态无效「${settings.switchStateId}」`);
    }
    validateOverrides(definition, settings.parameterOverrides, context);
    occurrenceSettings.add(key);
  }
  validateNamedLinks(project.namedLinks ?? [], definitionAtPath);

  const parentByPlacement = new Map<string, string>();
  for (const placement of project.layout?.physical ?? []) {
    const key = JSON.stringify(placement.instancePath);
    const placed = definitionAtPath(placement.instancePath);
    requireValid(placement.instancePath.length && placed && (placed.kind === 'component' || placed.physicalEnclosure),
      `物理布局必须引用器件实例或机箱模块实例：${key}`);
    const enclosure = definitionAtPath(placement.enclosurePath);
    requireValid(enclosure?.kind === 'module' && enclosure.physicalEnclosure,
      `物理布局位置 ${key} 必须指定一个机箱模块实例`);
    requireValid(!parentByPlacement.has(key), `物理布局位置重复: ${key}`);
    requireValid(Number.isFinite(placement.xMm) && Number.isFinite(placement.yMm) && placement.rotationDeg % 90 === 0,
      `物理坐标或旋转角度无效: ${key}`);
    if (placement.footprint) requireValid(placed.kind === 'component' && validFootprint(placement.footprint),
      `物理位置 ${key} 的实例宽深仅可用于器件，且须为以 mm 计量的有限正数`);
    parentByPlacement.set(key, JSON.stringify(placement.enclosurePath));
  }
  validatePhysicalContainment(parentByPlacement);
  const positions = new Set<string>();
  for (const placement of project.layout?.topology ?? []) {
    const key = JSON.stringify(placement.instancePath);
    requireValid(placement.instancePath.length && definitionAtPath(placement.instancePath),
      `拓扑位置必须引用一个实例: ${key}`);
    requireValid(!positions.has(key), `拓扑位置重复: ${key}`);
    requireValid(Number.isFinite(placement.x) && Number.isFinite(placement.y), `拓扑坐标无效: ${key}`);
    positions.add(key);
  }
  const routes = new Set<string>();
  for (const route of project.layout?.topologyWireRoutes ?? []) {
    const key = wireRouteKey(route.modulePath, route.wire);
    const owner = definitionAtPath(route.modulePath);
    requireValid(owner?.kind === 'module' && wireEndpoints(owner, route.wire), '手动轨迹必须引用当前模块中已连接的线。');
    requireValid(!routes.has(key), '同一连线的手动轨迹重复。');
    requireValid(Number.isFinite(route.x) && Number.isFinite(route.y), '手动轨迹坐标必须是有限数值。');
    routes.add(key);
  }
  const frames = new Set<string>();
  for (const frame of project.layout?.topologyFrames ?? []) {
    const key = JSON.stringify(frame.modulePath);
    requireValid(definitionAtPath(frame.modulePath)?.kind === 'module', `模块边框必须引用模块：${key}`);
    requireValid(!frames.has(key), `模块边框重复：${key}`);
    requireValid(frame.width > 0 && frame.height > 0
      && [frame.x, frame.y, frame.x + frame.width, frame.y + frame.height].every(Number.isFinite), `模块边框坐标或尺寸无效：${key}`);
    frames.add(key);
  }
}
