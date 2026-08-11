interface PerfMetrics {
  drawCalls: number
  triangles: number
  pixelRatio: number
  qualityLevel: number
  glossy: boolean
}

export function createPerfHud(enabled: boolean, getMetrics: () => PerfMetrics) {
  if (!enabled) return { frame: (_now: number) => {}, destroy: () => {} }

  const element = document.createElement('div')
  element.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9999;font:11px/1.5 ui-monospace,Consolas,monospace;color:#9ff;background:rgba(0,0,0,.6);padding:6px 9px;border-radius:6px;pointer-events:none;white-space:pre;'
  document.body.appendChild(element)
  const samples: number[] = []
  let last = -1
  let maxMs = 0

  return {
    frame(now: number) {
      const ms = last >= 0 ? now - last : 0
      if (last >= 0) {
        samples.push(ms)
        if (samples.length > 120) samples.shift()
        if (ms > maxMs) maxMs = ms
      }
      last = now
      if (samples.length < 30 || samples.length % 30 !== 0) return
      const sorted = [...samples].sort((a, b) => a - b)
      const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length
      const p95 = sorted[Math.floor(sorted.length * .95)]!
      const metrics = getMetrics()
      element.textContent = `frame ${ms.toFixed(1)}ms\navg ${avg.toFixed(1)}  p95 ${p95.toFixed(1)}  max ${maxMs.toFixed(1)}\n~${Math.min(60, 1000 / avg).toFixed(0)}fps  q${metrics.qualityLevel}${metrics.glossy ? 'G' : 'M'}\ndc${metrics.drawCalls}  tri${Math.round(metrics.triangles / 1000)}k  pr${metrics.pixelRatio.toFixed(1)}`
    },
    destroy() {
      element.remove()
    },
  }
}
