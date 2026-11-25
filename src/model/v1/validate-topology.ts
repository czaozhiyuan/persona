import type { Connection, LocalEndpointRef, NamedLink } from './topology';
import type { ComponentDefinition, InstancePath, ModuleDefinition, PortDefinition, PortType } from './types';
import { channelSetsOverlap } from './validate-device';
import { validateChannelIds } from './validate-parameters';
import { indexById, requireValid } from './validation';

const mediaTypes: Record<NonNullable<Connection['mediaKind']>, PortType> = {
  OPTICAL_FIBER: 'OPTICAL', RF_COAX: 'RF', RJ45_CABLE: 'CONTROL',
};

export function validateModuleTopology(
  module: ModuleDefinition, resolvePort: (endpoint: LocalEndpointRef) => PortDefinition | undefined,
): void {
  const pairs = new Set<string>();
  const recordPair = (from: LocalEndpointRef, to: LocalEndpointRef, context: string) => {
    const key = JSON.stringify([from.instanceId, from.portId, to.instanceId, to.portId]);
    requireValid(!pairs.has(key), `${context}: 同一对端点之间存在重复连接`);
    pairs.add(key);
  };
  for (const connection of indexById(module.connections ?? [], `模块「${module.id}」的连接`).values()) {
    const context = `模块「${module.id}」的连接「${connection.id}」`;
    const from = resolvePort(connection.from);
    const to = resolvePort(connection.to);
    requireValid(from && to, `${context}: 端点必须是直接子实例的端口`);
    requireValid(from.direction === 'out' && to.direction === 'in', `${context}: 连接方向必须从输出到输入`);
    requireValid(from.type === to.type, `${context}: 两端端口类型不匹配`);
    requireValid(connection.mediaKind === undefined || mediaTypes[connection.mediaKind] === from.type,
      `${context}: 连接介质与端口类型不兼容`);
    requireValid(channelSetsOverlap(from, to), `${context}: 两端没有共同的光通道`);
    recordPair(connection.from, connection.to, context);
  }

  for (const bundle of indexById(module.cableBundles ?? [], `模块「${module.id}」的线缆束`).values()) {
    const context = `模块「${module.id}」中的线缆束「${bundle.id}」`;
    requireValid(Number.isSafeInteger(bundle.coreCount) && bundle.coreCount > 0, `${context}: 纤芯数量无效`);
    const pinsA = new Set<number>(), pinsB = new Set<number>();
    const attachments = new Set<string>();
    for (const core of indexById(bundle.cores, `${context}的纤芯`).values()) {
      const coreContext = `${context}的纤芯「${core.id}」`;
      for (const [side, pins] of [[core.a, pinsA], [core.b, pinsB]] as const) {
        requireValid(Number.isSafeInteger(side.pin) && side.pin >= 1 && side.pin <= bundle.coreCount,
          `${coreContext}: 芯号必须在 1–${bundle.coreCount} 范围内`);
        requireValid(!pins.has(side.pin), `${coreContext}: 同一侧芯号 ${side.pin} 重复`);
        pins.add(side.pin);
        if (side.endpoint) {
          const key = JSON.stringify([side.endpoint.instanceId, side.endpoint.portId]);
          requireValid(!attachments.has(key), `${coreContext}: 该光端口已接入此线缆束`);
          attachments.add(key);
        }
      }
      const a = core.a.endpoint, b = core.b.endpoint;
      const portA = a && resolvePort(a), portB = b && resolvePort(b);
      requireValid((!a || portA?.type === 'OPTICAL') && (!b || portB?.type === 'OPTICAL'),
        `${coreContext}: 纤芯必须接到直接子实例的光端口`);
      if (a && b && portA && portB) {
        requireValid(portA.direction !== portB.direction, `${coreContext}: 纤芯必须连接光输出与光输入端口`);
        requireValid(channelSetsOverlap(portA, portB), `${coreContext}: 两端没有共同的光通道`);
        if (portA.direction === 'out') recordPair(a, b, coreContext);
        else recordPair(b, a, coreContext);
      }
    }
  }
}

export function validateNamedLinks(
  links: readonly NamedLink[],
  definitionAtPath: (path: InstancePath) => ComponentDefinition | ModuleDefinition | undefined,
): void {
  for (const link of indexById(links, '链路').values()) {
    const context = `链路「${link.id}」`;
    if (link.channelId !== undefined) validateChannelIds([link.channelId], context);
    for (const [label, endpoint] of [['起点', link.from], ['终点', link.to]] as const) {
      if (endpoint) requireValid(
        definitionAtPath(endpoint.instancePath)?.ports.some(port => port.id === endpoint.portId),
        `${context}: ${label}端点引用无效`,
      );
    }
    if (link.trial) {
      const { frequencyGHz, inputPowerDbm, opticalSources } = link.trial;
      requireValid(Number.isFinite(frequencyGHz) && frequencyGHz >= 0 && frequencyGHz <= 67
        && (inputPowerDbm === undefined || Number.isFinite(inputPowerDbm)), `${context}：试算频率或射频输入功率无效`);
      const sourceKeys = new Set<string>();
      for (const { endpoint, channelId, powerDbm } of opticalSources ?? []) {
        const owner = definitionAtPath(endpoint.instancePath);
        const port = owner?.ports.find(port => port.id === endpoint.portId);
        requireValid(port?.type === 'OPTICAL' && port.direction === (owner?.kind === 'module' ? 'in' : 'out'),
          `${context}：试算光源端口无效`);
        if (channelId !== undefined) validateChannelIds([channelId], context);
        const key = JSON.stringify([endpoint.instancePath, endpoint.portId, channelId]);
        requireValid(!sourceKeys.has(key) && (powerDbm === undefined || Number.isFinite(powerDbm)),
          `${context}：试算光源重复或功率无效`);
        sourceKeys.add(key);
      }
    }
    for (const ref of link.via ?? []) {
      const scope = definitionAtPath(ref.scopePath);
      requireValid(scope?.kind === 'module', `${context}: 连接所在模块无效`);
      if ('bundleId' in ref) {
        const bundle = scope.cableBundles?.find(item => item.id === ref.bundleId);
        requireValid(bundle?.cores.some(core => core.id === ref.coreId), `${context}: 必经纤芯不存在`);
      } else {
        requireValid(scope.connections?.some(connection => connection.id === ref.connectionId),
          `${context}: 当前模块中不存在必经连接「${ref.connectionId}」`);
      }
    }

  }
}
