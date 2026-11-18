/// <reference types="vite/client" />

import { createRoot } from 'react-dom/client';
import exampleJson from '../../../examples/v1-project.json?raw';
import type { Project } from '../../model/v1/types';
import { createProjectStore } from '../../state/v1/project-store';
import { parseProjectJson } from '../../storage/v1/project-json';
import { Workbench } from './workbench';
import './workbench.css';

const loadExample = () => parseProjectJson(exampleJson);
const newProject = (): Project => ({
  id: 'untitled', name: '未命名工程', rootModuleDefinitionId: 'system',
  componentDefinitions: [],
  moduleDefinitions: [{ id: 'system', name: 'System', kind: 'module', ports: [], instances: [] }],
});

createRoot(document.getElementById('root')!).render(
  <Workbench store={createProjectStore(loadExample())} loadExample={loadExample} newProject={newProject} />,
);
