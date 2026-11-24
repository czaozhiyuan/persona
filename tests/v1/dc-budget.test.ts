import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import { calculateDcBudget } from '../../src/engine/v1/dc-budget';
import type { EndpointRef, ModuleDefinition, PortDefinition, Project } from '../../src/model/v1/types';
import { planPortDeletion } from '../../src/state/v1/topology-edits';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const fixed = (value: number) => ({ kind: 'fixed' as const, value });
const dc = (id: string, direction: PortDefinition['direction']): PortDefinition => ({ id, type: 'DC_POWER', direction });
const rf = (direction: PortDefinition['direction']): PortDefinition => ({ id: 'RF', type: 'RF', direction });
const local = (instanceId: string, portId: string) => ({ instanceId, portId });
const ref = (instancePath: readonly string[], portId: string): EndpointRef => ({ instancePath, portId });
const instance = (id: string, definitionId = id) => ({ id, name: id, definitionId });

function fixture(): Project {
  return {
    id: 'dc-budget', name: 'DC budget', rootModuleDefinitionId: 'system',
    componentDefinitions: [
      { kind: 'component', id: 'source', name: 'Supply', ports: [{ ...dc('OUT', 'out'), outputVoltageV: fixed(10) }],
        dcSupply: { portId: 'OUT', capacity: { unit: 'A', value: fixed(0.7) } } },
      { kind: 'component', id: 'converter', name: 'DC/DC',
        ports: [{ ...dc('IN', 'in'), inputRating: { unit: 'W', max: 5 } }, { ...dc('OUT', 'out'), outputVoltageV: fixed(5) }],
        transfers: [{ kind: 'dc', fromPortId: 'IN', toPortId: 'OUT', efficiency: fixed(0.8),
          capacity: { unit: 'W', value: fixed(6) } }] },
      { kind: 'component', id: 'direct', name: 'Direct load',
        ports: [{ ...dc('IN', 'in'), inputRating: { unit: 'A', max: 0.2 } }, rf('out')],
        dcLoad: { portId: 'IN', powerW: fixed(3) } },
      { kind: 'component', id: 'load', name: 'Converted load', ports: [dc('IN', 'in'), rf('in')],
        parameters: [{ id: 'demand', name: 'Measured demand', kind: 'numeric', unit: 'W', valueKind: 'fixed',
          range: { min: 0 }, defaultValue: fixed(2), overridable: true }],
        dcLoad: { portId: 'IN', powerW: { kind: 'parameter', parameterId: 'demand' } } },
    ],
    moduleDefinitions: [
      { kind: 'module', id: 'system', name: 'System', ports: [], instances: [instance('A', 'rail'), instance('B', 'rail')] },
      { kind: 'module', id: 'rail', name: 'Rail', ports: [],
        instances: [instance('source'), instance('converter'), instance('direct'), instance('box')],
        connections: [
          { id: 'feed', from: local('source', 'OUT'), to: local('converter', 'IN') },
          { id: 'step-down', from: local('converter', 'OUT'), to: local('box', 'DC') },
          { id: 'direct', from: local('source', 'OUT'), to: local('direct', 'IN') },
          { id: 'signal', from: local('direct', 'RF'), to: local('box', 'RF') },
        ] },
      { kind: 'module', id: 'box', name: 'Load box',
        ports: [{ ...dc('DC', 'in'), inputRating: { unit: 'V', min: 4.5, max: 5.5 } }, rf('in')],
        instances: [{ ...instance('load'), parameterOverrides: { demand: fixed(4) } }],
        portMappings: [{ portId: 'DC', target: local('load', 'IN') }, { portId: 'RF', target: local('load', 'RF') }] },
    ],
    namedLinks: ['one', 'two'].map(id => ({
      id, name: id, from: ref(['A', 'direct'], 'RF'), to: ref(['A', 'box', 'load'], 'RF'),
    })),
  };
}

function changeRailA(project: Project, edit: (rail: ModuleDefinition) => ModuleDefinition): Project {
  const rail = project.moduleDefinitions.find(item => item.id === 'rail')!;
  return { ...project, moduleDefinitions: [
    ...project.moduleDefinitions.map(module => module.id === 'system' ? {
      ...module, instances: module.instances.map(item => item.id === 'A' ? { ...item, definitionId: 'fault' } : item),
    } : module),
    { ...edit(rail), id: 'fault' },
  ] };
}

function value(metric: BudgetMetric) {
  assert.equal(metric.availability, 'available');
  return metric.value;
}

function unavailableBecause(metric: BudgetMetric, reason: RegExp) {
  assert.equal(metric.availability, 'unavailable');
  assert.match(metric.reason, reason);
}

test('DC capacity, converted demand and ratings follow mapped ports without double counting loads', () => {
  const input = fixture();
  const project = parseProjectJson(serializeProjectJson(input));
  assert.deepEqual(project, input);
  const budget = calculateDcBudget(project);
  assert.deepEqual(budget, calculateDcBudget({ ...project, namedLinks: [] }));
  assert.deepEqual(budget.diagnostics, []);
  assert.equal(budget.loads.length, 4);
  assert.deepEqual(budget.loads.filter(load => load.endpoint.instancePath.length === 3)
    .map(load => [load.endpoint.instancePath[0], value(load.powerW)]), [['A', 4], ['B', 4]]);
  assert.deepEqual(budget.converters.map(converter => [value(converter.efficiency), value(converter.output.demandW),
    value(converter.inputDemandW), value(converter.output.voltageV)]), [[0.8, 4, 5, 5], [0.8, 4, 5, 5]]);
  assert.deepEqual(budget.supplies.map(supply => [value(supply.capacityW), value(supply.demandW), value(supply.marginW),
    supply.capacityStatus]), [[7, 8, -1, 'over_capacity'], [7, 8, -1, 'over_capacity']]);
  const direct = budget.ports.find(port => port.endpoint.instancePath.join('/') === 'A/direct')!;
  assert.equal(direct.rating?.status, 'above_max');
  assert.ok(direct.rating?.status === 'above_max' && Math.abs(direct.rating.excess - 0.1) < 1e-12);
  assert.equal(budget.ports.find(port => port.endpoint.instancePath.join('/') === 'A/box')?.rating?.status, 'within_range');
  assert.equal(budget.ports.find(port => port.endpoint.instancePath.join('/') === 'A/box/load')?.rating, undefined);
});

test('missing voltage keeps a W demand but makes A capacity and current ratings unavailable', () => {
  const project = fixture();
  const budget = calculateDcBudget({ ...project, componentDefinitions: project.componentDefinitions.map(component =>
    component.dcSupply ? { ...component, ports: component.ports.map(port => ({ ...port, outputVoltageV: undefined })) } : component) });
  const supply = budget.supplies[0];
  assert.equal(value(supply.demandW), 8);
  unavailableBecause(supply.capacityW, /需要相应的输出电压/);
  assert.equal(supply.capacityStatus, 'unknown');
  assert.equal(budget.ports.find(port => port.endpoint.instancePath.join('/') === 'A/direct')?.rating?.status, 'unknown');
  assert.ok(budget.diagnostics.some(item => item.code === 'missing_parameter' && item.endpoint.portId === 'OUT'));
});

test('unknown efficiency preserves downstream demand and the known direct demand subtotal', () => {
  const project = fixture();
  const budget = calculateDcBudget({ ...project, componentDefinitions: project.componentDefinitions.map(component => ({
    ...component, transfers: component.transfers?.map(transfer => transfer.kind === 'dc'
      ? { ...transfer, efficiency: undefined } : transfer),
  })) });
  assert.equal(value(budget.converters[0].output.demandW), 4);
  unavailableBecause(budget.converters[0].inputDemandW, /直流变换效率/);
  unavailableBecause(budget.supplies[0].demandW, /直流变换效率/);
  assert.equal(value(budget.supplies[0].knownDemandW), 3);
});

test('open, ambiguous and feedback branches retain the independent rail and known subtotals', () => {
  const project = fixture();
  const open = calculateDcBudget(changeRailA(project, rail => ({
    ...rail, connections: rail.connections?.filter(item => item.id !== 'feed'),
  })));
  assert.equal(value(open.supplies[0].demandW), 3);
  assert.ok(open.diagnostics.some(item => item.code === 'open_input' && item.endpoint.instancePath[0] === 'A'));
  assert.equal(value(open.supplies.at(-1)!.demandW), 8);

  const ambiguous = calculateDcBudget(changeRailA(project, rail => ({
    ...rail, instances: [...rail.instances, instance('extra', 'source')],
    connections: [...rail.connections!, { id: 'alternate', from: local('extra', 'OUT'), to: local('direct', 'IN') }],
  })));
  const a = ambiguous.supplies.find(supply => supply.endpoint.instancePath.join('/') === 'A/source')!;
  unavailableBecause(a.demandW, /供电分配不明确/);
  assert.equal(value(a.knownDemandW), 5);
  assert.ok(ambiguous.diagnostics.some(item => item.code === 'ambiguous_input' && item.endpoint.instancePath[1] === 'direct'));
  assert.equal(value(ambiguous.supplies.find(supply => supply.endpoint.instancePath[0] === 'B')!.demandW), 8);

  const cyclic = calculateDcBudget(changeRailA(project, rail => ({
    ...rail, connections: [...rail.connections!, { id: 'feedback', from: local('converter', 'OUT'), to: local('converter', 'IN') }],
  })));
  const cycleSupply = cyclic.supplies.find(supply => supply.endpoint.instancePath[0] === 'A')!;
  unavailableBecause(cycleSupply.demandW, /直流供电存在回路/);
  assert.equal(value(cycleSupply.knownDemandW), 3);
  assert.equal(value(cyclic.supplies.find(supply => supply.endpoint.instancePath[0] === 'B')!.demandW), 8);
  assert.ok(cyclic.diagnostics.some(item => item.code === 'feedback' && item.endpoint.instancePath[1] === 'converter'));
});

test('DC validation catches efficiency and unit errors, and port deletion clears the DC role', () => {
  const project = fixture();
  for (const efficiency of [0, 1.1]) {
    const invalid: Project = { ...project, componentDefinitions: project.componentDefinitions.map(component => ({
      ...component, transfers: component.transfers?.map(transfer => transfer.kind === 'dc'
        ? { ...transfer, efficiency: fixed(efficiency) } : transfer),
    })) };
    assert.throws(() => serializeProjectJson(invalid), /转换效率: 无效的供电参数值/);
  }
  const wrongUnit: Project = { ...project, componentDefinitions: project.componentDefinitions.map(component =>
    component.id !== 'load' ? component : { ...component,
      parameters: component.parameters?.map(parameter => parameter.kind === 'numeric' ? { ...parameter, unit: 'A' } : parameter),
    }) };
  assert.throws(() => serializeProjectJson(wrongUnit), /应引用单位为 W 的固定值参数/);
  const deletion = planPortDeletion(project, 'load', 'IN')!;
  assert.ok(deletion.impacts.some(impact => impact.kind === '直流负载'));
  assert.doesNotThrow(() => serializeProjectJson(deletion.project));
});

test('converter output parameters resolve per occurrence and drive downstream voltage ratings', () => {
  const project = fixture();
  const withReference: Project = {
    ...project,
    componentDefinitions: project.componentDefinitions.map(component => component.id !== 'converter' ? component : {
      ...component,
      parameters: [{ id: 'railV', name: 'Output', kind: 'numeric', unit: 'V', valueKind: 'fixed',
        range: { min: 0.1 }, defaultValue: fixed(5), overridable: true }],
      ports: component.ports.map(port => port.id !== 'OUT' ? port : {
        ...port, outputVoltageV: { kind: 'parameter', parameterId: 'railV' },
      }),
    }),
    instanceSettings: [{ instancePath: ['B', 'converter'], parameterOverrides: { railV: fixed(12) } }],
  };
  const budget = calculateDcBudget(parseProjectJson(serializeProjectJson(withReference)));
  assert.deepEqual(budget.converters.map(item => value(item.output.voltageV)), [5, 12]);
  assert.equal(budget.ports.find(port => port.endpoint.instancePath.join('/') === 'A/box')?.rating?.status, 'within_range');
  assert.equal(budget.ports.find(port => port.endpoint.instancePath.join('/') === 'B/box')?.rating?.status, 'above_max');
});

test('configured passive outputs need a real feed and cannot change a known upstream voltage', () => {
  const project = fixture();
  const withBoundary: Project = { ...project, moduleDefinitions: project.moduleDefinitions.map(module => module.id !== 'rail' ? module : {
    ...module, ports: [{ ...dc('TAP', 'out'), outputVoltageV: fixed(5) }],
    portMappings: [{ portId: 'TAP', target: local('converter', 'OUT') }],
  }) };
  const tap = (input: Project) => calculateDcBudget(input).ports.find(port => port.endpoint.portId === 'TAP')!;
  assert.equal(value(tap(withBoundary).voltageV), 5);
  const open = changeRailA(withBoundary, rail => ({ ...rail, portMappings: [] }));
  unavailableBecause(tap(open).voltageV, /没有可唯一确定的直流供电/);
  assert.equal(calculateDcBudget(open).supplies.length, 2);
  const conflict = changeRailA(withBoundary, rail => ({
    ...rail, ports: [{ ...dc('TAP', 'out'), outputVoltageV: fixed(12) }],
  }));
  unavailableBecause(tap(conflict).voltageV, /12 V.*5 V/);
  assert.ok(calculateDcBudget(conflict).diagnostics.some(item => item.code === 'voltage_conflict'));
});

test('output voltage declarations require a positive voltage on a power output', () => {
  const project = fixture();
  for (const [port, error] of [
    [{ ...dc('OUT', 'out'), outputVoltageV: fixed(0) }, /输出电压: 无效的供电参数值/],
    [{ ...dc('OUT', 'out'), outputVoltageV: fixed(-2) }, /输出电压: 无效的供电参数值/],
    [{ ...dc('OUT', 'out'), outputVoltageV: fixed(Infinity) }, /应为有限数值/],
    [{ ...dc('OUT', 'in'), outputVoltageV: fixed(5) }, /仅供电输出端口/],
    [{ ...rf('out'), outputVoltageV: fixed(5) }, /仅供电输出端口/],
    [{ ...dc('OUT', 'out'), outputVoltageV: { kind: 'parameter', parameterId: 'missing' } }, /应引用单位为 V 的固定值参数/],
  ] as const) {
    assert.throws(() => serializeProjectJson({
      ...project, componentDefinitions: [...project.componentDefinitions, { kind: 'component', id: '-extra', name: 'Extra', ports: [port] }],
    }), error);
  }
});

test('JSON rejects obsolete voltage fields rather than having two sources for one output port', () => {
  const file = JSON.parse(serializeProjectJson(fixture()));
  file.project.componentDefinitions[0].dcSupply.voltageV = fixed(12);
  assert.throws(() => parseProjectJson(JSON.stringify(file)), /dcSupply\.voltageV: 未知字段/);
  delete file.project.componentDefinitions[0].dcSupply.voltageV;
  file.project.componentDefinitions[1].transfers[0].outputVoltageV = fixed(12);
  assert.throws(() => parseProjectJson(JSON.stringify(file)), /transfers\[0\]\.outputVoltageV: 未知字段/);
});
