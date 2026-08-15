// VibeHub SDK 全局对象桥接：SDK 通过 <script> 注入 window.VibeHub。
// 类型主体见同目录 vibehub.d.ts（官方声明）。
interface Window {
  VibeHub: typeof VibeHub
}
