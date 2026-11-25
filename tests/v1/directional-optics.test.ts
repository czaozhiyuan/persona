import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import { createOpticalBudget } from '../../src/engine/v1/optical-budget';
import { createPathResolver } from '../../src/engine/v1/path-resolver';
import { builtInDefinitions } from '../../src/library/v1/built-in';
import { factoryLibrary, parseLibrary, saveDefinition } from '../../src/library/v1/user-library';
import type { ComponentDefinition, Project } from '../../src/model/v1/types';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
import { duplexFixture } from './fixtures/bidirectional-optics';

const device = (id: string) => builtInDefinitions.find(d => d.id === 'library-' + id)! as ComponentDefinition;
const slot = (id: string, definitionId: string) => ({ id, definitionId, name: id });
const local = (instanceId: string, portId: string) => ({ instanceId, portId });
const endpoint = (id: string, portId: string) => ({ instancePath: [id], portId });
const fixed = (value: number) => ({ kind: 'fixed', value } as const);
const wire = (id: string, from: string, out: string, to: string, input: string) =>
  ({ id, from: local(from, out), to: local(to, input) });
function close(metric: BudgetMetric, expected: number) {
  assert.equal(metric.availability, 'available');
  assert.ok(metric.value === expected || Math.abs(metric.value - expected) < 1e-9, `${metric.value} != ${expected}`);
}

function bench(id: string, input: string, output: string, overrides: Record<string, ReturnType<typeof fixed>> = {}) {
  const part = device(id);
  return { id: 'bench', name: 'Bench', rootModuleDefinitionId: 'root',
    componentDefinitions: [device('laser'), part, device('pd')],
    moduleDefinitions: [{ id: 'root', kind: 'module', name: 'Root', ports: [],
      instances: [slot('src', 'library-laser'), slot('dut', part.id), slot('det', 'library-pd')],
      connections: [wire('launch', 'src', 'OPT_OUT', 'dut', input), wire('receive', 'dut', output, 'det', 'OPT_IN')] }],
    instanceSettings: [{ instancePath: ['dut'], parameterOverrides: overrides }],
  } satisfies Project;
}

test('factory optical devices preserve their exact routes, common parameters, icons and optional power input', () => {
  const cases = [
    ['optical-amplifier', ['OPT_IN>OPT_OUT'], 5], ['isolator', ['OPT_IN>OPT_OUT'], -1],
    ['circulator', ['P1>P2', 'P2>P3'], -1], ['optical-attenuator', ['OPT_IN>OPT_OUT', 'OPT_OUT>OPT_IN'], -3],
    ['splitter', ['OPT_IN>OPT_OUT_1', 'OPT_IN>OPT_OUT_2', 'OPT_OUT_1>OPT_IN', 'OPT_OUT_2>OPT_IN'], 10 * Math.log10(0.5)],
  ] as const;
  const icons = new Set();
  for (const [id, routes, gain] of cases) {
    const template = device(id);
    icons.add(template.iconKey);
    const config = saveDefinition(factoryLibrary(), template);
    assert.equal(JSON.stringify(parseLibrary(JSON.stringify(config))), JSON.stringify(config));
    for (const route of routes) {
      const [from, to] = route.split('>');
      const p = parseProjectJson(serializeProjectJson(bench(id, from, to)));
      const resolver = createPathResolver(p);
      assert.deepEqual(resolver.graph.edges.filter(e => e.source.kind === 'transfer' && e.from.ref.instancePath[0] === 'dut')
        .map(e => e.from.ref.portId + '>' + e.to.ref.portId).sort(), [...routes].sort());
      for (const channelId of ['CWDM_1311', 'CWDM_1391'] as const) {
        const query = { source: { endpoint: endpoint('src','OPT_OUT'), channelId, powerDbm: 0 }, to: endpoint('det','OPT_IN') };
        close(createOpticalBudget(p).calculateLocal(query).powerDbm, gain);
      }
    }
  }
  assert.equal(icons.size, 5);
  assert.deepEqual(device('optical-amplifier').ports.find(p => p.id === 'DC_IN')?.inputVoltageV, fixed(5));
  assert.equal(device('optical-amplifier').dcLoad, undefined);
  assert.equal(device('circulator').ports[1].side, 'top');
});

test('the split ratio follows the physical branch in either direction including exact dark channels', () => {
  for (const ratio of [0, 50, 99, 100]) {
    for (const index of [1, 2]) {
      const branch = 'OPT_OUT_' + index, share = (index === 1 ? ratio : 100 - ratio) / 100;
      for (const [from, to] of [['OPT_IN', branch], [branch, 'OPT_IN']]) {
        const project = bench('splitter', from, to, { firstPercent: fixed(ratio), loss: fixed(2) });
        const query = { source: { endpoint: endpoint('src','OPT_OUT'), channelId: 'CWDM_1351' as const, powerDbm: 0 }, to: endpoint('det','OPT_IN') };
        close(createOpticalBudget(project).calculateLocal(query).powerDbm, 10 * Math.log10(share) - 2);
      }
    }
  }
  const isolated = bench('splitter', 'OPT_OUT_1', 'OPT_OUT_2');
  const query = { source: { endpoint: endpoint('src','OPT_OUT'), powerDbm: 0 }, to: endpoint('det','OPT_IN') };
  assert.equal(createOpticalBudget(isolated).calculateLocal(query).pathIssue?.status, 'unreachable');
  const detached = { ...isolated, moduleDefinitions: isolated.moduleDefinitions.map(m => ({ ...m, connections: [] })) };
  assert.equal(createOpticalBudget(detached).calculateLocal(query).pathIssue?.status, 'unreachable');
});

test('two circulators route two colours through independent one-way amplifiers inside a module', () => {
  const base = duplexFixture(), [root, ...boxes] = base.moduleDefinitions;
  const amplifier = device('optical-amplifier'), circulator = device('circulator');
  const project: Project = { ...base, componentDefinitions: [...base.componentDefinitions, amplifier, circulator],
    moduleDefinitions: [{ ...root, instances: [...root.instances, slot('pair', 'pair')], cableBundles: [],
      connections: [wire('left','A','COM','pair','L'), wire('right','pair','R','B','COM')] }, ...boxes,
      { kind: 'module', id: 'pair', name: '双向放大模块',
        ports: ['L', 'R'].map(id => ({ id, type: 'OPTICAL', direction: 'bidirectional' })),
        portMappings: [{ portId: 'L', target: local('left','P2') }, { portId: 'R', target: local('right','P2') }],
        instances: [slot('left',circulator.id), slot('right',circulator.id), slot('forward',amplifier.id), slot('reverse',amplifier.id)],
        connections: [wire('f-in','left','P3','forward','OPT_IN'), wire('f-out','forward','OPT_OUT','right','P1'),
          wire('r-in','right','P3','reverse','OPT_IN'), wire('r-out','reverse','OPT_OUT','left','P1')] }],
    namedLinks: base.namedLinks!.map(link => ({ ...link, via: [] })),
    instanceSettings: [{ instancePath: ['pair','reverse'], parameterOverrides: { gain: fixed(8) } }],
  };
  const saved = parseProjectJson(serializeProjectJson(project)), resolver = createPathResolver(saved);
  for (const [index, link] of saved.namedLinks!.entries()) {
    const path = resolver.resolveNamedLink(link);
    assert.equal(path.status, 'resolved');
    const internal = path.trace.edges.filter(e => e.from.ref.instancePath[0] === 'pair' && e.source.kind === 'transfer');
    assert.deepEqual(internal.map(e => e.from.ref.instancePath[1]), index ? ['right','reverse','left'] : ['left','forward','right']);
    close(createOpticalBudget(saved).calculateSourcePath(path.trace).powerDbm, index ? 13 : 10);
  }
});

test('a splitter can merge distinct return wavelengths but reports same-channel sources and reconvergence', () => {
  const base = bench('splitter', 'OPT_OUT_1', 'OPT_IN');
  const laser = device('laser');
  const source = (id: string, channel: 'CWDM_1311' | 'CWDM_1391'): ComponentDefinition => ({ ...laser, id,
    ports: laser.ports.map(p => p.opticalEmitter ? { ...p, channelIds: [channel], opticalEmitter: { powerDbm: fixed(0) } } : p) });
  const returned = (conflict: boolean): Project => ({ ...base,
    componentDefinitions: [source(laser.id,'CWDM_1311'), source('second',conflict ? 'CWDM_1311' : 'CWDM_1391'), device('splitter'), device('pd')],
    moduleDefinitions: base.moduleDefinitions.map(m => ({ ...m, instances: [...m.instances, slot('second','second')],
      connections: [...m.connections, wire('second','second','OPT_OUT','dut','OPT_OUT_2')] })) });
  const query = (id: string, channelId: 'CWDM_1311' | 'CWDM_1391') => ({
    source: { endpoint: endpoint(id, 'OPT_OUT'), channelId }, to: endpoint('det', 'OPT_IN') });
  const allowed = createOpticalBudget(returned(false));
  close(allowed.calculateLocal(query('src','CWDM_1311')).powerDbm, -10 * Math.log10(2));
  close(allowed.calculateLocal(query('second','CWDM_1391')).powerDbm, -10 * Math.log10(2));
  close(allowed.calculateLocal({ source: { endpoint: endpoint('src','OPT_OUT') }, to: endpoint('det','OPT_IN') }).powerDbm, -10 * Math.log10(2));
  const duplicate = createOpticalBudget(returned(true)).calculateLocal(query('src','CWDM_1311'));
  assert.equal(duplicate.powerDbm.availability, 'unavailable');
  assert.match(duplicate.powerDbm.reason, /同.*波长|同.*通道/);
  const rejoin: Project = { ...base, moduleDefinitions: base.moduleDefinitions.map(m => ({ ...m,
    instances: [...m.instances, slot('divider','library-splitter')],
    connections: [wire('launch','src','OPT_OUT','divider','OPT_IN'),
      wire('branch1','divider','OPT_OUT_1','dut','OPT_OUT_1'), wire('branch2','divider','OPT_OUT_2','dut','OPT_OUT_2'),
      wire('receive','dut','OPT_IN','det','OPT_IN')] })) };
  assert.equal(createOpticalBudget(rejoin).calculateLocal(query('src','CWDM_1311')).pathIssue?.status, 'ambiguous');
});
