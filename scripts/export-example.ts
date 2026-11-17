import { writeFileSync, mkdirSync } from 'node:fs';
import { createExample } from '../src/model/example';
import { serializeProject } from '../src/storage/project';

mkdirSync('examples', { recursive: true });
writeFileSync('examples/p0-project.json', serializeProject(createExample()), 'utf8');
console.log('examples/p0-project.json exported and validated');
