import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { deviceExample } from '../../src/model/v1/device-example';
import { exampleProject } from '../../src/model/v1/example';
import type { NumericParameter } from '../../src/model/v1/parameters';
import type { ModuleDefinition, Project } from '../../src/model/v1/types';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

test('a restored snapshot resolves each interface down to its own leaf occurrence', () => {
  const [root, ...modules] = exampleProject.moduleDefinitions;
  const port = { id: 'OPT_OUT', type: 'OPTICAL', direction: 'out' } as const;
  const project = parseProjectJson(serializeProjectJson({
    ...exampleProject,
    moduleDefinitions: [{
      ...root, ports: [port],
      portMappings: [{ portId: port.id, target: { instanceId: 'TX_A', portId: port.id } }],
    }, ...modules],
  }));
  const before = structuredClone(project);
  const { resolveInstance, resolvePort } = resolveHierarchy(project);
  assert.equal(resolveInstance([])?.definition.id, 'System');
  assert.equal(resolveInstance([])?.instance, undefined);
  const pathA = ['TX_A', 'TX_SLOT', 'TX_CBB', 'MZM_MODULE', 'MZM_OPTICAL'];
  assert.deepEqual(resolvePort({ instancePath: [], portId: port.id }), {
    status: 'resolved',
    chain: Array.from({ length: 6 }, (_, depth) => ({ instancePath: pathA.slice(0, depth), portId: port.id })),
  });
  const pathB = ['TX_B', ...pathA.slice(1)];
  const chainB = resolvePort({ instancePath: ['TX_B'], portId: port.id });
  assert.equal(chainB.status, 'resolved');
  assert.deepEqual(chainB.chain.at(-1)?.instancePath, pathB);
  assert.equal(resolveInstance(pathA)?.definition.id, 'mzm-optical');
  assert.equal(resolveInstance(pathB)?.definition, resolveInstance(pathA)?.definition);
  assert.notDeepEqual(resolveInstance(pathA)?.instancePath, resolveInstance(pathB)?.instancePath);
  assert.deepEqual(project, before);
});

test('an unmapped public port is distinct from an invalid endpoint or saved mapping', () => {
  const project: Project = {
    ...exampleProject, layout: undefined,
    moduleDefinitions: exampleProject.moduleDefinitions.map(module =>
      module.id === 'slot' ? { ...module, instances: [], portMappings: undefined } : module),
  };
  const { resolvePort } = resolveHierarchy(project);
  const from = { instancePath: ['TX_A'], portId: 'OPT_OUT' };
  assert.deepEqual(resolvePort(from), {
    status: 'unmapped', chain: [from, { instancePath: ['TX_A', 'TX_SLOT'], portId: 'OPT_OUT' }],
  });
  for (const endpoint of [{ ...from, portId: 'missing' }, { ...from, instancePath: ['missing'] }]) {
    assert.deepEqual(resolvePort(endpoint), { status: 'invalid_reference', chain: [], endpoint });
  }
  assert.throws(() => resolveHierarchy({
    ...project,
    moduleDefinitions: project.moduleDefinitions.map(module => module.id === 'slot' ? {
      ...module, portMappings: [{ portId: 'OPT_OUT', target: { instanceId: 'absent', portId: 'OPT_OUT' } }],
    } : module),
  }), /must target a direct child/);
});

test('explicit mapped values, local overrides, defaults and missing values stay scoped to an occurrence', () => {
  const fixed = (value: number) => ({ kind: 'fixed', value }) as const;
  const published: NumericParameter = {
    id: 'gain', name: 'Gain', kind: 'numeric', unit: 'dB', valueKind: 'fixed', overridable: true,
  };
  const project: Project = {
    id: 'parameters', name: 'Parameter forwarding', rootModuleDefinitionId: 'root',
    moduleDefinitions: [
      { kind: 'module', id: 'root', name: 'Root', ports: [], instances: [
        { id: 'A', name: 'Board', definitionId: 'board', parameterOverrides: { gain: fixed(0) } },
        { id: 'B', name: 'Board', definitionId: 'board' },
      ] },
      { kind: 'module', id: 'board', name: 'Board', ports: [], parameters: [published],
        instances: [{ id: 'slot', name: 'Slot', definitionId: 'slot' }],
        parameterMappings: [{ parameterId: 'gain', target: { instanceId: 'slot', parameterId: 'gain' } }] },
      { kind: 'module', id: 'slot', name: 'Slot', ports: [], parameters: [published], instances: [
        { id: 'overridden', name: 'Device', definitionId: 'device', parameterOverrides: { gain: fixed(-9) } },
        { id: 'defaulted', name: 'Device', definitionId: 'device' },
      ], parameterMappings: [
        { parameterId: 'gain', target: { instanceId: 'overridden', parameterId: 'gain' } },
        { parameterId: 'gain', target: { instanceId: 'defaulted', parameterId: 'gain' } },
      ] },
    ],
    componentDefinitions: [{ kind: 'component', id: 'device', name: 'Device', ports: [],
      parameters: [{ ...published, defaultValue: fixed(-3) }] }],
  };
  const { resolveInstance } = resolveHierarchy(project);
  assert.deepEqual(resolveInstance(['A', 'slot', 'overridden'])?.parameters.get('gain'), {
    value: fixed(0), source: { kind: 'mapped', instancePath: ['A', 'slot'], parameterId: 'gain' },
  });
  assert.deepEqual(resolveInstance(['A', 'slot'])?.parameters.get('gain'), {
    value: fixed(0), source: { kind: 'mapped', instancePath: ['A'], parameterId: 'gain' },
  });
  assert.equal(resolveInstance(['B', 'slot'])?.parameters.has('gain'), false);
  assert.deepEqual(resolveInstance(['B', 'slot', 'overridden'])?.parameters.get('gain'), {
    value: fixed(-9), source: { kind: 'override' },
  });
  assert.deepEqual(resolveInstance(['B', 'slot', 'defaulted'])?.parameters.get('gain'), {
    value: fixed(-3), source: { kind: 'default' },
  });
});

test('switch selection belongs to the actual instance', () => {
  const { resolveInstance } = resolveHierarchy(deviceExample);
  const a = resolveInstance(['swA']);
  const b = resolveInstance(['swB']);
  assert.equal(a?.definition, b?.definition);
  assert.equal(a?.switchState?.id, 'a');
  assert.equal(b?.switchState?.id, 'b');
});

test('deep paths resolve iteratively and definition cycles are rejected before lookup', () => {
  const depth = 12_000;
  const modules = Array.from({ length: depth }, (_, index): ModuleDefinition => ({
    kind: 'module', id: String(index), name: 'Module', ports: [],
    instances: index === depth - 1 ? [] : [{ id: 'child', name: 'Child', definitionId: String(index + 1) }],
  }));
  const project: Project = {
    id: 'deep', name: 'Deep hierarchy', rootModuleDefinitionId: '0', componentDefinitions: [], moduleDefinitions: modules,
  };
  const path = Array<string>(depth - 1).fill('child');
  assert.equal(resolveHierarchy(project).resolveInstance(path)?.definition.id, String(depth - 1));
  assert.throws(() => resolveHierarchy({
    ...project,
    moduleDefinitions: [{ ...modules[0], instances: [{ id: 'self', name: 'Self', definitionId: '0' }] }],
  }), /Module definition cycle: 0 -> 0/);
});
