import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: 'dist/v1',
    target: 'es2022',
    reportCompressedSize: false,
    rollupOptions: { input: fileURLToPath(new URL('./v1.html', import.meta.url)) },
  },
});
