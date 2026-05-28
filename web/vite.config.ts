import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// On GitHub Pages we serve from /<repo>/, locally from /. The deploy
// workflow sets VITE_BASE so this file doesn't need to know the repo name.
const base = process.env.VITE_BASE ?? '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
})
