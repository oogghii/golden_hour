import { defineConfig } from 'vite';

export default defineConfig({
  // host:true exposes the dev server on the LAN so the build can be opened
  // directly on a phone for real-device testing.
  server: { host: true, port: 5173 },
  build: { target: 'es2022' },
});
