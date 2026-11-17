import { CHANNELS } from './channels';
import { endpoint as ep, fixed as f, type ComponentDefinition, type Connection, type Instance, type Port, type Project } from './types';

const port = (id: string, type: Port['type'], direction: Port['direction'], channels?: string[]): Port => ({ id, type, direction, ...(channels ? { channels } : {}) });
const opticalTable = (ch28: number, ch30: number) => ({ kind: 'channel' as const, values: { DWDM_CH28: ch28, DWDM_CH30: ch30 } });
const instance = (id: string, name: string, definitionId: string, overrides: Instance['overrides'] = {}): Instance => ({ id, name, definitionId, overrides });
const conn = (id: string, a: string, ap: string, b: string, bp: string, gain = 0): Connection => ({ id, from: ep(a, ap), to: ep(b, bp), gainDb: f(gain) });
const component = (id: string, name: string, ports: Port[], transfers: ComponentDefinition['transfers'] = [], params: ComponentDefinition['params'] = {}, width = 40, depth = 28): ComponentDefinition => ({ id, name, ports, transfers, params, size: { width, depth } });

export function createExample(): Project {
  const instances = [
    instance('input28', 'RF 输入 28', 'rfSource'), instance('input30', 'RF 输入 30', 'rfSource'),
    instance('tx28', '发射模块 CH28', 'TX_Module'),
    instance('tx30', '发射模块 CH30', 'TX_Module', { channel: 'DWDM_CH30', laserPowerDbm: f(8) }),
    instance('mux', 'WDM 合波器', 'mux'), instance('attenuator', '通道光增益 / 衰减', 'attenuator'),
    instance('demux', 'WDM 分波器', 'demux'),
    instance('pd28', 'PD CH28', 'pd', { channel: 'DWDM_CH28' }), instance('pd30', 'PD CH30', 'pd', { channel: 'DWDM_CH30' }),
    instance('output28', 'RF 输出 28', 'rfSink'), instance('output30', 'RF 输出 30', 'rfSink'),
    instance('pcb', '多端口 PCB', 'pcb'), instance('amp', 'RF 后级', 'amp'),
    instance('power', '电源', 'power'), instance('control', '控制器', 'control'),
  ];
  const physical: Project['layout']['physical'] = {
    'tx28/laser': { x: 25, y: 35, rotation: 0 }, 'tx28/mzm': { x: 95, y: 35, rotation: 0 },
    'tx30/laser': { x: 25, y: 115, rotation: 0 }, 'tx30/mzm': { x: 95, y: 115, rotation: 0 },
    mux: { x: 170, y: 70, rotation: 0 }, attenuator: { x: 235, y: 70, rotation: 0 },
    demux: { x: 300, y: 70, rotation: 0 }, pd28: { x: 365, y: 35, rotation: 0 }, pd30: { x: 365, y: 115, rotation: 0 },
    pcb: { x: 120, y: 205, rotation: 0 }, amp: { x: 290, y: 205, rotation: 0 },
    power: { x: 25, y: 270, rotation: 0 }, control: { x: 350, y: 270, rotation: 0 },
  };
  const topology = Object.fromEntries(instances.map((item, i) => [item.id, { x: (i % 5) * 240, y: Math.floor(i / 5) * 210 }]));
  Object.assign(topology, {
    input28: { x: 0, y: 0 }, tx28: { x: 230, y: 0 }, input30: { x: 0, y: 200 }, tx30: { x: 230, y: 200 },
    mux: { x: 470, y: 90 }, attenuator: { x: 720, y: 90 }, demux: { x: 970, y: 90 },
    pd28: { x: 1220, y: 0 }, pd30: { x: 1220, y: 200 }, output28: { x: 1450, y: 0 }, output30: { x: 1450, y: 200 },
    power: { x: 0, y: 440 }, pcb: { x: 470, y: 410 }, amp: { x: 970, y: 440 }, control: { x: 0, y: 640 },
    'tx28/laser': { x: 230, y: -180 }, 'tx28/mzm': { x: 470, y: -180 },
    'tx30/laser': { x: 230, y: 450 }, 'tx30/mzm': { x: 230, y: 650 },
  });
  return {
    schemaVersion: 1, name: '1U · 双通道光电传输验证', chassis: { width: 440, depth: 350, height: 44.45 },
    channels: structuredClone(CHANNELS),
    components: [
      component('laser', '激光器', [port('opt', 'OPTICAL', 'out')], [], { powerDbm: f(6), channel: 'DWDM_CH28' }),
      component('mzm', 'MZM', [port('rf', 'RF', 'in'), port('laser', 'OPTICAL', 'in'), port('opt', 'OPTICAL', 'out')],
        [{ from: 'rf', to: 'opt', kind: 'eo', supplyPort: 'laser' }], { opticalGainDb: f(-4), channel: 'DWDM_CH28' }),
      component('pd', 'PD', [port('opt', 'OPTICAL', 'in'), port('rf', 'RF', 'out')], [{ from: 'opt', to: 'rf', kind: 'oe' }], { channel: 'DWDM_CH28' }),
      component('rfSource', 'RF 输入', [port('rf', 'RF', 'out')]),
      component('rfSink', 'RF 输出', [port('rf', 'RF', 'in')]),
      component('mux', 'MUX', [port('ch28', 'OPTICAL', 'in', ['DWDM_CH28']), port('ch30', 'OPTICAL', 'in', ['DWDM_CH30']), port('line', 'OPTICAL', 'out')],
        [{ from: 'ch28', to: 'line', kind: 'optical', channels: ['DWDM_CH28'], gainDb: opticalTable(-1, -1) },
          { from: 'ch30', to: 'line', kind: 'optical', channels: ['DWDM_CH30'], gainDb: opticalTable(-1, -1) }]),
      component('demux', 'DEMUX', [port('line', 'OPTICAL', 'in'), port('ch28', 'OPTICAL', 'out', ['DWDM_CH28']), port('ch30', 'OPTICAL', 'out', ['DWDM_CH30'])],
        [{ from: 'line', to: 'ch28', kind: 'optical', channels: ['DWDM_CH28'], gainDb: opticalTable(-1, -1) },
          { from: 'line', to: 'ch30', kind: 'optical', channels: ['DWDM_CH30'], gainDb: opticalTable(-1, -1) }]),
      component('attenuator', '光增益 / 衰减', [port('in', 'OPTICAL', 'in'), port('out', 'OPTICAL', 'out')],
        [{ from: 'in', to: 'out', kind: 'optical', gainDb: opticalTable(0, 0) }]),
      component('pcb', 'PCB 黑盒', [port('RF_IN', 'RF', 'in'), port('RF_OUT', 'RF', 'out'), port('OPT_IN', 'OPTICAL', 'in'), port('OPT_OUT', 'OPTICAL', 'out'), port('DC_IN', 'DC_POWER', 'in'), port('CTRL_IN', 'CONTROL', 'in'), port('RF_SPARE', 'RF', 'out')],
        [{ from: 'RF_IN', to: 'RF_OUT', kind: 'rf', gainDb: { kind: 'rf', points: [[1, 10], [3, 14], [5, 12]] }, nfDb: f(3) },
          { from: 'OPT_IN', to: 'OPT_OUT', kind: 'optical', gainDb: opticalTable(-1.5, -2) }], {}, 100, 60),
      component('amp', 'RF 放大器', [port('in', 'RF', 'in'), port('out', 'RF', 'out')], [{ from: 'in', to: 'out', kind: 'rf', gainDb: f(6), nfDb: f(4) }]),
      component('power', 'DC 电源', [port('out', 'DC_POWER', 'out')], [], {}, 60, 40),
      component('control', '控制器', [port('out', 'CONTROL', 'out')]),
    ],
    modules: [{ id: 'TX_Module', name: 'TX_Module', ports: [port('rf', 'RF', 'in'), port('opt', 'OPTICAL', 'out')],
      instances: [instance('laser', '激光器', 'laser'), instance('mzm', 'MZM', 'mzm')],
      connections: [conn('laser-feed', 'laser', 'opt', 'mzm', 'laser')],
      mappings: [{ portId: 'rf', target: ep('mzm', 'rf') }, { portId: 'opt', target: ep('mzm', 'opt') }],
      overrides: { laserPowerDbm: [{ instanceId: 'laser', parameter: 'powerDbm' }],
        channel: [{ instanceId: 'laser', parameter: 'channel' }, { instanceId: 'mzm', parameter: 'channel' }] },
    }],
    instances,
    connections: [
      conn('rf-in28', 'input28', 'rf', 'tx28', 'rf'), conn('rf-in30', 'input30', 'rf', 'tx30', 'rf'),
      conn('tx-mux28', 'tx28', 'opt', 'mux', 'ch28'), conn('tx-mux30', 'tx30', 'opt', 'mux', 'ch30'),
      conn('mux-attenuator', 'mux', 'line', 'attenuator', 'in'),
      conn('shared-fiber', 'attenuator', 'out', 'demux', 'line', -2),
      conn('demux-pd28', 'demux', 'ch28', 'pd28', 'opt'), conn('demux-pd30', 'demux', 'ch30', 'pd30', 'opt'),
      conn('rf-out28', 'pd28', 'rf', 'output28', 'rf'), conn('rf-out30', 'pd30', 'rf', 'output30', 'rf'),
      conn('pcb-amp', 'pcb', 'RF_OUT', 'amp', 'in'), conn('dc-pcb', 'power', 'out', 'pcb', 'DC_IN'), conn('ctrl-pcb', 'control', 'out', 'pcb', 'CTRL_IN'),
      conn('tx-pcb-opt', 'tx28', 'opt', 'pcb', 'OPT_IN'),
    ],
    links: [
      { id: 'link28', name: 'RF_CH28', from: ep('input28', 'rf'), to: ep('output28', 'rf'), channelId: 'DWDM_CH28', viaConnectionIds: ['shared-fiber'], conversion: { gainRefDb: -22, powerRefDbm: -2, k: 2 } },
      { id: 'link30', name: 'RF_CH30', from: ep('input30', 'rf'), to: ep('output30', 'rf'), channelId: 'DWDM_CH30', viaConnectionIds: ['shared-fiber'], conversion: { gainRefDb: -22, powerRefDbm: 0, k: 2 } },
      { id: 'rf-scan', name: 'PCB → RF 后级 · 扫频 / NF', from: ep('pcb', 'RF_IN'), to: ep('amp', 'out') },
      { id: 'unconnected', name: '未定义关系 · 应无法连通', from: ep('pcb', 'RF_IN'), to: ep('pcb', 'RF_SPARE') },
      { id: 'pcb-optical', name: 'PCB 光端口 · 插损验证', from: ep('tx28', 'opt'), to: ep('pcb', 'OPT_OUT'), channelId: 'DWDM_CH28' },
    ], layout: { physical, topology },
  };
}
