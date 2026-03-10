import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/agent/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  clean: true,
  outDir: 'dist',
  sourcemap: true,
  treeshake: true,
});
