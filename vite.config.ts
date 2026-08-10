import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // 相对 base：部署到未知子目录（如 vibehub 的 /项目名/）也能加载资源。
  // 注意：静态站点须以「目录 + 尾斜杠」形式访问（/项目名/），否则 ./ 相对解析会错位。
  base: './',
  server: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
      '/ws': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
    }
  },
})
