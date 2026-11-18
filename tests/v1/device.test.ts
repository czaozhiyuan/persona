import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOpticalChannel } from '../../src/model/v1/channels';
import { deviceExample } from '../../src/model/v1/device-example';
import { DEFAULT_CONVERSION_K } from '../../src/model/v1/device';
import type { ComponentDefinition, ModuleDefinition, Project } from '../../src/model/v1/types';
import { validateProject } from '../../src/model/v1/validate';

function editComponent(id: string, edit: (component: ComponentDefinition) => ComponentDefinition): Project {
  return {
    ...deviceExample,
    componentDefinitions: deviceExample.componentDefinitions.map(component => component.id === id ? edit(component) : component),
  };
}

function editModule(id: string, edit: (module: ModuleDefinition) => ModuleDefinition): Project {
  return {
    ...deviceExample,
    moduleDefinitions: deviceExample.moduleDefinitions.map(module => module.id === id ? edit(module) : module),
  };
}

test('the V1 fixture separates RF, optical supply, wavelength routing and independent board TX/RX', () => {
  validateProject(deviceExample);
  assert.equal(resolveOpticalChannel('MM850')?.wavelengthNm, 850);
  assert.equal(resolveOpticalChannel('CWDM_1371')?.wavelengthNm, 1371);
  assert.equal(resolveOpticalChannel('DWDM_CH28')?.frequencyTHz, 192.8);
  assert.equal(resolveOpticalChannel('DWDM_CH30')?.frequencyTHz, 193);
  for (const id of ['CWDM_1370', 'CWDM_1631', 'DWDM_CH28.5', 'DWDM_CH030', 'DWDM_CH-1900', 'DWDM_CH28\n']) {
    assert.equal(resolveOpticalChannel(id), undefined);
  }
  const badSupply = editComponent('mzm', component => ({
    ...component, transfers: [{ kind: 'eo', fromPortId: 'RF_IN', toPortId: 'OPT_OUT', supplyPortId: 'RF_IN' }],
  }));
  assert.throws(() => validateProject(badSupply), /supply port must be an optical input/);
  const wrongMuxChannel = editComponent('mux', component => ({
    ...component, transfers: [{ kind: 'optical', fromPortId: 'IN_28', toPortId: 'COMMON', channelIds: ['DWDM_CH30'] }],
  }));
  assert.throws(() => validateProject(wrongMuxChannel), /channel disallowed at route port/);
});

test('switch instances select states independently and undeclared states or invalid routes fail validation', () => {
  const system: ModuleDefinition = deviceExample.moduleDefinitions[0];
  const switches = system.instances.filter(instance => instance.definitionId === 'switch');
  assert.deepEqual(switches.map(instance => instance.switchStateId), ['a', 'b']);
  for (const unknownState of ['missing', undefined]) {
    const project = editModule('system', module => ({
      ...module, instances: module.instances.map(instance => instance.id === 'swA'
        ? { ...instance, switchStateId: unknownState } : instance),
    }));
    assert.throws(() => validateProject(project), /missing or unknown switch state/);
  }
  const invalidRoute = editComponent('switch', component => ({
    ...component, switchStates: [{ id: 'a', name: 'A', routes: [{ fromPortId: 'OUT_A', toPortId: 'OUT_B' }] }],
  }));
  assert.throws(() => validateProject(invalidRoute), /invalid route ports/);
  const invalidTable = editComponent('switch', component => ({
    ...component, switchStates: [{ id: 'a', name: 'A', routes: [{
      fromPortId: 'IN', toPortId: 'OUT_A', gainDb: { kind: 'channelTable', values: { CWDM_1370: -1 } },
    }] }],
  }));
  assert.throws(() => validateProject(invalidTable), /invalid optical channel "CWDM_1370"/);
  const bypass = editComponent('switch', component => ({
    ...component, transfers: [{ kind: 'optical', fromPortId: 'IN', toPortId: 'OUT_A' }],
  }));
  assert.throws(() => validateProject(bypass), /switch routes must be state-dependent/);
});

test('ratings and empirical values are optional, and explicit zero remains a finite value', () => {
  const pcb = deviceExample.componentDefinitions[0];
  assert.equal(pcb.ports[0].inputRating?.max, 10);
  assert.equal(pcb.ports[0].inputRating?.min, undefined);
  assert.equal(pcb.ports[1].inputRating, undefined);
  assert.ok(pcb.transfers?.[0]);
  assert.equal('nfDb' in pcb.transfers[0], false);
  const zero = editComponent('rf-pcb', component => ({
    ...component, transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT', gainDb: { kind: 'fixed', value: 0 } }],
  }));
  validateProject(zero);
  const invalidRating = editComponent('rf-pcb', component => ({
    ...component, ports: component.ports.map(port => port.direction === 'out'
      ? { ...port, inputRating: { unit: 'dBm', max: 0 } } : port),
  }));
  assert.throws(() => validateProject(invalidRating), /rating unit or port direction is incompatible/);
  const unsorted = editComponent('rf-pcb', component => ({
    ...component, transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT',
      gainDb: { kind: 'rfCurve', points: [[10, 0], [10, -1]] } }],
  }));
  assert.throws(() => validateProject(unsorted), /strictly increasing/);
  const notFinite = editComponent('rf-pcb', component => ({
    ...component, transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT',
      gainDb: { kind: 'fixed', value: Infinity } }],
  }));
  assert.throws(() => validateProject(notFinite), /finite value/);
});

test('a module forwards only compatible parameters exposed by direct children', () => {
  validateProject(deviceExample);
  const bypass = editModule('board', module => ({
    ...module, parameterMappings: [{ parameterId: 'modulatorGain', target: { instanceId: 'mzm', parameterId: 'modulatorGain' } }],
  }));
  assert.throws(() => validateProject(bypass), /must target a direct child/);
  const hidden = editModule('tx30', module => ({
    ...module, parameters: module.parameters?.map(parameter => ({ ...parameter, overridable: false })),
  }));
  assert.throws(() => validateProject(hidden), /child parameter is not exposed/);
  const incompatible = editModule('tx30', module => ({
    ...module, parameters: module.parameters?.map(parameter => parameter.kind === 'numeric' ? { ...parameter, unit: 'dBm' } : parameter),
  }));
  assert.throws(() => validateProject(incompatible), /incompatible parameter types, units or accepted values/);
  const invalidEnum = editModule('system', module => ({
    ...module, instances: module.instances.map(instance => instance.id === 'board'
      ? { ...instance, parameterOverrides: { mode: 'unsupported' } } : instance),
  }));
  assert.throws(() => validateProject(invalidEnum), /invalid enum value/);
  const invalidOverride = editModule('system', module => ({
    ...module, instances: module.instances.map(instance => instance.id === 'board'
      ? { ...instance, parameterOverrides: { modulatorGain: { kind: 'fixed', value: 10 } } } : instance),
  }));
  assert.throws(() => validateProject(invalidOverride), /within the declared range/);
});

test('profiles retain a fixed PD reference, a declared K default and an optional RF curve', () => {
  const [profile] = deviceExample.conversionProfiles;
  assert.deepEqual(profile.rfGainRefDb, { kind: 'fixed', value: -22 });
  assert.equal(profile.pdPowerRefDbm, -2);
  assert.equal(DEFAULT_CONVERSION_K, 2);
  validateProject({
    ...deviceExample, conversionProfiles: [{ ...profile, k: 1.8, rfGainRefDb: { kind: 'rfCurve', points: [[0, -22], [67, -25]] } }],
  });
  assert.throws(() => validateProject({
    ...deviceExample, conversionProfiles: [{ ...profile, pdPowerRefDbm: NaN }],
  }), /reference power and any explicit k must be finite/);
});
