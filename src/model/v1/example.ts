import type { PortDefinition, Project } from './types';

const opticalOut: PortDefinition = { id: 'OPT_OUT', type: 'OPTICAL', direction: 'out' };
const pathA = ['TX_A', 'TX_SLOT', 'TX_CBB', 'MZM_MODULE', 'MZM_OPTICAL'];
const pathB = ['TX_B', 'TX_SLOT', 'TX_CBB', 'MZM_MODULE', 'MZM_OPTICAL'];

export const exampleProject = {
  id: 'hierarchy-example',
  name: 'Transmitter chassis hierarchy',
  rootModuleDefinitionId: 'System',
  componentDefinitions: [
    { kind: 'component', id: 'mzm-optical', name: 'MZM optical component', ports: [opticalOut] },
  ],
  moduleDefinitions: [
    {
      kind: 'module', id: 'System', name: 'System', ports: [],
      instances: [
        { id: 'TX_A', name: 'Transmitter A', definitionId: 'TX_CHASSIS' },
        { id: 'TX_B', name: 'Transmitter B', definitionId: 'TX_CHASSIS' },
      ],
    },
    {
      kind: 'module', id: 'TX_CHASSIS', name: 'TX chassis', ports: [opticalOut],
      physicalEnclosure: { widthMm: 440, depthMm: 350, heightMm: 44.45 },
      instances: [{ id: 'TX_SLOT', name: 'TX slot', definitionId: 'slot' }],
      portMappings: [{ portId: 'OPT_OUT', target: { instanceId: 'TX_SLOT', portId: 'OPT_OUT' } }],
    },
    {
      kind: 'module', id: 'slot', name: 'TX slot', ports: [opticalOut],
      instances: [{ id: 'TX_CBB', name: 'TX CBB', definitionId: 'cbb' }],
      portMappings: [{ portId: 'OPT_OUT', target: { instanceId: 'TX_CBB', portId: 'OPT_OUT' } }],
    },
    {
      kind: 'module', id: 'cbb', name: 'TX CBB', ports: [opticalOut],
      instances: [{ id: 'MZM_MODULE', name: 'MZM module', definitionId: 'mzm' }],
      portMappings: [{ portId: 'OPT_OUT', target: { instanceId: 'MZM_MODULE', portId: 'OPT_OUT' } }],
    },
    {
      kind: 'module', id: 'mzm', name: 'MZM module', ports: [opticalOut],
      instances: [{ id: 'MZM_OPTICAL', name: 'MZM optical component', definitionId: 'mzm-optical' }],
      portMappings: [{ portId: 'OPT_OUT', target: { instanceId: 'MZM_OPTICAL', portId: 'OPT_OUT' } }],
    },
  ],
  layout: {
    physical: [
      { instancePath: pathA, enclosurePath: ['TX_A'], xMm: 20, yMm: 30, rotationDeg: 0 },
      { instancePath: pathB, enclosurePath: ['TX_B'], xMm: 55, yMm: 40, rotationDeg: 90 },
    ],
    topology: [
      { instancePath: ['TX_A'], x: 40, y: 80 },
      { instancePath: ['TX_B'], x: 300, y: 80 },
    ],
  },
} satisfies Project;
