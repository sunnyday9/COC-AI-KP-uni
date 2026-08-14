import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'
// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    uni(),
  ],
  server: {
    // Allow importing the shared/ package (outside client root) via relative paths
    fs: {
      allow: ['..'],
    },
  },
})
