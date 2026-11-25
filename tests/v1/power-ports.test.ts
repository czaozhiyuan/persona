import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateDcBudget } from '../../src/engine/v1/dc-budget';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { groupModule } from '../../src/state/v1/group-module';
import { planDissolveModule } from '../../src/state/v1/dissolve-module';
import { connectBoundaryPort, exposeModulePort } from '../../src/state/v1/module-ports';
import { factory, factoryLibrary, libraryDefinitions, parseLibrary } from '../../src/library/v1/user-library';
import { portDisplayName } from '../../src/model/v1/display-names';
import type { ComponentDefinition, ModuleDefinition, PortDefinition, Project } from '../../src/model/v1/types';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const fixed = (value: number) => ({ kind: 'fixed' as const, value });
const slot = (id: string, definitionId = id) => ({ id, name: id, definitionId });
const root: ModuleDefinition = { kind: 'module', id: 'root', name: 'root', ports: [], instances: [] };
const base: Project = { id: 'test', name: 'Test', rootModuleDefinitionId: root.id, moduleDefinitions: [root], componentDefinitions: [] };

test('factory power inputs are explicit, optional and confined to the active templates', () => {
  const powered = ['rf-gain', 'rf-amplifier', 'laser', 'optical-source', 'dml', 'pcb', 'sfp', 'optical-switch', 'optical-amplifier', 'pd', 'mzm', 'rf-stage'];
  const found = [...factory.values()].filter(d => d.ports.some(p => p.id === 'DC_IN' && p.inputVoltageV)).map(d => d.id);
  assert.deepEqual(found.sort(), powered.map(id => 'library-' + id).sort());
  for (const id of found) {
    const def = factory.get(id)!;
    assert.deepEqual(def.ports.filter(p => p.type === 'DC_POWER'), [{ id: 'DC_IN', type: 'DC_POWER', direction: 'in', inputVoltageV: fixed(5) }]);
    if (def.kind === 'component') assert.equal(def.dcLoad, undefined);
  }
  const stage = factory.get('library-rf-stage') as ModuleDefinition;
  assert.deepEqual(stage.portMappings?.find(m => m.portId === 'DC_IN')?.target, { instanceId: 'amplifier', portId: 'DC_IN' });
  const gain = factory.get('library-rf-gain') as ComponentDefinition;
  const old = { ...gain, ports: gain.ports.filter(p => p.type !== 'DC_POWER') };
  const config = { ...factoryLibrary(), overrides: [old] };
  const saved = JSON.stringify(config);
  assert.equal(JSON.stringify(parseLibrary(saved)), saved);
  assert.equal(libraryDefinitions(config).find(d => d.id === gain.id), old);
  assert.deepEqual(factory.get('library-dc-converter')!.ports.map(p => p.type), ['DC_POWER', 'DC_POWER']);
  assert.deepEqual((factory.get('library-mzm') as ComponentDefinition).transfers?.map(t => t.kind), ['eo']);
});

test('labels resolve voltage at the selected occurrence, keep port IDs and ignore stored supply names', () => {
  const port: PortDefinition = { id: 'P', name: 'Old caption', type: 'DC_POWER', direction: 'in', inputVoltageV: { kind: 'parameter', parameterId: 'V' } };
  const device: ComponentDefinition = { kind: 'component', id: 'amp', name: 'Amp', ports: [port], parameters: [
    { id: 'V', kind: 'numeric', name: 'Rail', unit: 'V', valueKind: 'fixed', overridable: true, range: { min: 0.01 } },
  ] };
  const box: ModuleDefinition = { ...root, id: 'box', ports: [port], parameters: device.parameters, instances: [slot('amp')],
    portMappings: [{ portId: port.id, target: { instanceId: 'amp', portId: port.id } }],
    parameterMappings: [{ parameterId: 'V', target: { instanceId: 'amp', parameterId: 'V' } }] };
  const project = parseProjectJson(serializeProjectJson({ ...base, componentDefinitions: [device], moduleDefinitions: [
    { ...root, instances: [3.3, 12, undefined].map((v, i) => ({ ...slot(String(i), 'box'), parameterOverrides: v ? { V: fixed(v) } : undefined })) }, box,
  ] }));
  const tree = resolveHierarchy(project);
  for (const [i, label] of ['+3.3V IN', '+12V IN', 'DC ?V IN'].entries()) {
    for (const path of [[String(i)], [String(i), 'amp']]) {
      const item = tree.resolveInstance(path)!;
      assert.equal(portDisplayName(item.definition.ports[0], true, item.definition.ports, item), label);
    }
  }
  const exposed = exposeModulePort(project, [], { instanceId: '0', portId: 'P' }, '');
  function rootLabel(p: Project) {
    const item = resolveHierarchy(p).resolveInstance([])!;
    return portDisplayName(item.definition.ports[0], false, item.definition.ports, item);
  }
  assert.equal(exposed.moduleDefinitions[0].ports[0].inputVoltageV, undefined);
  assert.equal(rootLabel(exposed), '+3.3V IN');
  const nested = { ...exposed, moduleDefinitions: [exposed.moduleDefinitions[0], { ...box, ports: [{ ...port, inputVoltageV: undefined }] }] };
  assert.equal(rootLabel(nested), '+3.3V IN');
  const outer = nested.moduleDefinitions[0];
  const explicit = { ...nested, moduleDefinitions: [{ ...outer, parameters: device.parameters, ports: [port] }, nested.moduleDefinitions[1]] };
  assert.equal(rootLabel(explicit), 'DC ?V IN');
  assert.equal(rootLabel(connectBoundaryPort(exposed, 'root', 'P', { instanceId: '1', portId: 'P' })), '+12V IN');
  assert.equal(rootLabel(connectBoundaryPort(exposed, 'root', 'P', { instanceId: '2', portId: 'P' })), 'DC ?V IN');
  assert.equal(rootLabel(connectBoundaryPort(exposed, 'root', 'P')), 'DC ?V IN');
  const ac: PortDefinition = { id: 'A', name: 'Old AC name', type: 'AC_POWER', direction: 'out', outputVoltageV: fixed(110) };
  const ports = [ac, { ...ac, id: 'B' }];
  assert.deepEqual(ports.map(p => portDisplayName(p, true, ports)), ['110V~ OUT（1）', '110V~ OUT（2）']);
  assert.equal(portDisplayName({ ...ac, direction: 'in', inputVoltageV: fixed(220) }), '220V~ IN');
  assert.equal(portDisplayName({ ...ac, outputVoltageV: undefined }), 'AC ?V OUT');
  assert.equal(portDisplayName({ id: 'RF_IN', name: '驱动', type: 'RF', direction: 'in' }), '驱动');
});

test('grouped fixed supply output follows internal edits, while an explicit boundary still constrains the route', () => {
  const source: ComponentDefinition = { kind: 'component', id: 'source', name: 'Source',
    ports: [{ id: 'V', type: 'DC_POWER', direction: 'out', outputVoltageV: fixed(5) }], dcSupply: true };
  const load: ComponentDefinition = { kind: 'component', id: 'load', name: 'Load',
    ports: [{ id: 'IN', type: 'DC_POWER', direction: 'in' }], dcLoad: { portId: 'IN', powerW: fixed(1) } };
  const project: Project = { ...base, componentDefinitions: [source, load, { kind: 'component', id: 'aux', name: 'Aux', ports: [] }],
    moduleDefinitions: [{ ...root, instances: [slot('source'), slot('aux'), slot('load')],
      connections: [{ id: 'wire', from: { instanceId: 'source', portId: 'V' }, to: { instanceId: 'load', portId: 'IN' } }] }] };
  const grouped = parseProjectJson(serializeProjectJson(groupModule(project, [['source'], ['aux']], 'Grouped', 'g', 'group')));
  const [parent, group] = grouped.moduleDefinitions;
  assert.deepEqual(group.ports, [{ id: 'V', type: 'DC_POWER', direction: 'out' }]);
  assert.ok(planDissolveModule(grouped, ['g']).ok);
  const changed = { ...grouped, componentDefinitions: [{ ...source, ports: [{ ...source.ports[0], outputVoltageV: fixed(12) }] },
    ...grouped.componentDefinitions.slice(1)] };
  const item = resolveHierarchy(changed).resolveInstance(['g'])!;
  assert.equal(portDisplayName(item.definition.ports[0], false, item.definition.ports, item), '+12V OUT');
  const budget = calculateDcBudget(changed);
  const twelveVolts = { unit: 'V', availability: 'available', value: 12 };
  assert.deepEqual(budget.ports.find(p => p.endpoint.portId === 'IN')?.voltageV, twelveVolts);
  assert.deepEqual(budget.supplies[0].demandW, { unit: 'W', availability: 'available', value: 1 });
  const direct = planDissolveModule(changed, ['g']);
  assert.ok(direct.ok);
  assert.deepEqual(calculateDcBudget(direct.project).ports.find(p => p.endpoint.portId === 'IN')?.voltageV, twelveVolts);
  const explicit = { ...changed, moduleDefinitions: [parent, { ...group, ports: [{ ...group.ports[0], outputVoltageV: fixed(5) }] }] };
  assert.ok(calculateDcBudget(explicit).diagnostics.some(d => d.code === 'voltage_conflict'));
  assert.equal(planDissolveModule(explicit, ['g']).ok, false);
});

test('AC wiring stays outside DC calculations and nominal inputs are neither limits nor supplies', () => {
  const ac: PortDefinition = { id: 'AC', type: 'AC_POWER', direction: 'out', outputVoltageV: fixed(220) };
  const outlet: ComponentDefinition = { kind: 'component', id: 'wall', name: 'Wall', ports: [ac] };
  const template = factory.get('library-dc-supply') as ComponentDefinition;
  const supply = { ...template, ports: template.ports.map(p => p.id === 'DC_OUT' ? { ...p, outputVoltageV: fixed(12),
    supplyCapacity: { unit: 'W' as const, value: fixed(8) } } : p) };
  const amp = factory.get('library-rf-amplifier') as ComponentDefinition;
  const acWire = { id: 'mains', from: { instanceId: 'wall', portId: 'AC' }, to: { instanceId: 'source', portId: 'AC_IN' } };
  const dcWire = { id: 'rail', from: { instanceId: 'source', portId: 'DC_OUT' }, to: { instanceId: 'load', portId: 'DC_IN' } };
  const system = { ...root, instances: [slot('wall'), slot('source', supply.id), slot('load', amp.id)] };
  const project = { ...base, componentDefinitions: [outlet, supply, amp] };
  const setup = (connections: typeof acWire[]): Project => ({ ...project, moduleDefinitions: [{ ...system, connections }] });
  const budget = calculateDcBudget(setup([acWire, dcWire]));
  assert.deepEqual(budget, calculateDcBudget(setup([dcWire])));
  assert.deepEqual(budget.supplies[0].voltageV, { availability: 'available', unit: 'V', value: 12 });
  assert.equal(budget.supplies[0].demandW.availability, 'unavailable');
  const load = budget.ports.find(p => p.endpoint.portId === 'DC_IN')!;
  assert.deepEqual(load.voltageV, budget.supplies[0].voltageV);
  assert.equal(load.rating, undefined);
  const unplugged = calculateDcBudget(setup([])).ports.find(p => p.endpoint.portId === 'DC_IN')!;
  assert.equal(unplugged.voltageV.availability, 'unavailable');
  assert.equal(unplugged.demandW.availability, 'unavailable');
  assert.throws(() => serializeProjectJson(setup([{ ...acWire, to: dcWire.to }])), /端口类型不匹配/);
  const mapped = (type: PortDefinition['type']) => ({ ...project, moduleDefinitions: [
    { ...system, ports: [{ ...ac, type }], portMappings: [{ portId: ac.id, target: acWire.from }] },
  ] });
  const encoded = serializeProjectJson(mapped('AC_POWER'));
  assert.equal(serializeProjectJson(parseProjectJson(encoded)), encoded);
  assert.throws(() => serializeProjectJson(mapped('DC_POWER')), /保持端口类型和方向一致/);
  for (const invalid of [{ ...ac, inputVoltageV: fixed(220) }, { ...ac, outputVoltageV: fixed(-110) },
    { ...ac, type: 'CONTROL' as const }, { ...ac, direction: 'in' as const, inputVoltageV: fixed(0), outputVoltageV: undefined }]) {
    assert.throws(() => serializeProjectJson({ ...base, componentDefinitions: [{ ...outlet, ports: [invalid] }] }), /电压/);
  }
});
