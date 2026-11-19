import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: mode === 'v1' ? 'dist/v1' : 'dist',
    target: 'es2022',
    reportCompressedSize: false,
    ...(mode === 'v1' && { rollupOptions: { input: fileURLToPath(new URL('./v1.html', import.meta.url)) } }),
  },
}));
