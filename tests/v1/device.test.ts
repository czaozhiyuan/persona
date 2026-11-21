import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOpticalChannel } from '../../src/model/v1/channels';
import { deviceExample } from '../../src/model/v1/device-example';
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
  assert.throws(() => validateProject(badSupply), /供光端口必须是光输入端口/);
  const wrongMuxChannel = editComponent('mux', component => ({
    ...component, transfers: [{ kind: 'optical', fromPortId: 'IN_28', toPortId: 'COMMON', channelIds: ['DWDM_CH30'] }],
  }));
  assert.throws(() => validateProject(wrongMuxChannel), /传输端口不支持此光通道/);
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
    assert.throws(() => validateProject(project), /光开关状态缺失或无效/);
  }
  const invalidRoute = editComponent('switch', component => ({
    ...component, switchStates: [{ id: 'a', name: 'A', routes: [{ fromPortId: 'OUT_A', toPortId: 'OUT_B' }] }],
  }));
  assert.throws(() => validateProject(invalidRoute), /传输端口、类型或方向无效/);
  const invalidTable = editComponent('switch', component => ({
    ...component, switchStates: [{ id: 'a', name: 'A', routes: [{
      fromPortId: 'IN', toPortId: 'OUT_A', gainDb: { kind: 'channelTable', values: { CWDM_1370: -1 } },
    }] }],
  }));
  assert.throws(() => validateProject(invalidTable), /无效的光通道「CWDM_1370」/);
  const bypass = editComponent('switch', component => ({
    ...component, transfers: [{ kind: 'optical', fromPortId: 'IN', toPortId: 'OUT_A' }],
  }));
  assert.throws(() => validateProject(bypass), /光路由必须由开关状态决定/);
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
  assert.throws(() => validateProject(invalidRating), /额定值单位或端口方向不匹配/);
  const unsorted = editComponent('rf-pcb', component => ({
    ...component, transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT',
      gainDb: { kind: 'rfCurve', points: [[10, 0], [10, -1]] } }],
  }));
  assert.throws(() => validateProject(unsorted), /严格递增/);
  const notFinite = editComponent('rf-pcb', component => ({
    ...component, transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT',
      gainDb: { kind: 'fixed', value: Infinity } }],
  }));
  assert.throws(() => validateProject(notFinite), /有限数值/);
});

test('a module forwards only compatible parameters exposed by direct children', () => {
  validateProject(deviceExample);
  const bypass = editModule('board', module => ({
    ...module, parameterMappings: [{ parameterId: 'modulatorLoss', target: { instanceId: 'mzm', parameterId: 'modulatorLoss' } }],
  }));
  assert.throws(() => validateProject(bypass), /直接子实例/);
  const hidden = editModule('tx30', module => ({
    ...module, parameters: module.parameters?.map(parameter => ({ ...parameter, overridable: false })),
  }));
  assert.throws(() => validateProject(hidden), /子实例参数未开放覆盖/);
  const incompatible = editModule('tx30', module => ({
    ...module, parameters: module.parameters?.map(parameter => parameter.kind === 'numeric' ? { ...parameter, unit: 'dBm' } : parameter),
  }));
  assert.throws(() => validateProject(incompatible), /参数类型、单位或允许的取值不兼容/);
  const invalidEnum = editModule('system', module => ({
    ...module, instances: module.instances.map(instance => instance.id === 'board'
      ? { ...instance, parameterOverrides: { mode: 'unsupported' } } : instance),
  }));
  assert.throws(() => validateProject(invalidEnum), /枚举值无效/);
  const invalidOverride = editModule('system', module => ({
    ...module, instances: module.instances.map(instance => instance.id === 'board'
      ? { ...instance, parameterOverrides: { modulatorLoss: { kind: 'fixed', value: -1 } } } : instance),
  }));
  assert.throws(() => validateProject(invalidOverride), /指定范围内/);
});
