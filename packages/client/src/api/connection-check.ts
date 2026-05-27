/**
 * Check if a server address is reachable via public health endpoints.
 * Returns the base URL if reachable, or null if not reachable within timeoutMs.
 */
export async function checkAddressReachable(
  address: string,
  timeoutMs = 2000,
): Promise<string | null> {
  if (!address) return null

  // Normalize: strip trailing slash
  const base = address.replace(/\/+$/, '')

  // Use /api/auth/status as primary — it's public (no auth required) and always returns 200.
  // /api/health requires auth (returns 401) so it's unreliable for pre-login checks.
  // /health is the fallback for older server versions.
  const healthPaths = ['/api/auth/status', '/health']

  for (const path of healthPaths) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      const res = await fetch(`${base}${path}`, {
        method: 'HEAD',
        signal: controller.signal,
        // Avoid CORS preflight by keeping it simple
        mode: 'cors',
        cache: 'no-cache',
      })

      clearTimeout(timer)

      // Any response (even 4xx/5xx) means the server is reachable
      if (res) {
        return base
      }
    } catch {
      // Try the next public health endpoint before declaring unreachable.
    }
  }

  return null
}

export interface AddressCheckResult {
  lanReachable: boolean
  wanReachable: boolean
  selectedBaseUrl: string | null
}

/**
 * Check LAN first, then WAN as fallback.
 * Returns which address to use, or null if neither is reachable.
 */
export async function checkDualAddresses(
  lanAddress: string,
  wanAddress: string,
): Promise<AddressCheckResult> {
  const result: AddressCheckResult = {
    lanReachable: false,
    wanReachable: false,
    selectedBaseUrl: null,
  }

  // Check LAN first (priority)
  if (lanAddress) {
    const lanResult = await checkAddressReachable(lanAddress)
    if (lanResult) {
      result.lanReachable = true
      result.selectedBaseUrl = lanResult
      return result
    }
  }

  // LAN didn't work, fall back to WAN
  if (wanAddress) {
    const wanResult = await checkAddressReachable(wanAddress)
    if (wanResult) {
      result.wanReachable = true
      result.selectedBaseUrl = wanResult
      return result
    }
  }

  return result
}
