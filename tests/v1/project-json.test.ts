import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { NamedLink } from '../../src/model/v1/topology';
import { resizeTopologyFrame } from '../../src/state/v1/topology-edits';
import type { Project } from '../../src/model/v1/types';
import { ProjectFileError, ProjectStructureError, parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const source = readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8');

function roundTrip(project: Project): Project {
  return parseProjectJson(serializeProjectJson(project));
}

test('the standalone example round-trips all project snapshots, references and layouts', () => {
  const project = parseProjectJson(source);
  assert.deepEqual(roundTrip(project), project);

  const physical = project.layout?.physical?.[0];
  assert.deepEqual(physical?.instancePath, ['layoutDemo', 'TX_A', 'TX_SLOT', 'TX_CBB', 'MZM_MODULE', 'MZM_OPTICAL']);
  assert.deepEqual(project.layout?.topology?.[0], { instancePath: ['layoutDemo', 'TX_A'], x: 40, y: 80 });
  const board = project.moduleDefinitions.find(module => module.id === 'deviceDemo-board');
  assert.equal(board?.parameterMappings?.[0].target.instanceId, 'TX_CH30');
  assert.equal(board?.portMappings?.length, 2);
  const devices = project.moduleDefinitions.find(module => module.id === 'deviceDemo-system')?.instances;
  assert.deepEqual(devices?.find(instance => instance.id === 'board')?.parameterOverrides?.modulatorGain, { kind: 'fixed', value: -4 });
  assert.deepEqual(devices?.filter(instance => instance.switchStateId).map(instance => instance.switchStateId), ['a', 'b']);
  const bundle = project.moduleDefinitions.find(module => module.id === 'system')?.cableBundles?.[0];
  assert.equal(bundle?.coreCount, 12);
  assert.deepEqual(bundle?.cores[2].b, { pin: 10 });
  assert.equal(project.namedLinks?.find(link => link.id === 'full')?.conversionBindings?.[0].profileId, 'reference');
});

test('topology frames retain different bounds for instances of the same module', () => {
  const project = parseProjectJson(source);
  const a = { modulePath: ['TX_A'], x: -35, y: -20, width: 700, height: 500 };
  const b = { ...a, modulePath: ['TX_B'], width: 600 };
  const initial = resizeTopologyFrame(resizeTopologyFrame(project, a), b);
  const resized = { ...a, width: 760 };
  const snapshot = resizeTopologyFrame(initial, resized);

  assert.deepEqual(roundTrip(snapshot).layout?.topologyFrames, [b, resized]);
  assert.deepEqual(snapshot.layout?.physical, project.layout?.physical);
  assert.deepEqual(snapshot.layout?.topology, project.layout?.topology);
  assert.throws(() => serializeProjectJson(resizeTopologyFrame(project, { ...a, width: 0 })), /模块边框坐标或尺寸无效/);
  assert.throws(() => serializeProjectJson(resizeTopologyFrame(project, { ...a, modulePath: ['TX_A', 'mzm'] })), /模块边框必须引用模块/);
});

test('interface-first modules and incomplete or disconnected links remain editable', () => {
  const project = parseProjectJson(source);
  const root = project.moduleDefinitions.find(module => module.id === project.rootModuleDefinitionId)!;
  const emptyChassis = {
    kind: 'module', id: 'empty-chassis', name: 'Empty chassis', instances: [],
    ports: [{ id: 'IN', type: 'OPTICAL', direction: 'in' }],
  } as const;
  const disconnected: NamedLink = {
    id: 'disconnected', name: 'Future route',
    from: { instancePath: ['TX_A'], portId: 'OPT_OUT' }, to: { instancePath: ['empty'], portId: 'IN' },
  };
  const snapshot: Project = {
    ...project,
    moduleDefinitions: [...project.moduleDefinitions.map(module => module === root ? {
      ...module, instances: [...module.instances, { id: 'empty', name: 'Empty', definitionId: emptyChassis.id }],
    } : module), emptyChassis],
    namedLinks: [...project.namedLinks!, disconnected],
  };
  const restored = roundTrip(snapshot);
  assert.deepEqual(restored.moduleDefinitions.find(module => module.id === emptyChassis.id), emptyChassis);
  assert.deepEqual(restored.namedLinks?.find(link => link.id === 'draft'), { id: 'draft', name: 'Optical budget' });
  assert.deepEqual(restored.namedLinks?.find(link => link.id === 'tx-only'), project.namedLinks?.find(link => link.id === 'tx-only'));
  assert.deepEqual(restored.namedLinks?.find(link => link.id === disconnected.id), disconnected);
});

test('an atomically unbound snapshot can be saved and rebound with the same link identity', () => {
  const project = parseProjectJson(source);
  const identity = { id: 'editable', name: 'Temporary path' };
  const linked: NamedLink = { ...identity, from: { instancePath: ['TX_A'], portId: 'TEST_OUT' } };
  const before = { ...project, namedLinks: [...project.namedLinks!, linked] };
  assert.deepEqual(roundTrip(before).namedLinks?.at(-1), linked);

  const after: Project = {
    ...before,
    moduleDefinitions: before.moduleDefinitions.map(module => {
      if (module.id === 'tx') return { ...module, ports: module.ports.filter(port => port.id !== 'TEST_OUT') };
      if (module.id !== 'system') return module;
      return {
        ...module,
        cableBundles: module.cableBundles?.map(bundle => ({
          ...bundle, cores: bundle.cores.map(core => core.id === 'open' ? { ...core, a: { pin: core.a.pin } } : core),
        })),
      };
    }),
    namedLinks: before.namedLinks.map(link => link.id === identity.id ? identity : link),
  };
  assert.throws(() => serializeProjectJson({ ...after, namedLinks: before.namedLinks }), /editable.*invalid start endpoint reference/);
  const restored = roundTrip(after);
  assert.deepEqual(restored.namedLinks?.at(-1), identity);

  const rebound = { ...identity, from: { instancePath: ['TX_A'], portId: 'OPT_OUT' } };
  assert.deepEqual(roundTrip({
    ...restored, namedLinks: restored.namedLinks?.map(link => link.id === identity.id ? rebound : link),
  }).namedLinks?.at(-1), rebound);
});

test('invalid imports give a location or domain issue and leave the current snapshot intact', () => {
  const current = parseProjectJson(source);
  assert.throws(() => parseProjectJson('{'), error => error instanceof ProjectFileError && error.stage === 'syntax');
  assert.throws(() => parseProjectJson(JSON.stringify(current)), { name: 'ProjectFileError', stage: 'format', message: /\$\.format/ });
  assert.throws(() => parseProjectJson(source.replace('"schemaVersion": 1', '"schemaVersion": 2')), {
    name: 'ProjectFileError', stage: 'format', message: /\$\.schemaVersion/,
  });
  assert.throws(() => parseProjectJson(source.replace('"coreCount": 12', '"coreCount": 1e999')), {
    name: 'ProjectStructureError', path: '$.project.moduleDefinitions[0].cableBundles[0].coreCount',
  });
  assert.throws(() => parseProjectJson(source.replace('"portId": "OPT_OUT"', '"portId": "missing"')), {
    name: 'ProjectFileError', stage: 'domain', message: /Connection "spare" in "system".*endpoints/,
  });
  const recursiveInstance = { id: 'recursive', name: 'Recursive', definitionId: current.rootModuleDefinitionId };
  const cyclicFile = source.replace('"instances": [', `"instances": [${JSON.stringify(recursiveInstance)},`);
  assert.throws(() => parseProjectJson(cyclicFile), {
    name: 'ProjectFileError', stage: 'domain', message: /Module definition cycle: system -> system/,
  });
  const runtimeState = { ...current, calculationResults: [] };
  assert.throws(() => serializeProjectJson(runtimeState), error =>
    error instanceof ProjectStructureError && error.path === '$.project.calculationResults');
  assert.deepEqual(current, parseProjectJson(source));
  assert.deepEqual(roundTrip(current), current);
});
