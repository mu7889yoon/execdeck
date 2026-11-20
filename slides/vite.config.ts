import { defineConfig } from 'vite'

const apiTarget = process.env.WORKSHOP_API_TARGET || 'http://sandbox:8080'
const terminalTarget = process.env.WORKSHOP_TERMINAL_TARGET || 'ws://sandbox:8081'

export default defineConfig({
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/terminal': { target: terminalTarget, ws: true },
    },
  },
})
