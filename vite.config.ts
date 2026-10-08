import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { bevReconstructionPlugin } from './vite-bev-plugin'

export default defineConfig({
  plugins: [react(), bevReconstructionPlugin()],
  server: {
    host: '127.0.0.1',
    port: 4173,
  },
})
