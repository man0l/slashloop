// ---------------------------------------------------------------------------
// Combined proxy budget: workspace UsageLog AND the Proxy-Cheap plan.
//
// Internal PROXY_TRAFFIC_CAP_GB is a safety rail (default 1GB). The vendor
// GET /proxies bandwidth.{total,used} is what we actually pay for. The
// remaining allowance is the tighter of the two. When the vendor reports
// used=null we cannot see billed GB yet, so only the internal rail applies.
// ---------------------------------------------------------------------------

import {
  BYTES_PER_GB, TrafficCapExceededError, fmtBytes, monthlyProxyBytes, trafficCapBytes, wouldExceedCap,
} from './bandwidth.js';
import { proxyCheapBandwidth, type ProxyCheapBandwidth } from './proxy-cheap.js';

export function vendorRemainingBytes(vendor: ProxyCheapBandwidth | null): number | null {
  if (!vendor) return null;
  if (vendor.remainingGb == null) return null;
  return Math.max(0, Math.round(vendor.remainingGb * BYTES_PER_GB));
}

/** Bytes still allowed. Tightest of the internal rail and the vendor plan. */
export function remainingBudgetBytes(
  internalUsed: number,
  internalCap: number,
  vendor: ProxyCheapBandwidth | null,
): number {
  const internalLeft = Math.max(0, internalCap - Math.max(0, internalUsed));
  const vendorLeft = vendorRemainingBytes(vendor);
  return vendorLeft == null ? internalLeft : Math.min(internalLeft, vendorLeft);
}

export async function assertProxyBudget(workspaceId: string, estimatedBytes: number): Promise<void> {
  const capBytes = trafficCapBytes();
  const usedBytes = await monthlyProxyBytes(workspaceId);
  let vendor: ProxyCheapBandwidth | null = null;
  try {
    vendor = await proxyCheapBandwidth();
  } catch (err) {
    console.warn(`[proxy:budget] Proxy-Cheap snapshot failed: ${(err as Error).message}`);
  }

  const left = remainingBudgetBytes(usedBytes, capBytes, vendor);
  if (wouldExceedCap(0, left, estimatedBytes)) {
    console.error(
      `[proxy:budget] workspace ${workspaceId} refusing ~${fmtBytes(estimatedBytes)} `
      + `(internal ${fmtBytes(usedBytes)}/${fmtBytes(capBytes)}`
      + `${vendor ? `, vendor ${vendor.usedGb ?? '?'} / ${vendor.totalGb}GB` : ''})`,
    );
    throw new TrafficCapExceededError(usedBytes, usedBytes + left, estimatedBytes);
  }
}
