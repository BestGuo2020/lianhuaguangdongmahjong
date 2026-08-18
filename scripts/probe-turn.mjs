// 最小 TURN 连通性测试：两个 forceRelay 的 RTCPeerConnection 经手动信令互连。
// 验证 TURN 服务器能否分配 relay 候选并完成 ICE（UDP 与 TCP 两种 transport）。
import { chromium } from '@playwright/test'

const TURN_UDP = { urls: 'turn:113.45.254.130:53478', username: 'turn', credential: 'DZxaEm35GmecFZj' }
const TURN_TCP = { urls: 'turn:113.45.254.130:53478?transport=tcp', username: 'turn', credential: 'DZxaEm35GmecFZj' }

async function probe(browser, turn, label) {
  const ctx = await browser.newContext()
  const pageA = await ctx.newPage()
  const pageB = await ctx.newPage()
  await pageA.goto('about:blank')
  await pageB.goto('about:blank')

  const offer = await pageA.evaluate(async ({ turn, label }) => {
    const w = window
    w.__pc = new RTCPeerConnection({ iceServers: [turn], iceTransportPolicy: 'relay' })
    const pc = w.__pc
    pc.createDataChannel('t')
    w.__candidates = []
    pc.onicecandidate = (e) => { if (e.candidate) w.__candidates.push(e.candidate.toJSON()) }
    pc.oniceconnectionstatechange = () => { console.log(`[diag][${label}] A ice:`, pc.iceConnectionState) }
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    return { type: offer.type, sdp: offer.sdp }
  }, { turn, label })

  await pageA.waitForTimeout(6000)
  const candsA = await pageA.evaluate(() => window.__candidates)
  console.log(`[diag][${label}] A gathering:`, await pageA.evaluate(() => window.__pc.iceGatheringState),
    'candidates:', JSON.stringify(candsA).slice(0, 400))
  if (candsA.length === 0) {
    await ctx.close()
    return undefined
  }

  const answer = await pageB.evaluate(async ({ turn, offer, label }) => {
    const w = window
    w.__pc = new RTCPeerConnection({ iceServers: [turn], iceTransportPolicy: 'relay' })
    const pc = w.__pc
    w.__candidates = []
    pc.onicecandidate = (e) => { if (e.candidate) w.__candidates.push(e.candidate.toJSON()) }
    pc.oniceconnectionstatechange = () => { console.log(`[diag][${label}] B ice:`, pc.iceConnectionState) }
    await pc.setRemoteDescription({ type: offer.type, sdp: offer.sdp })
    const ans = await pc.createAnswer()
    await pc.setLocalDescription(ans)
    return { type: ans.type, sdp: ans.sdp }
  }, { turn, offer, label })

  await pageA.evaluate(({ answer }) => window.__pc.setRemoteDescription({ type: answer.type, sdp: answer.sdp }), { answer })
  await pageB.waitForTimeout(4000)
  const candsB = await pageB.evaluate(() => window.__candidates)
  for (const c of candsA) await pageB.evaluate(({ c }) => window.__pc.addIceCandidate(c), { c })
  for (const c of candsB) await pageA.evaluate(({ c }) => window.__pc.addIceCandidate(c), { c })
  await pageA.waitForTimeout(12000)
  const stateA = await pageA.evaluate(() => window.__pc.iceConnectionState)
  console.log(`[diag][${label}] FINAL A =`, stateA)
  await ctx.close()
  return stateA
}

async function main() {
  const browser = await chromium.launch()
  const udp = await probe(browser, TURN_UDP, 'udp')
  const tcp = await probe(browser, TURN_TCP, 'tcp')
  console.log('[diag] result udp =', udp ?? 'no-candidates', ' tcp =', tcp ?? 'no-candidates')
  await browser.close()
  process.exit(udp === 'connected' || tcp === 'connected' ? 0 : 1)
}

main().catch((error) => { console.error('[diag] FAIL:', error.message); process.exit(2) })
