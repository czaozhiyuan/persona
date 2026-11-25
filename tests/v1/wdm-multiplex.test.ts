import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import { createMultiplexPower } from '../../src/engine/v1/multiplex-power';
import { createOpticalBudget, createOpticalBudgetForGraph } from '../../src/engine/v1/optical-budget';
import { createPathResolver } from '../../src/engine/v1/path-resolver';
import type { ComponentDefinition } from '../../src/model/v1/types';
import { wireRouteKey } from '../../src/model/v1/wire-route';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
import { portPowerLines, totalText } from '../../src/workbench/v1/budgets/multiplex-details';
import { endpoint, fixed, local, wdmProject } from './fixtures/wdm-project';

function numeric(metric: BudgetMetric) {
  assert.equal(metric.availability, 'available');
  return metric.value;
}
function near(metric: BudgetMetric, value: number) { assert.ok(Math.abs(numeric(metric) - value) < 1e-9); }

test('two nested WDMs multiplex four separate waves over one lossy fibre or MPO core', () => {
  for (const mpo of [false, true]) {
    const p = wdmProject();
    if (mpo) {
      const root = p.moduleDefinitions[0];
      root.connections = [];
      root.cableBundles = [{ id: 'MPO', coreCount: 12, cores: [{ id: 'core1', lossDb: 2,
        a: { pin: 1, endpoint: local('A', 'COM') }, b: { pin: 12, endpoint: local('B', 'COM') } }] }];
    }
    const restored = parseProjectJson(serializeProjectJson(p));
    const resolver = createPathResolver(restored), optical = createOpticalBudgetForGraph(resolver.graph);
    const multiplex = createMultiplexPower(resolver.graph);
    const key = wireRouteKey([], mpo ? { kind: 'core', id: 'core1', bundleId: 'MPO' } : { kind: 'connection', id: 'fibre' });
    const directions = multiplex.wire(key)!;
    assert.equal(directions.length, 2);
    for (const d of directions) {
      assert.equal(d.lossDb, 2);
      near(d.start.known, 2.010299956639812);
      near(d.arrival.known, .010299956639812);
      assert.equal(d.waves.length, 2);
      assert.ok(d.waves.every(w => numeric(w.power) === -1 && numeric(w.arrival) === -3));
    }
    for (const box of ['A', 'B']) {
      const mapping = multiplex.wire(wireRouteKey([box], { kind: 'mapping', id: 'COM' }))!;
      assert.deepEqual(mapping.map(d => [d.fromFlow, d.toFlow, d.from.instancePath, d.to.instancePath]),
        [['in', 'in', [box], [box, 'wdm']], ['out', 'out', [box, 'wdm'], [box]]]);
      for (const ref of [endpoint(box, 'wdm', 'COM'), {instancePath: [box], portId: 'COM'}]) {
        const point = multiplex.at(ref)!;
        near(point.out.known, 2.010299956639812);
        near(point.in.known, .010299956639812);
        assert.equal(point.waves.length, 4);
        assert.ok(point.waves.every(w => numeric(w.power) === (w.flow === 'out' ? -1 : -3)));
      }
    }
    for (const link of restored.namedLinks!) {
      const path = resolver.resolveNamedLink(link);
      assert.equal(path.status, 'resolved');
      const point = optical.calculateSourcePath(path.trace);
      near(point.powerDbm, -4);
      assert.deepEqual(point.stages.filter(s => s.endpoint.portId === 'COM').map(s => numeric(s.powerDbm)), [-1, -1, -3, -3]);
    }
    assert.equal(multiplex.at(endpoint('A', 'wdm', 'CH1')), undefined);
  }
});

test('same-wave counterpropagation retains its source, power and port side after reversing stored wire ends', () => {
  const p = wdmProject(), [root, a] = p.moduleDefinitions;
  p.namedLinks = [];
  root.instances = root.instances.map(i => ({ ...i, definitionId: 'A' }));
  a.connections = a.connections!.filter(c => c.id !== 'branch1');
  const trials = ['A', 'B'].map((box, i) => ({ endpoint: endpoint(box, 'wave0', 'OPT_OUT'), channelId: 'CWDM_1311' as const, powerDbm: i ? 10 : 13 }));
  const fibre = root.connections![0];
  for (const reverse of [false, true]) {
    root.connections = [{ ...fibre, from: reverse ? fibre.to : fibre.from, to: reverse ? fibre.from : fibre.to, lossDb: 0 }];
    const mux = createMultiplexPower(createPathResolver(p).graph, trials);
    const wire = mux.wire(wireRouteKey([], { kind: 'connection', id: fibre.id }))!;
    assert.equal(wire.length, 2);
    for (const d of wire) {
      const box = d.from.instancePath[0], launch = box === 'A' ? 12 : 9;
      assert.deepEqual(d.waves.map(w => [w.channelId, w.sources]), [['CWDM_1311', [endpoint(box, 'wave0', 'OPT_OUT')]]]);
      near(d.start.known, launch); near(d.arrival.known, launch);
      const at = mux.at(d.from)!;
      for (const [side, outArrow, inArrow] of [['top', '↑', '↓'], ['left', '←', '→'], ['right', '→', '←']] as const) {
        assert.deepEqual(portPowerLines(at, side), [outArrow + ' 出 ' + launch.toFixed(2) + ' dBm',
          inArrow + ' 入 ' + (box === 'A' ? '9.00' : '12.00') + ' dBm']);
      }
    }
  }
});

test('wire readings isolate parallel channel filters, incoming branches, and empty, unknown or partial power', () => {
  const p = wdmProject(), root = p.moduleDefinitions[0], a = p.moduleDefinitions[1];
  const sink: ComponentDefinition = { id: 'sink', kind: 'component', name: 'Sink', ports: [
    { id: 'IN', type: 'OPTICAL', direction: 'in', channelIds: ['CWDM_1311'] }] };
  p.componentDefinitions = [...p.componentDefinitions, sink];
  root.instances = [...root.instances, { id: 'tap', name: 'Tap', definitionId: 'sink' }];
  root.connections = [...root.connections!, { id: 'tap', from: local('A', 'COM'), to: local('tap', 'IN') },
    { id: 'other', from: local('B', 'COM'), to: local('tap', 'IN') }];
  const wire = (id: string) => wireRouteKey([], { kind: 'connection', id });
  const get = () => createMultiplexPower(createPathResolver(p).graph);
  const tap = () => get().wire(wire('tap'))!;
  assert.equal(tap().length, 1);
  assert.deepEqual(tap()[0].waves.map(w => w.channelId), ['CWDM_1311']);
  near(tap()[0].start.known, -1);
  assert.deepEqual(get().wire(wire('other')), []);
  sink.ports = [{ ...sink.ports[0], channelIds: ['CWDM_1311', 'CWDM_1371'] }];
  const branched = get();
  near(branched.at({ instancePath: ['tap'], portId: 'IN' })!.in.known, -1 + 10 * Math.log10(2));
  assert.deepEqual(branched.wire(wire('other'))![0].waves.map(w => w.channelId), ['CWDM_1371']);
  assert.deepEqual(branched.wire(wire('tap'))![0].waves.map(w => w.channelId), ['CWDM_1311']);
  const laser = p.componentDefinitions.find(d => d.id === 'library-laser')!;
  laser.parameters = laser.parameters?.map(param => ({ ...param, defaultValue: undefined }));
  a.instances.find(i => i.id === 'wave0')!.parameterOverrides = {};
  assert.equal(totalText(tap()[0].start, 2), '未确定');
  const trunk = get().wire(wire('fibre'))!.find(d => d.from.instancePath[0] === 'A')!;
  assert.equal(totalText(trunk.start, 2), '已知 -1.00 dBm');
  a.connections = a.connections!.filter(c => c.id !== 'branch0');
  assert.deepEqual(tap(), []);
});

test('two levels of bidirectional public ports preserve the module-relative faces of both mapping directions', () => {
  const p = wdmProject(), box = p.moduleDefinitions[1];
  const child = { ...box, id: 'inner' };
  p.moduleDefinitions = [...p.moduleDefinitions, child];
  box.instances = [{ id: 'inner', name: 'Inner', definitionId: child.id }];
  box.connections = []; box.portMappings = [{ portId: 'COM', target: local('inner', 'COM') }];
  delete p.layout; delete p.namedLinks;
  const mux = createMultiplexPower(createPathResolver(p).graph);
  for (const scope of [['A'], ['A', 'inner']]) {
    const directions = mux.wire(wireRouteKey(scope, { kind: 'mapping', id: 'COM' }))!;
    assert.deepEqual(directions.map(d => [d.fromFlow, d.toFlow]), [['in', 'in'], ['out', 'out']]);
    assert.deepEqual(directions[0].from.instancePath, scope);
    assert.deepEqual(directions[1].to.instancePath, scope);
    near(directions[0].start.known, .010299956639812);
    near(directions[1].start.known, 2.010299956639812);
  }
});

test('source changes, unused channels, missing power and cochannel conflicts are local to their wave and direction', () => {
  const p = wdmProject(), a = p.moduleDefinitions[1];
  const emitter = a.instances.find(i => i.id === 'wave0')!;
  const get = () => createMultiplexPower(createPathResolver(p).graph);
  emitter.parameterOverrides = { power: fixed(3) };
  const changed = get();
  const aPower = changed.at(endpoint('A', 'wdm', 'COM'))!, bPower = changed.at(endpoint('B', 'wdm', 'COM'))!;
  near(aPower.out.known, 10 * Math.log10(10 ** .2 + 10 ** -.1));
  near(aPower.in.known, .010299956639812);
  near(bPower.in.known, numeric(aPower.out.known) - 2);
  near(bPower.out.known, 2.010299956639812);
  const trial = createMultiplexPower(createPathResolver(p).graph, [{endpoint: endpoint('A', 'wave0', 'OPT_OUT'), channelId: 'CWDM_1311', powerDbm: 5}]);
  near(trial.at(aPower.ref)!.waves[0].power, 4);
  near(trial.at(aPower.ref)!.in.known, .010299956639812);
  p.namedLinks = [...p.namedLinks!, { ...p.namedLinks![0], id: 'same-physical-wave' }];
  assert.deepEqual(get().at(aPower.ref), aPower);
  emitter.parameterOverrides = {};
  const laser = p.componentDefinitions.find(d => d.id === 'library-laser')!;
  laser.parameters = laser.parameters?.map(param => ({ ...param, defaultValue: undefined }));
  const missing = get().at(aPower.ref)!;
  assert.ok(missing.out.partial);
  near(missing.out.known, -1);
  assert.equal(missing.waves[0].power.availability, 'unavailable');
  const branch = a.connections!.find(c => c.id === 'branch0')!;
  a.connections = a.connections!.filter(c => c !== branch);
  const open = get().at(aPower.ref)!;
  near(open.out.known, -1);
  assert.equal(open.out.partial, false);
  assert.equal(open.waves.length, 3);
  a.instances = [...a.instances, { ...emitter, id: 'spare', name: 'Spare', parameterOverrides: { power: fixed(2) } }];
  a.connections = [...a.connections, branch, { ...branch, id: 'second', from: local('spare', 'OPT_OUT') }];
  const conflict = get().at(aPower.ref)!;
  assert.equal(conflict.waves[0].sources.length, 2);
  assert.equal(conflict.waves[0].power.availability, 'unavailable');
  assert.match(conflict.waves[0].power.reason, /多路来源/);
  near(conflict.out.known, -1);
  const link = p.namedLinks![0];
  const trace = createPathResolver(p).resolveNamedLink(link);
  assert.equal(trace.status, 'resolved');
  const optical = createOpticalBudget(p);
  assert.equal(optical.calculateSourcePath(trace.trace).pathIssue?.status, 'ambiguous');
  assert.equal(optical.calculateLocal({ source: {endpoint: link.from!, channelId: link.channelId}, to: link.to! }).powerDbm.availability, 'unavailable');
});

test('MZM and DML RF remain attached to their original carriers through both WDMs and the shared fibre', () => {
  const p = parseProjectJson(serializeProjectJson(wdmProject(true)));
  const mux = createMultiplexPower(createPathResolver(p).graph);
  const tx = mux.at(endpoint('A', 'wdm', 'COM'))!.waves.find(w => w.channelId === 'CWDM_1311')!;
  assert.deepEqual(tx.sources, [endpoint('A', 'wave0', 'OPT_OUT')]);
  near(tx.power, -1 - 10 * Math.log10(2));
  const withLoss = createLinkBudget(p);
  const ideal = structuredClone(p);
  ideal.moduleDefinitions[0].connections![0].lossDb = 0;
  for (const box of ideal.moduleDefinitions.slice(1)) box.instances[0].parameterOverrides = { insertionLoss: fixed(0) };
  const withoutLoss = createLinkBudget(ideal);
  for (const [i, kind] of [[0, 'mzm'], [2, 'dml']] as const) {
    const link = p.namedLinks![i], trial = {frequencyGHz: 15, inputPowerDbm: -20};
    const actual = withLoss.calculateNamedLink(link, trial), baseline = withoutLoss.calculateNamedLink(link, trial);
    assert.equal(actual.kind, 'conversion');
    assert.equal(baseline.kind, 'conversion');
    assert.equal(actual.segments[0].transmitter.kind, kind);
    assert.equal(actual.segments[0].channelId, link.channelId);
    near(actual.segments[0].pdPowerDbm, -4 - (kind === 'mzm' ? 10 * Math.log10(2) : 0));
    near(actual.gainDb, numeric(baseline.gainDb) - 8);
    near(actual.powerDbm, numeric(actual.gainDb) - 20);
    assert.ok(actual.segments[0].optical!.stages.every(s => s.channelId === link.channelId));
  }
  const eo = p.componentDefinitions.find(d => d.id === 'library-mzm')!;
  eo.transfers = eo.transfers!.map(t => ({ ...t, channelIds: ['CWDM_1351'] }));
  const rejected = createMultiplexPower(createPathResolver(p).graph).at(endpoint('A', 'wdm', 'COM'))!;
  assert.ok(rejected.waves.every(w => w.channelId !== 'CWDM_1311'));
});

test('each common segment reports power at its own end after attenuation and splitting', () => {
  const p = wdmProject(), root = p.moduleDefinitions[0];
  p.componentDefinitions = [...p.componentDefinitions, { id: 'splitter', kind: 'component', name: 'Splitter',
    ports: [{ id: 'IN', type: 'OPTICAL', direction: 'in' }, { id: 'B', type: 'OPTICAL', direction: 'out' },
      { id: 'TAP', type: 'OPTICAL', direction: 'out' }],
    transfers: [{ kind: 'splitter', fromPortId: 'IN', toPortId: 'B', secondPortId: 'TAP', firstPercent: fixed(75) }] }];
  root.instances = [...root.instances, { id: 'splitter', name: 'Splitter', definitionId: 'splitter' }];
  root.connections = [{ id: 'feed', from: local('A', 'COM'), to: local('splitter', 'IN'), lossDb: 2 },
    { id: 'to-B', from: local('splitter', 'B'), to: local('B', 'COM'), lossDb: 1 }];
  const mux = createMultiplexPower(createPathResolver(p).graph);
  const split = (portId: string) => mux.at({ instancePath: ['splitter'], portId })!;
  near(split('IN').in.known, .010299956639812);
  near(split('B').out.known, .010299956639812 + 10 * Math.log10(.75));
  near(split('TAP').out.known, .010299956639812 + 10 * Math.log10(.25));
  near(mux.at(endpoint('B','wdm','COM'))!.in.known, .010299956639812 + 10 * Math.log10(.75) - 1);
  assert.equal(mux.at(endpoint('A','wdm','COM'))!.in.known.availability, 'unavailable');
});

test('trial carrier changes and clears apply to both COMs and the originating named path', () => {
  const p = wdmProject(), resolver = createPathResolver(p), link = p.namedLinks![0];
  for (const [channelId, active] of [['CWDM_1391', false], ['CWDM_1311', true], [undefined, true]] as const) {
    const trials = channelId ? [{ endpoint: link.from!, channelId, powerDbm: 0 }] : [];
    const graph = createMultiplexPower(resolver.graph, trials);
    const a = graph.at(endpoint('A', 'wdm', 'COM'))!, b = graph.at(endpoint('B', 'wdm', 'COM'))!;
    assert.equal(resolver.resolveNamedLink(link, { opticalSources: trials.map(t => ({...t.endpoint, channelId: t.channelId})) }).status,
      active ? 'resolved' : 'unreachable');
    near(a.out.known, active ? 2.010299956639812 : -1);
    near(b.in.known, active ? .010299956639812 : -3);
    near(a.in.known, .010299956639812);
    near(b.out.known, 2.010299956639812);
  }
});

test('trial-only cochannel injection blocks MZM and DML PD/RF power until it moves or clears', () => {
  for (const i of [0, 2]) {
    const p = wdmProject(true), tx = i === 0 ? 'A' : 'B', box = p.moduleDefinitions[i === 0 ? 1 : 2];
    p.componentDefinitions = [...p.componentDefinitions, { kind: 'component', id: 'external', name: 'External',
      ports: [{id: 'OUT', direction: 'out', type: 'OPTICAL'}] }];
    box.instances = [...box.instances,{id: 'external', name: 'External', definitionId: 'external'}];
    box.connections = [...box.connections!, {id: 'inject', from: local('external','OUT'), to: local('wdm','CH' + (i+1))}];
    const link = p.namedLinks![i], other = p.namedLinks![i === 0 ? 2 : 0];
    const budget = createLinkBudget(p), resolver = createPathResolver(p);
    if (i === 2) {
      const changedDml = [{ endpoint: endpoint('B', 'wave2', 'OPT_OUT'), channelId: 'CWDM_1391' as const, powerDbm: 0 }];
      const com = createMultiplexPower(resolver.graph, changedDml).at(endpoint('B', 'wdm', 'COM'))!;
      near(com.out.known, -1);
      const rf = budget.calculateNamedLink(link, { frequencyGHz: 15, inputPowerDbm: -20, opticalSources: changedDml });
      assert.equal(rf.powerDbm.availability, 'unavailable');
    }
    for (const [channelId, conflict] of [[link.channelId, true], ['CWDM_1391', false], [undefined, false]] as const) {
      const trials = channelId ? [{endpoint: endpoint(tx,'external','OUT'), channelId, powerDbm: 0}] : [];
      const input = {frequencyGHz: 15, inputPowerDbm: -20, opticalSources: trials};
      const point = budget.calculateNamedLink(link, input);
      assert.equal(point.kind, 'conversion');
      const com = createMultiplexPower(resolver.graph, trials).at(endpoint(tx, 'wdm', 'COM'))!;
      assert.equal(com.out.partial, conflict);
      if (conflict) {
        near(com.out.known, -1);
        assert.equal(point.segments[0].pdPowerDbm.availability, 'unavailable');
        assert.equal(point.powerDbm.availability, 'unavailable');
        assert.match(point.powerDbm.reason, /同方向、同波长/);
      } else {
        near(point.segments[0].pdPowerDbm, i === 0 ? -4 - 10 * Math.log10(2) : -4);
        near(point.powerDbm, i === 0 ? -66.01580271955808 : -29.938200260161125);
      }
      const opposite = budget.calculateNamedLink(other, input);
      near(opposite.powerDbm, i === 0 ? -29.938200260161125 : -66.01580271955808);
    }
  }
});
