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
const wire = (a: string, b: string) => ({ id: a + '-' + b, from: local(a, 'p'), to: local(b, 'p') });

function powerBus(type: 'AC_POWER' | 'DC_POWER', sources: { voltage?: number; watts?: number; amps?: number }[],
  loads: (number | undefined)[], pairs: string[][]): Project {
  const componentDefinitions: Project['componentDefinitions'] = [
    ...sources.map(({ voltage, watts, amps }, i) => ({ kind: 'component' as const, id: 's' + i, name: 'Source ' + i,
      dcSupply: type === 'DC_POWER', ports: [{ id: 'p', type, direction: 'out' as const, outputVoltageV: voltage === undefined ? undefined : fixed(voltage),
        supplyCapacity: amps !== undefined ? { unit: 'A' as const, value: fixed(amps) }
          : watts !== undefined ? { unit: 'W' as const, value: fixed(watts) } : undefined }] })),
    ...loads.map((watts, i) => ({ kind: 'component' as const, id: 'l' + i, name: 'Load ' + i,
      ports: [{ id: 'p', type, direction: 'in' as const, acLoadW: type === 'AC_POWER' && watts !== undefined ? fixed(watts) : undefined }],
      dcLoad: type === 'DC_POWER' ? { portId: 'p', powerW: watts === undefined ? undefined : fixed(watts) } : undefined })),
  ];
  return { id: 'bus', name: 'Bus', rootModuleDefinitionId: 'root', componentDefinitions, moduleDefinitions: [{
    kind: 'module', id: 'root', name: 'Root', ports: [], instances: componentDefinitions.map(d => instance(d.id)),
    connections: pairs.map(([a,b]) => wire(a,b)),
  }] };
}

function fixture(): Project {
  return {
    id: 'dc-budget', name: 'DC budget', rootModuleDefinitionId: 'system',
    componentDefinitions: [
      { kind: 'component', id: 'source', name: 'Supply', ports: [{ ...dc('OUT', 'out'), outputVoltageV: fixed(10), supplyCapacity: { unit: 'A', value: fixed(0.7) } }],
        dcSupply: true },
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

test('star, daisy chain and mesh count only electrically attached sources and loads once', () => {
  const star = [['s0','l0'], ['s0','l1'], ['l2','s0']], chain = [['s0','l0'], ['l0','l1'], ['l2','l1']];
  const mesh = [...chain, ['l2','s0']];
  const sources = [{ voltage: 5, watts: 10 }, { voltage: 5, amps: 3 }, { voltage: 5, watts: 5 }];
  function expectNet(count: number, pairs: string[][], expected: number[]) {
    const project = powerBus('DC_POWER', sources.slice(0,count), [1,2,3], pairs);
    const budget = calculateDcBudget(parseProjectJson(serializeProjectJson(project)));
    const net = budget.networks.find(n => n.ports.some(p => p.instancePath[0] === 's0'))!;
    assert.deepEqual([value(net.voltageV), value(net.capacityW), value(net.demandW), value(net.marginW)], expected);
    assert.equal(net.capacityStatus, 'within_capacity');
    assert.ok(!budget.diagnostics.some(d => d.code === 'feedback'));
  }
  for (const edges of [star, chain, mesh]) expectNet(1, edges, [5,10,6,4]);
  expectNet(1, chain.slice(0,2), [5,10,3,7]);
  expectNet(2, [...mesh, ['s1','s0']], [5,25,6,19]);
  expectNet(3, [...mesh, ['s1','s0'], ['l1','s2']], [5,30,6,24]);
  expectNet(3, [...mesh, ['l1','s2']], [5,15,6,9]);
});

test('AC and DC preserve voltage conflicts, partial capacities and undocumented loads', () => {
  const edges = [['s1','s0'], ['l0','s0'], ['l1','l0']];
  for (const type of ['DC_POWER', 'AC_POWER'] as const) {
    const voltage = type === 'DC_POWER' ? 5 : 220;
    const sources = [{ voltage, watts: 10 }, { voltage, watts: 15 }];
    const budget = (s: Parameters<typeof powerBus>[1], loads: (number | undefined)[]) =>
      calculateDcBudget(powerBus(type, s, loads, edges));
    const same = budget(sources, [1,5]);
    assert.equal(same.networks.length, 1);
    assert.deepEqual([value(same.networks[0].capacityW), value(same.networks[0].demandW), value(same.networks[0].marginW)], [25,6,19]);
    assert.deepEqual(same.diagnostics, []);
    const clash = budget([sources[0], { voltage: type === 'DC_POWER' ? 12 : 110, watts: 15 }], [1,5]);
    assert.equal(value(clash.networks[0].capacityW), 25);
    unavailableBecause(clash.networks[0].voltageV, /不一致/);
    assert.equal(clash.networks[0].capacityStatus, 'unknown');
    assert.ok(clash.diagnostics.some(d => d.code === 'voltage_conflict'));
    const partial = budget([sources[0], { voltage }], [1,undefined]).networks[0];
    assert.equal(value(partial.knownCapacityW), 10);
    assert.equal(value(partial.knownDemandW), 1);
    assert.equal(partial.capacityW.availability, 'unavailable');
    assert.equal(partial.demandW.availability, 'unavailable');
    assert.equal(partial.capacityStatus, 'unknown');
    const overload = budget(sources, [25,1]).networks[0];
    assert.equal(value(overload.marginW), -1);
    assert.equal(overload.capacityStatus, 'over_capacity');
  }
});

test('a parallel source retains its own ampere nameplate rating when the common voltage is undetermined', () => {
  function budget(voltage?: number) {
    const project = powerBus('DC_POWER', [{ voltage: 5, amps: 2 }, { voltage, amps: 1 }], [1], [['s0', 's1'], ['s0', 'l0']]);
    return calculateDcBudget(parseProjectJson(serializeProjectJson(project)));
  }
  const partial = budget(), missing = partial.networks[0];
  assert.equal(value(partial.supplies[0].capacityW), 10);
  assert.equal(partial.supplies[1].capacityW.availability, 'unavailable');
  assert.equal(value(missing.knownCapacityW), 10);
  assert.equal(missing.capacityW.availability, 'unavailable');
  assert.equal(missing.voltageV.availability, 'unavailable');
  assert.equal(missing.marginW.availability, 'unavailable');
  assert.equal(missing.capacityStatus, 'unknown');

  const same = budget(5).networks[0];
  assert.deepEqual([value(same.voltageV), value(same.knownCapacityW), value(same.capacityW), value(same.marginW)], [5, 15, 15, 14]);
  assert.equal(same.capacityStatus, 'within_capacity');

  const conflict = budget(12), net = conflict.networks[0];
  assert.deepEqual(conflict.supplies.map(source => value(source.capacityW)), [10, 12]);
  assert.equal(value(net.knownCapacityW), 22);
  unavailableBecause(net.voltageV, /不一致/);
  assert.equal(net.marginW.availability, 'unavailable');
  assert.equal(net.capacityStatus, 'unknown');
});

test('parallel converters retain the output budget and reflect a common input demand only when it is determined', () => {
  const base = fixture();
  const rail = base.moduleDefinitions.find(d => d.id === 'rail')!;
  const parallel = (separate: boolean) => changeRailA(base, m => ({ ...m,
    instances: [...m.instances, instance('second','converter'), ...(separate ? [instance('independent','source')] : [])],
    connections: [...rail.connections!,
      { id: 'in2', from: local(separate ? 'independent' : 'source','OUT'), to: local('second','IN') },
      { id: 'out2', from: local('second','OUT'), to: local('converter','OUT') }] }));
  for (const separate of [false, true]) {
    const result = calculateDcBudget(parallel(separate));
    const outputNet = result.networks.find(n => n.sources.length === 2)!;
    assert.deepEqual([value(outputNet.capacityW), value(outputNet.demandW), value(outputNet.marginW)], [12,4,8]);
    const inputNet = result.networks.find(n => n.endpoint.instancePath.join('/') === 'A/source')!;
    if (separate) {
      unavailableBecause(inputNet.demandW, /单路分担/);
      assert.equal(value(inputNet.knownDemandW), 3);
    } else assert.equal(value(inputNet.demandW), 8);
    for (const c of result.converters.filter(c => c.input.instancePath[0] === 'A')) unavailableBecause(c.inputDemandW, /单路分担/);
  }
});

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

test('an unpowered converter cannot contribute capacity or absorb load from a powered parallel rail', () => {
  const bus = powerBus('DC_POWER', [{ voltage: 5, watts: 10 }, { voltage: 5, watts: 15 }], [1, 2, 3],
    [['s0', 's1'], ['s1', 'l0'], ['l0', 'l1'], ['l1', 'l2']]);
  const converter = fixture().componentDefinitions.find(d => d.id === 'converter')!;
  const m = bus.moduleDefinitions[0];
  const result = calculateDcBudget({ ...bus, componentDefinitions: [...bus.componentDefinitions, converter], moduleDefinitions: [
    { ...m, instances: [...m.instances, instance('idle', converter.id)],
      connections: [...m.connections!, { id: 'idle', from: local('idle', 'OUT'), to: local('s0', 'p') }] },
  ] });
  const powered = result.networks.find(n => n.sources.length)!;
  assert.equal(powered.sources.length, 2);
  assert.deepEqual([value(powered.capacityW), value(powered.demandW), value(powered.marginW)], [25, 6, 19]);
  assert.equal(value(result.converters[0].inputDemandW), 0);
  assert.ok(result.diagnostics.some(d => d.code === 'open_input' && d.endpoint.instancePath[0] === 'idle'));
});

test('converter feedback also invalidates the indirect upstream demand while retaining its known physical loads', () => {
  const p = changeRailA(fixture(), m => ({ ...m,
    instances: [...m.instances, instance('middle', 'converter'), instance('last', 'converter')],
    connections: [...m.connections!, { id: 'next', from: local('converter', 'OUT'), to: local('middle', 'IN') },
      { id: 'chain', from: local('middle', 'OUT'), to: local('last', 'IN') },
      { id: 'loop', from: local('last', 'OUT'), to: local('last', 'IN') }] }));
  const result = calculateDcBudget(p);
  const source = result.supplies.find(s => s.endpoint.instancePath.join('/') === 'A/source')!;
  unavailableBecause(source.demandW, /回路/);
  assert.equal(value(source.knownDemandW), 8);
  assert.equal(value(result.supplies.find(s => s.endpoint.instancePath[0] === 'B')!.demandW), 8);
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

test('open feeds, parallel supplies and converter feedback retain the independent rail and known subtotals', () => {
  const project = fixture();
  const open = calculateDcBudget(changeRailA(project, rail => ({
    ...rail, connections: rail.connections?.filter(item => item.id !== 'feed'),
  })));
  assert.equal(value(open.supplies[0].demandW), 3);
  assert.ok(open.diagnostics.some(item => item.code === 'open_input' && item.endpoint.instancePath[0] === 'A'));
  assert.equal(value(open.supplies.at(-1)!.demandW), 8);

  const parallel = calculateDcBudget(changeRailA(project, rail => ({
    ...rail, instances: [...rail.instances, instance('extra', 'source')],
    connections: [...rail.connections!, { id: 'alternate', from: local('extra', 'OUT'), to: local('direct', 'IN') }],
  })));
  const shared = parallel.networks.find(n => n.sources.length === 2)!;
  assert.deepEqual([value(shared.capacityW), value(shared.demandW), value(shared.marginW)], [14, 8, 6]);
  unavailableBecause(parallel.supplies.find(s => s.endpoint.instancePath.join('/') === 'A/source')!.demandW, /单个电源/);
  assert.deepEqual(parallel.diagnostics, []);
  assert.equal(value(parallel.supplies.find(supply => supply.endpoint.instancePath[0] === 'B')!.demandW), 8);

  const cyclic = calculateDcBudget(changeRailA(project, rail => ({
    ...rail, connections: [...rail.connections!, { id: 'feedback', from: local('converter', 'OUT'), to: local('converter', 'IN') }],
  })));
  const cycleNet = cyclic.networks.find(n => n.endpoint.instancePath[0] === 'A')!;
  unavailableBecause(cycleNet.demandW, /直流供电存在回路/);
  assert.equal(value(cycleNet.knownDemandW), 7);
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
  unavailableBecause(tap(open).voltageV, /尚未接入电源/);
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
  file.project.componentDefinitions[0].dcSupply = { portId: 'OUT', voltageV: fixed(12) };
  assert.throws(() => parseProjectJson(JSON.stringify(file)), /旧单路电源结构/);
  file.project.componentDefinitions[0].dcSupply = true;
  file.project.componentDefinitions[1].transfers[0].outputVoltageV = fixed(12);
  assert.throws(() => parseProjectJson(JSON.stringify(file)), /transfers\[0\]\.outputVoltageV: 未知字段/);
});
