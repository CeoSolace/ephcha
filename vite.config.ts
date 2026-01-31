// vite.config.ts for frontend
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
      '/create_server': 'http://localhost:8000',
      '/join_server': 'http://localhost:8000',
      '/get_prekey': 'http://localhost:8000',
    },
  },
});
