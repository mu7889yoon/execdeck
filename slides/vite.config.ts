import { defineConfig } from 'vite'

const apiTarget = process.env.WORKSHOP_API_TARGET || 'http://sandbox:8080'
const terminalTarget = process.env.WORKSHOP_TERMINAL_TARGET || 'ws://sandbox:8081'

export default defineConfig({
  plugins: [{
    name: 'execdeck-docker-bind',
    config() {
      // Slidev's CLI bind address takes precedence over the static Vite config.
      if (process.env.WORKSHOP_API_TARGET) return { server: { host: '0.0.0.0' } }
    },
  }],
  server: {
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/terminal': { target: terminalTarget, ws: true },
    },
  },
})
