import { describe, it, expect, beforeEach } from 'vitest';
import { recordVpnBlock, getVpnBlockState, clearVpnBlock } from './vpn';

describe('VPN block detection and state', () => {
  beforeEach(() => {
    clearVpnBlock();
  });

  it('starts with no recent blocks', () => {
    const state = getVpnBlockState();
    expect(state.vpnBlockedRecent).toBe(false);
    expect(state.lastBlock).toBeNull();
  });

  it('records a VPN block event and reports it as recent', () => {
    recordVpnBlock('src123', 'http://103.211.100.216', 511, 'HTTP 511 Network Authentication Required');
    const state = getVpnBlockState();
    expect(state.vpnBlockedRecent).toBe(true);
    expect(state.lastBlock).not.toBeNull();
    expect(state.lastBlock?.sourceId).toBe('src123');
    expect(state.lastBlock?.hostUrl).toBe('http://103.211.100.216');
    expect(state.lastBlock?.status).toBe(511);
  });

  it('clears the VPN block state when rotate/reconnect is performed', () => {
    recordVpnBlock('src123', 'http://103.211.100.216', 511);
    expect(getVpnBlockState().vpnBlockedRecent).toBe(true);

    clearVpnBlock();
    expect(getVpnBlockState().vpnBlockedRecent).toBe(false);
    expect(getVpnBlockState().lastBlock).toBeNull();
  });
});
