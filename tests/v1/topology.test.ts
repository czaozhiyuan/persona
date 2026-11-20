import assert from 'node:assert/strict';
import test from 'node:test';
import { topologyExample } from '../../src/model/v1/topology-example';
import type { CableCore, Connection, NamedLink } from '../../src/model/v1/topology';
import type { ModuleDefinition, Project } from '../../src/model/v1/types';
import { validateProject } from '../../src/model/v1/validate';

const system: ModuleDefinition = topologyExample.moduleDefinitions[0];
const fullLink: NamedLink = topologyExample.namedLinks[2];

function editSystem(change: Partial<ModuleDefinition>): Project {
  return { ...topologyExample, moduleDefinitions: [{ ...system, ...change }, ...topologyExample.moduleDefinitions.slice(1)] };
}

function withLink(link: NamedLink): Project {
  return { ...topologyExample, namedLinks: [link] };
}

test('top-level connections can join public ports before their module internals are mapped', () => {
  validateProject(topologyExample);
  const rx: ModuleDefinition = topologyExample.moduleDefinitions[2];
  assert.equal(rx.portMappings, undefined);
  const [ordinary, rj45] = system.connections!;
  assert.equal(ordinary.mediaKind, 'OPTICAL_FIBER');
  assert.equal(rj45.mediaKind, 'RJ45_CABLE');

  const validateConnection = (change: Partial<Connection>) => validateProject(editSystem({ connections: [{ ...ordinary, ...change }] }));
  assert.throws(() => validateConnection({ from: { instanceId: 'mzm', portId: 'OUT' } }), /直接子实例的端口/);
  assert.throws(() => validateConnection({ from: ordinary.to, to: ordinary.from }), /从输出到输入/);
  assert.throws(() => validateConnection({ to: rj45.to }), /端口类型不匹配/);
  assert.throws(() => validateConnection({ to: { instanceId: 'RX_B', portId: 'MM_IN' } }), /没有共同的光通道/);
  assert.throws(() => validateConnection({ mediaKind: 'RJ45_CABLE' }), /连接介质与端口类型不兼容/);
});

test('a 12-core bundle owns crossed mappings and open attachments independently of WDM', () => {
  const [bundle] = system.cableBundles!;
  const [wdm, reverse, open] = bundle.cores;
  assert.equal(bundle.coreCount, 12);
  assert.deepEqual([[wdm.a.pin, wdm.b.pin], [reverse.a.pin, reverse.b.pin]], [[1, 12], [2, 11]]);
  assert.equal(open.b.endpoint, undefined);
  assert.equal(fullLink.channelId, 'DWDM_CH28');
  const otherChannel: NamedLink = topologyExample.namedLinks[3];
  assert.equal(otherChannel.channelId, 'DWDM_CH30');
  assert.deepEqual(fullLink.via?.[1], otherChannel.via?.[0]);
  validateProject(topologyExample);

  const validateCores = (...cores: CableCore[]) => validateProject(editSystem({ cableBundles: [{ ...bundle, cores }] }));
  assert.throws(() => validateCores({ ...wdm, a: { ...wdm.a, pin: 13 } }), /芯号必须在 1–12 范围内/);
  assert.throws(() => validateCores(wdm, { ...reverse, a: { ...reverse.a, pin: 1 } }), /芯号 1 重复/);
  assert.throws(() => validateCores(wdm, { ...reverse, b: { ...reverse.b, pin: 12 } }), /芯号 12 重复/);
  assert.throws(() => validateCores({ ...wdm, b: { ...wdm.b, endpoint: { instanceId: 'RX_A', portId: 'CONTROL_IN' } } }),
    /纤芯必须接到直接子实例的光端口/);
  assert.throws(() => validateProject(editSystem({ connections: [
    ...system.connections!, { id: 'duplicate', from: wdm.a.endpoint!, to: wdm.b.endpoint! },
  ] })), /同一对端点之间存在重复连接/);
});

test('draft, one-sided and disconnected named links survive validation and names can change', () => {
  validateProject(topologyExample);
  assert.equal(topologyExample.namedLinks[0].name, topologyExample.namedLinks[1].name);
  const renamed = { ...fullLink, name: 'Updated label' };
  validateProject(withLink(renamed));
  assert.equal(renamed.id, fullLink.id);
  assert.throws(() => validateProject(withLink({
    ...fullLink, to: { instancePath: ['RX_A', 'pd'], portId: 'missing' },
  })), /终点端点引用无效/);
  assert.throws(() => validateProject(withLink({ ...fullLink, channelId: 'CWDM_1370' })), /无效的光通道/);
});

test('required connections are scoped to a concrete module occurrence and fibres use their bundle and core IDs', () => {
  validateProject(withLink({
    ...fullLink, via: [
      { scopePath: ['TX_A'], connectionId: 'rf-feed' }, { scopePath: ['TX_B'], connectionId: 'rf-feed' },
      { scopePath: [], bundleId: 'mpo-12', coreId: 'open' },
    ],
  }));
  assert.throws(() => validateProject(withLink({ ...fullLink, via: [{ scopePath: [], connectionId: 'rf-feed' }] })),
    /当前模块中不存在必经连接「rf-feed」/);
  assert.throws(() => validateProject(withLink({ ...fullLink, via: [{ scopePath: ['TX_A', 'mzm'], connectionId: 'rf-feed' }] })),
    /连接所在模块无效/);
  assert.throws(() => validateProject(withLink({ ...fullLink, via: [{ scopePath: [], bundleId: 'mpo-12', coreId: 'missing' }] })),
    /必经纤芯不存在/);
});

test('multiple conversion spans can share a profile with independent overrides and valid EO/OE boundaries', () => {
  const [binding] = fullLink.conversionBindings!;
  const second = {
    ...binding, id: 'span-2',
    eo: { ...binding.eo, instancePath: ['TX_B', 'mzm'] },
    oe: { ...binding.oe, instancePath: ['RX_B', 'pd'] },
    overrides: { k: 2.1, pdPowerRefDbm: -3, rfGainRefDb: { kind: 'fixed' as const, value: -25 } },
  };
  validateProject(withLink({ ...fullLink, conversionBindings: [binding, second] }));
  assert.equal(topologyExample.conversionProfiles[0].pdPowerRefDbm, -2);
  assert.throws(() => validateProject(withLink({ ...fullLink, conversionBindings: [{ ...binding, profileId: 'missing' }] })),
    /标定方案「missing」不存在/);
  assert.throws(() => validateProject(withLink({ ...fullLink, conversionBindings: [{ ...binding, eo: binding.oe }] })),
    /电光转换边界无效/);
  assert.throws(() => validateProject(withLink({ ...fullLink, conversionBindings: [binding, { ...second, oe: binding.oe }] })),
    /此转换边界已绑定/);
  assert.throws(() => validateProject(withLink({ ...fullLink, conversionBindings: [{ ...binding, overrides: { k: Infinity } }] })),
    /覆盖值须为有限数值/);
});
