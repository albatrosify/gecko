import axios from 'axios';
import { log } from './logger.ts';

export interface VpnBlockEvent {
  sourceId: string;
  hostUrl: string;
  timestamp: number;
  status: number;
  reason: string;
}

export interface GluetunStatus {
  configured: boolean;
  status?: string;
  publicIp?: string;
  country?: string;
  city?: string;
  organization?: string;
  vpnBlockedRecent?: boolean;
  lastBlock?: VpnBlockEvent | null;
}

let lastVpnBlockEvent: VpnBlockEvent | null = null;

export function recordVpnBlock(sourceId: string, hostUrl: string, status: number = 511, reason?: string): void {
  lastVpnBlockEvent = {
    sourceId,
    hostUrl,
    timestamp: Date.now(),
    status,
    reason: reason || 'HTTP 511 Network Authentication Required (VPN/Datacenter IP blacklisted by upstream CDN)',
  };
  log(`[VPN] Recorded upstream block on ${hostUrl} (status ${status}): ${lastVpnBlockEvent.reason}`);
}

export function clearVpnBlock(): void {
  lastVpnBlockEvent = null;
}

export function getVpnBlockState(): { vpnBlockedRecent: boolean; lastBlock: VpnBlockEvent | null } {
  // Flag as recent if within the last 15 minutes
  const isRecent = lastVpnBlockEvent && (Date.now() - lastVpnBlockEvent.timestamp < 15 * 60 * 1000);
  return {
    vpnBlockedRecent: !!isRecent,
    lastBlock: isRecent ? lastVpnBlockEvent : null,
  };
}

function getGluetunConfig() {
  const baseUrl = (process.env.GLUETUN_CONTROL_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const headers: Record<string, string> = {};

  if (process.env.GLUETUN_API_KEY) {
    headers['X-API-Key'] = process.env.GLUETUN_API_KEY;
  } else if (process.env.GLUETUN_BASIC_AUTH) {
    headers['Authorization'] = `Basic ${Buffer.from(process.env.GLUETUN_BASIC_AUTH).toString('base64')}`;
  }

  return { baseUrl, headers };
}

/**
 * Check if Gluetun control server is reachable and get public IP / VPN status.
 */
export async function getGluetunStatus(): Promise<GluetunStatus> {
  const { baseUrl, headers } = getGluetunConfig();
  const blockState = getVpnBlockState();

  try {
    // 1. Fetch IP info from Gluetun control server
    const ipRes = await axios.get(`${baseUrl}/v1/publicip/ip`, {
      headers,
      timeout: 3000,
    });

    const ipData = ipRes.data || {};

    // 2. Fetch VPN status (try /v1/vpn/status first, then /v1/openvpn/status)
    let vpnStatus = 'running';
    try {
      const statusRes = await axios.get(`${baseUrl}/v1/vpn/status`, {
        headers,
        timeout: 2000,
        validateStatus: () => true,
      });
      if (statusRes.status === 200 && statusRes.data?.status) {
        vpnStatus = statusRes.data.status;
      } else if (statusRes.status === 404) {
        const ovpnRes = await axios.get(`${baseUrl}/v1/openvpn/status`, {
          headers,
          timeout: 2000,
        });
        if (ovpnRes.data?.status) vpnStatus = ovpnRes.data.status;
      }
    } catch {
      // Ignore secondary status failure if IP was fetched
    }

    return {
      configured: true,
      status: vpnStatus,
      publicIp: ipData.public_ip || ipData.ip,
      country: ipData.country,
      city: ipData.city,
      organization: ipData.organization || ipData.org,
      vpnBlockedRecent: blockState.vpnBlockedRecent,
      lastBlock: blockState.lastBlock,
    };
  } catch {
    // If control server is not reachable, Gluetun control is not configured or offline
    return {
      configured: false,
      vpnBlockedRecent: blockState.vpnBlockedRecent,
      lastBlock: blockState.lastBlock,
    };
  }
}

/**
 * Trigger VPN reconnection in Gluetun to obtain a new egress IP.
 */
export async function reconnectGluetun(): Promise<{ success: boolean; message: string; newIp?: string }> {
  const { baseUrl, headers } = getGluetunConfig();

  // Try /v1/vpn/status first, then /v1/openvpn/status
  const endpoints = ['/v1/vpn/status', '/v1/openvpn/status'];
  let workedEndpoint = '';

  for (const ep of endpoints) {
    try {
      const res = await axios.put(`${baseUrl}${ep}`, { status: 'stopped' }, {
        headers,
        timeout: 5000,
        validateStatus: () => true,
      });
      if (res.status === 200 || res.status === 204) {
        workedEndpoint = ep;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!workedEndpoint) {
    throw new Error('Failed to reach Gluetun control server to trigger reconnect. Check GLUETUN_CONTROL_URL or GLUETUN_API_KEY.');
  }

  log(`[VPN] Sent stopped command to Gluetun via ${workedEndpoint}. Restarting VPN...`);

  // Wait 1.5 seconds for tunnel stop
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Trigger start / running
  try {
    await axios.put(`${baseUrl}${workedEndpoint}`, { status: 'running' }, {
      headers,
      timeout: 5000,
      validateStatus: () => true,
    });
  } catch (err: any) {
    log(`[VPN] Warning on start command: ${err.message}`);
  }

  // Clear previous block events since we rotated
  clearVpnBlock();

  // Poll for up to 10 seconds for new public IP
  let newIp: string | undefined;
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      const ipRes = await axios.get(`${baseUrl}/v1/publicip/ip`, {
        headers,
        timeout: 3000,
      });
      if (ipRes.data?.public_ip || ipRes.data?.ip) {
        newIp = ipRes.data.public_ip || ipRes.data.ip;
        log(`[VPN] VPN reconnected successfully. New egress IP: ${newIp}`);
        break;
      }
    } catch {
      // Waiting for connection to establish
    }
  }

  return {
    success: true,
    message: newIp ? `VPN rotated successfully. New IP: ${newIp}` : 'VPN reconnection command sent to Gluetun.',
    newIp,
  };
}
