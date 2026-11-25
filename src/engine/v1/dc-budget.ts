import type { DcCapacity, DcValue } from '../../model/v1/device';
import { isPowerPort, isSupplyOutput } from '../../model/v1/types';
import type { EndpointRef, Project } from '../../model/v1/types';
import { budgetValue, checkInputRating, unavailable } from './budget-metric';
import type { BudgetMetric, InputRatingCheck } from './budget-metric';
import { resolveEmpiricalValue } from './empirical-value';
import type { ResolvedInstance } from './hierarchy';
import { buildSignalGraph } from './signal-graph';
import type { SignalPort } from './signal-graph';

type Diagnostic = {
  code: 'open_input' | 'feedback' | 'missing_parameter' | 'unknown_load' | 'voltage_conflict';
  endpoint: EndpointRef;
  reason: string;
};
type Watts = BudgetMetric<'W'>;
type Volts = BudgetMetric<'V'>;
type Demand = { knownW: number; reason?: string };
type DcPortBudget = {
  endpoint: EndpointRef; voltageV: Volts; demandW: Watts; knownDemandW: Watts; rating?: InputRatingCheck;
};
type Capacity = { capacityW: Watts; marginW: Watts; capacityStatus: 'within_capacity' | 'over_capacity' | 'unknown' };
type DcOutputBudget = DcPortBudget & Capacity;
type NetworkBudget = DcOutputBudget & {
  type: 'AC_POWER' | 'DC_POWER'; ports: EndpointRef[]; sources: EndpointRef[]; knownCapacityW: Watts;
};
export type DcBudget = {
  networks: readonly NetworkBudget[];
  ports: readonly DcPortBudget[];
  supplies: readonly DcOutputBudget[];
  converters: readonly {
    input: EndpointRef; output: DcOutputBudget; efficiency: BudgetMetric<'ratio'>; inputDemandW: Watts;
  }[];
  loads: readonly { endpoint: EndpointRef; powerW: Watts }[];
  diagnostics: readonly Diagnostic[];
};

type Node = {
  port: SignalPort; instance: ResolvedInstance; neighbors: Set<Node>; mappedInside: Set<Node>;
  source: boolean; load?: Watts; ownDemand: Demand;
};
type Converter = { input: Node; output: Node; efficiency: BudgetMetric<'ratio'>; capacity?: DcCapacity; inputDemand: Demand };
type Net = {
  nodes: Node[]; sources: Node[]; inputs: Converter[]; outputs: Converter[];
  voltage: Volts; fed: boolean; demand: Demand;
};

const noFeed = '该供电网络尚未接入电源。';
const feedback = '直流供电存在回路：变换器输出反馈至输入，供电及需求不能确定。';
const unallocated = '并联输出网按总容量核算，单个电源的实际输出功率未分配。';
const unmetered = '并联输出网未设置单路分担，无法反推该变换器的输入需求。';

function addDemand(total: Demand, item: Demand) {
  total.knownW += item.knownW;
  total.reason ??= item.reason;
}
function quantity(metric: Watts): Demand {
  return metric.availability === 'available' ? { knownW: metric.value } : { knownW: 0, reason: metric.reason };
}
function demandMetric({ knownW, reason }: Demand): Watts {
  return reason === undefined ? budgetValue('W', knownW) : unavailable('W', reason);
}
function convertDemand(demand: Demand, efficiency: BudgetMetric<'ratio'>): Demand {
  return efficiency.availability === 'unavailable' ? { knownW: 0, reason: efficiency.reason }
    : { knownW: demand.knownW / efficiency.value, reason: demand.reason };
}
function capacityResult(capacityW: Watts, demandW: Watts, voltage: Volts): Capacity {
  const marginW = capacityW.availability === 'unavailable' ? capacityW : demandW.availability === 'unavailable' ? demandW
    : voltage.availability === 'unavailable' ? unavailable('W', voltage.reason) : budgetValue('W', capacityW.value - demandW.value);
  return { capacityW, marginW, capacityStatus: marginW.availability === 'unavailable' ? 'unknown'
    : marginW.value < 0 ? 'over_capacity' : 'within_capacity' };
}

/** Physical conductors form equipotential nets. Only a converter introduces a directed dependency. */
export function calculateDcBudget(project: Project): DcBudget {
  const graph = buildSignalGraph(project);
  const instances = new Map(graph.instances.map(item => [JSON.stringify(item.instancePath), item]));
  const diagnostics: Diagnostic[] = [];
  const report = (node: Node, code: Diagnostic['code'], reason: string) =>
    diagnostics.push({ code, endpoint: node.port.ref, reason });
  function evaluate<Unit extends 'V' | 'W' | 'A' | 'ratio'>(node: Node, unit: Unit, value: DcValue | undefined, label: string) {
    const metric = resolveEmpiricalValue(unit, value, {}, node.instance);
    if (metric.availability === 'available') return metric;
    const reason = `${label}：${metric.reason}`;
    report(node, 'missing_parameter', reason);
    return unavailable(unit, reason);
  }

  const nodes = new Map<SignalPort, Node>();
  for (const port of graph.ports.values()) {
    if (!isPowerPort(port.definition.type)) continue;
    const instance = instances.get(JSON.stringify(port.ref.instancePath))!, d = instance.definition;
    const ac = port.definition.type === 'AC_POWER';
    const node: Node = { port, instance, neighbors: new Set(), mappedInside: new Set(), ownDemand: { knownW: 0 },
      source: d.kind === 'component' && (isSupplyOutput(d, port.definition) || (ac && port.definition.direction === 'out')) };
    nodes.set(port, node);
    if (d.kind === 'component' && (d.dcLoad?.portId === port.ref.portId || port.definition.acLoadW !== undefined)) {
      node.load = evaluate(node, 'W', ac ? port.definition.acLoadW : d.dcLoad?.powerW, '负载需求');
    }
  }
  const converters: Converter[] = [];
  for (const { from, to, source } of graph.edges) {
    const a = nodes.get(from), b = nodes.get(to);
    if (!a || !b) continue;
    if (source.kind === 'transfer' && source.transfer.kind === 'dc') {
      converters.push({ input: a, output: b, efficiency: evaluate(a, 'ratio', source.transfer.efficiency, '直流变换效率'),
        capacity: source.transfer.capacity, inputDemand: { knownW: 0, reason: feedback } });
    } else if (source.kind === 'connection' || source.kind === 'portMapping') {
      a.neighbors.add(b);
      b.neighbors.add(a);
      if (source.kind === 'portMapping') {
        if (source.publicPort === from.ref) a.mappedInside.add(b);
        else b.mappedInside.add(a);
      }
    }
  }

  const nets: Net[] = [], netAt = new Map<Node, Net>();
  for (const node of nodes.values()) {
    if (netAt.has(node)) continue;
    const net: Net = { nodes: [node], sources: [], inputs: [], outputs: [], fed: false,
      voltage: unavailable('V', noFeed), demand: { knownW: 0 } };
    nets.push(net);
    netAt.set(node, net);
    for (const current of net.nodes) {
      if (current.source) net.sources.push(current);
      for (const next of current.neighbors) if (!netAt.has(next)) {
        netAt.set(next, net);
        net.nodes.push(next);
      }
    }
  }
  const converterInputs = new Set<Node>();
  const converterOutputs = new Set<Node>();
  for (const c of converters) {
    netAt.get(c.input)!.outputs.push(c);
    netAt.get(c.output)!.inputs.push(c);
    converterInputs.add(c.input);
    converterOutputs.add(c.output);
  }

  const pending = new Map(nets.map(n => [n, n.inputs.length]));
  const ordered = nets.filter(n => n.inputs.length === 0);
  for (const net of ordered) {
    const declaredVoltages = new Set<number>();
    let missing: string | undefined;
    function noteVoltage(v: Volts) {
      if (v.availability === 'available') declaredVoltages.add(v.value);
      else missing ??= v.reason;
    }
    net.fed = net.sources.length > 0;
    for (const node of net.sources) noteVoltage(evaluate(node, 'V', node.port.definition.outputVoltageV, '供电电压'));
    for (const c of net.inputs) {
      const upstream = netAt.get(c.input)!;
      if (!upstream.fed) continue;
      net.fed = true;
      noteVoltage(upstream.voltage.availability === 'available'
        ? evaluate(c.output, 'V', c.output.port.definition.outputVoltageV, '直流变换器输出电压') : upstream.voltage);
    }
    if (net.fed) {
      for (const node of net.nodes) {
        if (!node.source && !converterOutputs.has(node) && node.port.definition.outputVoltageV) {
          noteVoltage(evaluate(node, 'V', node.port.definition.outputVoltageV, '输出电压'));
        }
      }
      if (declaredVoltages.size > 1) {
        const listed = [...declaredVoltages].sort((a, b) => b - a).map(v => v + ' V').join('、');
        const reason = `网络标称输出电压不一致（${listed}），无法确定有效供电电压。`;
        net.voltage = unavailable('V', reason);
        report(net.sources[0] ?? net.nodes[0], 'voltage_conflict', reason);
      } else if (missing) net.voltage = unavailable('V', missing);
      else if (declaredVoltages.size) net.voltage = budgetValue('V', [...declaredVoltages][0]);
    }
    for (const c of net.outputs) {
      const next = netAt.get(c.output)!, remaining = pending.get(next)! - 1;
      pending.set(next, remaining);
      if (!remaining) ordered.push(next);
    }
  }

  for (const net of nets) {
    const cyclic = !!pending.get(net);
    if (cyclic) {
      net.voltage = unavailable('V', feedback);
      net.demand.reason = feedback;
      report(net.inputs[0].output, 'feedback', feedback);
    }
    for (const node of net.nodes) {
      if (node.load) node.ownDemand = quantity(node.load);
      else if (node.port.definition.direction === 'in' && !converterInputs.has(node)
        && (!node.port.modulePort || (node.port.unmapped && node.neighbors.size))) {
        const reason = node.port.definition.type === 'AC_POWER' ? '交流输入负载功耗未建模。' : '直流输入未声明负载功耗。';
        node.ownDemand.reason = reason;
        report(node, 'unknown_load', reason);
      }
      if (!cyclic && !net.fed && (node.load || converterInputs.has(node) || node.port.definition.inputRating)) {
        report(node, 'open_input', net.voltage.availability === 'unavailable' ? net.voltage.reason : noFeed);
      }
      if (node.port.definition.inputVoltageV && net.voltage.availability === 'available') {
        const expected = evaluate(node, 'V', node.port.definition.inputVoltageV, '标称输入电压');
        if (expected.availability === 'available' && expected.value !== net.voltage.value) {
          report(node, 'voltage_conflict', `标称输入 ${expected.value} V 与网络供电 ${net.voltage.value} V 不一致。`);
        }
      }
      addDemand(net.demand, node.ownDemand);
    }
    if (net.nodes[0].port.definition.type === 'AC_POWER' && net.nodes.every(n => !n.load)) {
      net.demand.reason ??= '交流负载功耗未建模。';
    }
  }

  for (const c of converters) if (pending.get(netAt.get(c.output)!)) {
    netAt.get(c.input)!.demand.reason ??= feedback;
    c.input.ownDemand.reason ??= feedback;
  }
  // Demand crosses a converter once. Parallel converters have no individual load share by default.
  for (let i = ordered.length - 1; i >= 0; i--) {
    const net = ordered[i];
    if (!net.inputs.length) continue;
    const supplying = net.inputs.filter(c => !net.fed || netAt.get(c.input)!.fed);
    const only = supplying.length === 1 && !net.sources.length;
    for (const c of net.inputs) {
      if ((net.fed && !netAt.get(c.input)!.fed) || (!net.demand.reason && net.demand.knownW === 0)) c.inputDemand = { knownW: 0 };
      else c.inputDemand = only ? convertDemand(net.demand, c.efficiency) : { knownW: 0, reason: unmetered };
      addDemand(c.input.ownDemand, c.inputDemand);
    }
    if (!supplying.length) continue;
    const first = supplying[0];
    const commonInput = netAt.get(first.input)!;
    const eta = first.efficiency.availability === 'available' ? first.efficiency.value : undefined;
    const common = !net.sources.length && supplying.every(c => netAt.get(c.input) === commonInput
      && c.efficiency.availability === 'available' && c.efficiency.value === eta);
    if (common && !only) addDemand(commonInput.demand, convertDemand(net.demand, first.efficiency));
    else for (const c of supplying) addDemand(netAt.get(c.input)!.demand, c.inputDemand);
  }

  function ratedCapacity(node: Node, capacity?: DcCapacity): Watts {
    if (capacity?.unit !== 'A') return evaluate(node, 'W', capacity?.value, '额定输出功率');
    const amps = evaluate(node, 'A', capacity.value, '额定输出电流');
    if (amps.availability === 'unavailable') return unavailable('W', amps.reason);
    const v = netAt.get(node)!.voltage;
    if (v.availability === 'available') return budgetValue('W', amps.value * v.value);
    const reason = '需要相应的输出电压，才能将额定输出电流换算为功率。';
    report(node, 'missing_parameter', reason);
    return unavailable('W', reason);
  }

  const outputs = new Map<Node, DcOutputBudget>();
  const networks: NetworkBudget[] = nets.map(net => {
    const sources = new Map(net.sources.map(node => [node, node.port.definition.supplyCapacity as DcCapacity | undefined]));
    const activeSources = new Set(net.sources);
    for (const c of net.inputs) {
      sources.set(c.output, c.capacity);
      if (netAt.get(c.input)!.fed) activeSources.add(c.output);
    }
    const total: Demand = { knownW: 0 }, demandW = demandMetric(net.demand), knownDemandW = budgetValue('W', net.demand.knownW);
    for (const [node, cap] of sources) {
      const rating = ratedCapacity(node, cap);
      const active = activeSources.has(node);
      if (active) addDemand(total, quantity(rating));
      const only = active ? activeSources.size === 1 : sources.size === 1;
      const offline = !active && net.fed;
      const individual = offline ? budgetValue('W', 0) : only ? demandW : unavailable('W', unallocated);
      outputs.set(node, { endpoint: node.port.ref, voltageV: net.voltage, demandW: individual,
        knownDemandW: offline ? individual : only ? knownDemandW : unavailable('W', unallocated),
        ...capacityResult(rating, individual, offline ? unavailable('V', noFeed) : net.voltage) });
    }
    const capacity = net.fed ? demandMetric(total) : unavailable('W', '尚无有效供电来源。');
    const endpoint = (net.sources[0] ?? net.inputs[0]?.output ?? net.nodes[0]).port.ref;
    return { endpoint, ports: net.nodes.map(n => n.port.ref), sources: [...activeSources].map(n => n.port.ref),
      type: net.nodes[0].port.definition.type as NetworkBudget['type'], voltageV: net.voltage, demandW, knownDemandW,
      knownCapacityW: budgetValue('W', total.knownW), ...capacityResult(capacity, demandW, net.voltage) };
  });

  function demandAt(node: Node) {
    if (!node.port.modulePort || !node.mappedInside.size) return node.ownDemand;
    // A boundary carries its enclosed demand only if the inner side has no other feed or return path.
    const inside = node.port.ref.instancePath;
    const seen = new Set([node]), pending = [...node.mappedInside];
    const sum: Demand = { knownW: 0 };
    for (const item of pending) {
      if (seen.has(item)) continue;
      seen.add(item);
      const path = item.port.ref.instancePath;
      if (item.source || outputs.has(item) || path.length < inside.length || !inside.every((id, i) => path[i] === id)) {
        return { knownW: 0, reason: '并联网络未分配此端口的支路功率。' };
      }
      addDemand(sum, item.ownDemand);
      for (const next of item.neighbors) if (!seen.has(next)) pending.push(next);
    }
    return sum;
  }
  function portBudget(node: Node): DcPortBudget {
    const net = netAt.get(node)!;
    const output = outputs.get(node);
    if (output) return output;
    const d = demandAt(node), demandW = demandMetric(d), limits = node.port.definition.inputRating;
    let rating: InputRatingCheck | undefined;
    if (limits) {
      const voltage = net.voltage;
      const power = net.fed && !pending.get(net) ? demandW : unavailable('W', noFeed);
      const current = node.port.definition.type === 'DC_POWER' && power.availability === 'available' && voltage.availability === 'available'
        ? budgetValue('A', power.value / voltage.value) : unavailable('A', '需要已知的有效电压和对应端口的功率；未建模交流电流。');
      rating = checkInputRating(node.port.ref, limits, limits.unit === 'V' ? voltage : limits.unit === 'A' ? current : power);
    }
    return { endpoint: node.port.ref, voltageV: net.voltage, demandW, knownDemandW: budgetValue('W', d.knownW), rating };
  }
  return {
    networks, ports: [...nodes.values()].map(portBudget),
    supplies: [...nodes.values()].filter(n => n.source).map(n => outputs.get(n)!),
    converters: converters.map(c => ({ input: c.input.port.ref, output: outputs.get(c.output)!,
      efficiency: c.efficiency, inputDemandW: demandMetric(c.inputDemand) })),
    loads: [...nodes.values()].flatMap(n => n.load ? [{ endpoint: n.port.ref, powerW: n.load }] : []),
    diagnostics,
  };
}
