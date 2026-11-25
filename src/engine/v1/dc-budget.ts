import type { DcCapacity, DcValue } from '../../model/v1/device';
import { isSupplyOutput } from '../../model/v1/types';
import type { EndpointRef, Project } from '../../model/v1/types';
import { budgetValue, checkInputRating, unavailable } from './budget-metric';
import type { BudgetMetric, InputRatingCheck } from './budget-metric';
import { resolveEmpiricalValue } from './empirical-value';
import type { ResolvedInstance } from './hierarchy';
import { buildSignalGraph, signalPortKey } from './signal-graph';
import type { SignalPort } from './signal-graph';

type Diagnostic = {
  code: 'open_input' | 'ambiguous_input' | 'feedback' | 'missing_parameter' | 'unknown_load' | 'voltage_conflict';
  endpoint: EndpointRef;
  reason: string;
};

type Demand = { knownW: number; reason?: string };

type DcPortBudget = {
  endpoint: EndpointRef;
  voltageV: BudgetMetric<'V'>;
  demandW: BudgetMetric<'W'>;
  knownDemandW: BudgetMetric<'W'>;
  rating?: InputRatingCheck;
};

type DcOutputBudget = DcPortBudget & {
  capacityW: BudgetMetric<'W'>;
  marginW: BudgetMetric<'W'>;
  capacityStatus: 'within_capacity' | 'over_capacity' | 'unknown';
};

export type DcBudget = {
  ports: readonly DcPortBudget[];
  supplies: readonly DcOutputBudget[];
  converters: readonly {
    input: EndpointRef; output: DcOutputBudget; efficiency: BudgetMetric<'ratio'>; inputDemandW: BudgetMetric<'W'>;
  }[];
  loads: readonly { endpoint: EndpointRef; powerW: BudgetMetric<'W'> }[];
  diagnostics: readonly Diagnostic[];
};

type Conversion = { efficiency: BudgetMetric<'ratio'>; voltageV: BudgetMetric<'V'>; capacity?: DcCapacity };
type Arc = { from: Node; to: Node; conversion?: Conversion };
type ConverterArc = Arc & { conversion: Conversion };
type Node = {
  port: SignalPort;
  instance: ResolvedInstance;
  incoming: Arc[];
  outgoing: Arc[];
  scheduled: boolean;
  feed: 'open' | 'ambiguous' | 'known';
  voltageV: BudgetMetric<'V'>;
  load?: BudgetMetric<'W'>;
  supply?: { voltageV: BudgetMetric<'V'>; capacity?: DcCapacity };
  demand: Demand;
};

const noFeed = '该端口没有可唯一确定的直流供电。';
const feedback = '直流供电存在回路，无法计算该端口的供电或需求。';

function demandMetric({ knownW, reason }: Demand): BudgetMetric<'W'> {
  return reason === undefined ? budgetValue('W', knownW) : unavailable('W', reason);
}

/** Budgets the physical DC network once per resolved instance, independently of signal links. */
export function calculateDcBudget(project: Project): DcBudget {
  const graph = buildSignalGraph(project);
  const instances = new Map(graph.instances.map(item => [JSON.stringify(item.instancePath), item]));
  const diagnostics: Diagnostic[] = [];
  const nodes = new Map<SignalPort, Node>();
  const report = (node: Node, code: Diagnostic['code'], reason: string) =>
    diagnostics.push({ code, endpoint: node.port.ref, reason });

  function evaluate<Unit extends 'V' | 'W' | 'A' | 'ratio'>(node: Node, unit: Unit, value: DcValue | undefined, label: string) {
    const metric = resolveEmpiricalValue(unit, value, {}, node.instance);
    if (metric.availability === 'available') return metric;
    const reason = `${label}: ${metric.reason}`;
    report(node, 'missing_parameter', reason);
    return unavailable(unit, reason);
  }

  for (const port of graph.ports.values()) {
    if (port.definition.type !== 'DC_POWER') continue;
    const instance = instances.get(JSON.stringify(port.ref.instancePath))!;
    const node: Node = { port, instance, incoming: [], outgoing: [], scheduled: false, feed: 'open',
      voltageV: unavailable('V', noFeed), demand: { knownW: 0 } };
    nodes.set(port, node);
    if (instance.definition.kind !== 'component') continue;
    const { dcLoad } = instance.definition;
    if (isSupplyOutput(instance.definition, port.definition)) {
      node.supply = { voltageV: evaluate(node, 'V', port.definition.outputVoltageV, '供电电压'), capacity: port.definition.supplyCapacity };
    }
    if (dcLoad?.portId === port.ref.portId) {
      node.load = evaluate(node, 'W', dcLoad.powerW, '负载需求');
    }
  }

  const converters: ConverterArc[] = [];
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;
    let arc: Arc = { from, to };
    if (edge.source.kind === 'transfer' && edge.source.transfer.kind === 'dc') {
      const { efficiency, capacity } = edge.source.transfer;
      const converter = { from, to, conversion: {
        efficiency: evaluate(from, 'ratio', efficiency, '直流变换效率'),
        voltageV: evaluate(to, 'V', to.port.definition.outputVoltageV, '直流变换器输出电压'), capacity,
      } };
      arc = converter;
      converters.push(converter);
    }
    from.outgoing.push(arc);
    to.incoming.push(arc);
  }
  // Topological order keeps independent feeds evaluable, while cycles and their dependent ports stay unresolved.
  const pending = new Map([...nodes.values()].map(node => [node, node.incoming.length]));
  const ordered = [...pending].filter(([, count]) => count === 0).map(([node]) => node);
  for (const node of ordered) {
    node.scheduled = true;
    if (node.supply) {
      node.feed = 'known';
      node.voltageV = node.supply.voltageV;
    } else if (node.incoming.length === 1) {
      const feed = node.incoming[0];
      node.feed = feed.from.feed;
      node.voltageV = feed.from.voltageV;
      if (feed.conversion) {
        if (node.voltageV.availability === 'available') node.voltageV = feed.conversion.voltageV;
      } else if (node.feed === 'known' && node.port.definition.outputVoltageV !== undefined) {
        // A passive output can declare the voltage of an existing feed, but cannot change a known upstream voltage.
        const declared = evaluate(node, 'V', node.port.definition.outputVoltageV, '输出电压');
        if (node.voltageV.availability === 'available' && declared.availability === 'available'
          && node.voltageV.value !== declared.value) {
          const reason = `端口声明 ${declared.value} V，与上游供电 ${node.voltageV.value} V 不一致。`;
          node.feed = 'ambiguous';
          node.voltageV = unavailable('V', reason);
          report(node, 'voltage_conflict', reason);
        } else {
          node.voltageV = declared;
        }
      }
    } else if (node.incoming.length > 1) {
      const reason = '该端口存在多路直流供电，无法确定负载分配。';
      node.feed = 'ambiguous';
      node.voltageV = unavailable('V', reason);
      report(node, 'ambiguous_input', reason);
    }
    for (const { to } of node.outgoing) {
      const remaining = pending.get(to)! - 1;
      pending.set(to, remaining);
      if (remaining === 0) ordered.push(to);
    }
  }

  for (const node of nodes.values()) {
    if (!node.scheduled) {
      node.voltageV = unavailable('V', feedback);
      node.demand = { knownW: node.load?.availability === 'available' ? node.load.value : 0, reason: feedback };
      report(node, 'feedback', feedback);
    } else if (node.feed === 'open'
      && (node.load || node.outgoing.some(edge => edge.conversion) || node.port.definition.inputRating)) {
      report(node, 'open_input', node.voltageV.availability === 'unavailable' ? node.voltageV.reason : noFeed);
    }
  }

  function contribution(arc: Arc): Demand {
    const { to, conversion } = arc;
    if (!to.scheduled) return { knownW: 0, reason: feedback };
    if (to.incoming.length > 1) return { knownW: 0, reason: '下游负载的供电分配不明确。' };
    if (conversion === undefined) return to.demand;
    const { efficiency } = conversion;
    if (efficiency.availability === 'unavailable') return { knownW: 0, reason: efficiency.reason };
    return { knownW: to.demand.knownW / efficiency.value, reason: to.demand.reason };
  }

  for (let i = ordered.length - 1; i >= 0; i--) {
    const node = ordered[i];
    let knownW = 0;
    let reason: string | undefined;
    if (node.load?.availability === 'available') knownW = node.load.value;
    else if (node.load?.availability === 'unavailable') reason = node.load.reason;
    else if (node.port.definition.direction === 'in' && (node.incoming.length || node.instance.definition.kind === 'component') && !node.outgoing.length) {
      reason = '直流输入未声明负载，也没有后续供电路径。';
      report(node, 'unknown_load', reason);
    }
    for (const edge of node.outgoing) {
      const branch = contribution(edge);
      knownW += branch.knownW;
      reason ??= branch.reason;
    }
    node.demand = { knownW, reason };
  }

  function portBudget(node: Node): DcPortBudget {
    const { ref, definition } = node.port;
    const demandW = demandMetric(node.demand);
    let rating: InputRatingCheck | undefined;
    if (definition.inputRating) {
      const inputPower = node.feed === 'known' ? demandW : unavailable('W',
        node.voltageV.availability === 'unavailable' ? node.voltageV.reason : noFeed);
      const current = inputPower.availability === 'available' && node.voltageV.availability === 'available'
        ? budgetValue('A', inputPower.value / node.voltageV.value) : unavailable('A', '计算直流电流需要已知的电压和输入功率。');
      const input = definition.inputRating.unit === 'V' ? node.voltageV : definition.inputRating.unit === 'A' ? current : inputPower;
      rating = checkInputRating(ref, definition.inputRating, input);
    }
    return { endpoint: ref, voltageV: node.voltageV, demandW, knownDemandW: budgetValue('W', node.demand.knownW), rating };
  }

  function outputBudget(node: Node, voltage: BudgetMetric<'V'>, capacity?: DcCapacity): DcOutputBudget {
    const output = portBudget(node);
    let capacityW: BudgetMetric<'W'>;
    if (capacity?.unit === 'A') {
      const amps = evaluate(node, 'A', capacity.value, '额定输出电流');
      if (amps.availability === 'unavailable') capacityW = unavailable('W', amps.reason);
      else if (voltage.availability === 'available') capacityW = budgetValue('W', amps.value * voltage.value);
      else {
        const reason = '需要相应的输出电压，才能将额定输出电流换算为功率。';
        report(node, 'missing_parameter', reason);
        capacityW = unavailable('W', reason);
      }
    } else {
      capacityW = evaluate(node, 'W', capacity?.value, '额定输出功率');
    }
    const { demandW } = output;
    const marginW = node.incoming.length > 1 ? unavailable('W', '无法将负载分配到单路直流供电。')
      : capacityW.availability === 'unavailable' ? capacityW : demandW.availability === 'unavailable' ? demandW
        : budgetValue('W', capacityW.value - demandW.value);
    const capacityStatus = marginW.availability === 'unavailable' ? 'unknown' : marginW.value < 0 ? 'over_capacity' : 'within_capacity';
    return { ...output, capacityW, marginW, capacityStatus };
  }

  return {
    ports: [...nodes.values()].map(portBudget),
    supplies: [...nodes.values()].flatMap(node => node.supply
      ? [outputBudget(node, node.supply.voltageV, node.supply.capacity)] : []),
    converters: converters.map(arc => ({
      input: arc.from.port.ref, output: outputBudget(arc.to, arc.conversion.voltageV, arc.conversion.capacity),
      efficiency: arc.conversion.efficiency, inputDemandW: demandMetric(contribution(arc)),
    })),
    loads: [...nodes.values()].flatMap(node => node.load ? [{ endpoint: node.port.ref, powerW: node.load }] : []),
    diagnostics,
  };
}
