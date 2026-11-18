import assert from 'node:assert/strict';
import test from 'node:test';
import { exampleProject } from '../../src/model/v1/example';
import type { ModuleDefinition, PhysicalPlacement, Project } from '../../src/model/v1/types';
import { validateProject } from '../../src/model/v1/validate';

function editModule(id: string, edit: (module: ModuleDefinition) => ModuleDefinition): Project {
  return {
    ...exampleProject,
    moduleDefinitions: exampleProject.moduleDefinitions.map(module => module.id === id ? edit(module) : module),
  };
}

test('shared definitions have distinct instance paths and independent layouts', () => {
  validateProject(exampleProject);
  const placements = exampleProject.layout.physical;
  assert.equal(placements[0].instancePath.length, 5);
  assert.deepEqual(placements[0].instancePath.slice(1), placements[1].instancePath.slice(1));
  assert.notDeepEqual(placements[0].enclosurePath, placements[1].enclosurePath);
  assert.notEqual(placements[0].xMm, placements[1].xMm);
  assert.notEqual(exampleProject.layout.topology[0].x, exampleProject.layout.topology[1].x);
  assert.equal(exampleProject.moduleDefinitions.filter(module => module.id === 'cbb').length, 1);

  const renamed = editModule('System', module => ({
    ...module,
    instances: module.instances.map(instance => ({ ...instance, name: 'Shared display name' })),
  }));
  validateProject(renamed);
  validateProject({ ...renamed, layout: { physical: placements } });
  validateProject({ ...renamed, layout: { topology: exampleProject.layout.topology } });
});

test('a chassis can declare its public ports before adding children or mappings', () => {
  const project = editModule('TX_CHASSIS', module => ({ ...module, instances: [], portMappings: undefined }));
  validateProject({ ...project, layout: undefined });
});

test('definition cycles are rejected without imposing a depth limit on valid projects', () => {
  const self = editModule('mzm', module => ({
    ...module, instances: [...module.instances, { id: 'recursive', name: 'Recursive', definitionId: 'mzm' }],
  }));
  assert.throws(() => validateProject(self), /mzm -> mzm/);
  const indirect = editModule('mzm', module => ({
    ...module, instances: [...module.instances, { id: 'back', name: 'Back', definitionId: 'cbb' }],
  }));
  assert.throws(() => validateProject(indirect), /cbb -> mzm -> cbb/);

  const depth = 12_000;
  const modules = Array.from({ length: depth }, (_, index): ModuleDefinition => ({
    kind: 'module', id: String(index), name: 'Nested module', ports: [],
    instances: index === depth - 1 ? [] : [{ id: 'child', name: 'Child', definitionId: String(index + 1) }],
  }));
  validateProject({
    id: 'deep', name: 'Deep hierarchy', rootModuleDefinitionId: '0', componentDefinitions: [],
    moduleDefinitions: modules,
    layout: { topology: [{ instancePath: Array<string>(depth - 1).fill('child'), x: 0, y: 0 }] },
  });
});

test('invalid roots, child references and same-scope IDs are rejected', () => {
  assert.throws(() => validateProject({ ...exampleProject, rootModuleDefinitionId: 'mzm-optical' }), /must reference a module/);
  const missingDefinition = editModule('System', module => ({
    ...module, instances: [{ id: 'TX_A', name: 'Missing', definitionId: 'unknown' }],
  }));
  assert.throws(() => validateProject(missingDefinition), /unknown definition/);
  const duplicate = editModule('System', module => ({ ...module, instances: [module.instances[0], module.instances[0]] }));
  assert.throws(() => validateProject(duplicate), /duplicate ID "TX_A"/);
});

test('existing mappings must target direct children and preserve type and direction', () => {
  const mappingTo = (instanceId: string, portId: string) => editModule('TX_CHASSIS', module => ({
    ...module, portMappings: [{ portId: 'OPT_OUT', target: { instanceId, portId } }],
  }));
  assert.throws(() => validateProject(mappingTo('MZM_OPTICAL', 'OPT_OUT')), /direct child/);
  assert.throws(() => validateProject(mappingTo('TX_SLOT', 'missing')), /unknown child port/);
  const wrongDirection = editModule('TX_CHASSIS', module => ({
    ...module, ports: [{ id: 'OPT_OUT', type: 'OPTICAL', direction: 'in' }],
  }));
  assert.throws(() => validateProject(wrongDirection), /preserve port type and direction/);
});

test('reused slot and CBB modules have independent placements in nested enclosures', () => {
  const { physical, topology } = exampleProject.layout;
  const [, , slotA, slotB, cbbA, cbbB] = physical;
  assert.deepEqual(slotA.enclosurePath, ['TX_A']);
  assert.deepEqual(slotB.enclosurePath, ['TX_B']);
  assert.notEqual(slotA.xMm, slotB.xMm);
  assert.deepEqual(cbbA.enclosurePath, slotA.instancePath);
  assert.deepEqual(cbbB.enclosurePath, slotB.instancePath);
  assert.notEqual(cbbA.xMm, cbbB.xMm);

  const project: Project = {
    ...exampleProject,
    layout: { topology, physical: physical.map(placement =>
      placement === slotA ? { ...placement, xMm: slotB.xMm + 10 } : placement) },
  };
  validateProject(project);
  assert.deepEqual(project.layout?.physical?.[3], slotB);
  assert.deepEqual(project.layout?.physical?.[4], cbbA);
  assert.deepEqual(project.layout?.topology, topology);
});

test('physical placement needs a real instance, an enclosure and a valid quarter turn', () => {
  const placement = exampleProject.layout.physical[0];
  const logicalModule = ['TX_A', 'TX_SLOT', 'TX_CBB', 'MZM_MODULE'];
  const validatePlacement = (change: Partial<PhysicalPlacement>) =>
    validateProject({ ...exampleProject, layout: { physical: [{ ...placement, ...change }] } });
  assert.throws(() => validatePlacement({ instancePath: ['TX_A', 'UNKNOWN_SLOT'] }), /component or enclosure module instance/);
  assert.throws(() => validatePlacement({ instancePath: logicalModule }), /component or enclosure module instance/);
  assert.throws(() => validatePlacement({ enclosurePath: logicalModule }), /enclosure module instance/);
  assert.throws(() => validatePlacement({ rotationDeg: 45 }), /Invalid physical coordinates or rotation/);
});

test('physical containment can differ from logical parentage but cannot form cycles', () => {
  const [, , slotA, slotB] = exampleProject.layout.physical;
  const inSlot = (placement: PhysicalPlacement, container: PhysicalPlacement): PhysicalPlacement =>
    ({ ...placement, enclosurePath: container.instancePath });
  const validatePlacements = (...physical: PhysicalPlacement[]) =>
    validateProject({ ...exampleProject, layout: { physical } });
  validatePlacements(inSlot(slotA, slotB), slotB);
  assert.throws(() => validatePlacements(inSlot(slotA, slotA)), /Physical containment cycle/);
  assert.throws(() => validatePlacements(inSlot(slotA, slotB), inSlot(slotB, slotA)), /Physical containment cycle/);
});
