import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { preloadTileImages } from './game/core/presentation/tileAssets'

createApp(App).mount('#app')
// 应用启动即并行预加载全部牌面（不阻塞首屏渲染；2D/3D 后续直接命中内存缓存）
void preloadTileImages()
