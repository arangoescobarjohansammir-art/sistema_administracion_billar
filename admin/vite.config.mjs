import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

const envDir = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, 'VITE_SUPABASE_');
  const url = env.VITE_SUPABASE_URL?.trim();
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if ((url || key) && (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url ?? '') ||
    !/^sb_publishable_[a-z0-9_-]+$/i.test(key ?? ''))) {
    throw new Error('Para compilar el panel usa la URL de Supabase y una clave sb_publishable_, o deja ambas vacías para la demo.');
  }
  return {
    root: fileURLToPath(new URL('./', import.meta.url)), envDir, base: './',
    build: { outDir: '../dist/admin', emptyOutDir: true },
  };
});
