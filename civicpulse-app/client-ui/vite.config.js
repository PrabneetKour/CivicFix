import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * npm run dev        → http on localhost, for working on the laptop
 * npm run dev:phone  → https on the local network, so a phone gets GPS
 *
 * A browser will not hand out location on anything except https or localhost, so a phone
 * opening http://192.168.x.x silently never gets a fix. The self-signed certificate is
 * untrusted — the phone warns once — but the origin counts as secure and GPS works.
 */
const phoneMode = process.env.HTTPS === 'true';

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(phoneMode ? [basicSsl()] : [])],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    // in phone mode the page is https while the API stays http on the same machine;
    // the proxy bridges them, so the browser never makes a mixed-content request
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true, secure: false },
      '/uploads': { target: 'http://127.0.0.1:4000', changeOrigin: true, secure: false }
    },
    ...(phoneMode ? { hmr: { host: undefined, protocol: 'wss', clientPort: 5173 } } : {})
  }
});
