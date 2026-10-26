import { defineConfig } from 'astro/config';

// Static admin console. Served by the nginx gateway, which also proxies /api and /auth.
export default defineConfig({
  output: 'static',
  build: { format: 'directory' },
  server: { host: true, port: 4321 },
  devToolbar: { enabled: false },
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
});
