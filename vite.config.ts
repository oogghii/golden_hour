import { defineConfig } from 'vite';

export default defineConfig({
  /*
   * Relative, so the built site works from wherever it is served. GitHub Pages
   * serves this project from /golden_hour/ rather than the domain root, and the
   * default base of '/' would point every asset URL at the root and render a
   * blank page. './' covers that without hardcoding the repository name, so
   * renaming the repo or serving the build from a file:// path both still work.
   * Ignored by the dev server, which always serves from '/'.
   */
  base: './',
  // host:true exposes the dev server on the LAN so the build can be opened
  // directly on a phone for real-device testing.
  server: { host: true, port: 5173 },
  build: { target: 'es2022' },
});
