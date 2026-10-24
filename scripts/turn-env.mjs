// Node-only TURN configuration. Never use VITE_* for these private test credentials.
export function readTurnEnvironment(required = true) {
  const names = ['TURN_HOST', 'TURN_USERNAME', 'TURN_PASSWORD']
  const missing = names.filter((name) => !process.env[name]?.trim())
  if (missing.length) {
    if (!required) return null
    throw new Error(`Missing environment variables: ${missing.join(', ')}`)
  }
  const host = process.env.TURN_HOST.trim()
  const portText = process.env.TURN_PORT ?? '3478'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('TURN_PORT must be an integer from 1 to 65535')
  }
  if (/[\s/?#@]/.test(host)) throw new Error('TURN_HOST must contain only a hostname or IP address')
  const address = `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
  const username = process.env.TURN_USERNAME
  const credential = process.env.TURN_PASSWORD
  return {
    udp: { urls: `turn:${address}`, username, credential },
    tcp: { urls: `turn:${address}?transport=tcp`, username, credential },
    queryValue: `turn:${encodeURIComponent(username)}:${encodeURIComponent(credential)}@${address}`,
  }
}
