import dns from 'node:dns';
import net from 'node:net';
import axios from 'axios';
import { AppError } from './errors.js';

const PRIVATE_IPV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];
const PRIVATE_IPV6 = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
];

const blockList = new net.BlockList();
for (const [network, prefix] of PRIVATE_IPV4) blockList.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of PRIVATE_IPV6) blockList.addSubnet(network, prefix, 'ipv6');

/**
 * True for loopback, private, link-local, CGNAT, multicast, documentation and other non-public
 * addresses (IPv4, IPv6 and IPv4-mapped IPv6). Hostnames return false.
 */
export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return false;
  return blockList.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

function isBlockedHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host);
}

/**
 * Validates the scheme and rejects literal private hosts. Hostnames are checked at connect time
 * by safeLookup, which also covers DNS rebinding.
 */
export function assertSafeUrl(rawUrl, { allowPrivate = false, label = 'URL' } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, `${label} is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, `${label} must use http or https.`);
  }
  if (!allowPrivate && isBlockedHost(url.hostname)) {
    throw new AppError(400, `${label} points to a private or local network address.`);
  }
  return url;
}

/**
 * dns.lookup replacement that refuses to connect to private addresses. It runs for every hop,
 * so redirects to internal hostnames are blocked as well.
 */
export function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const blocked = addresses.find(({ address }) => isPrivateAddress(address));
    if (blocked) {
      const blockedError = new Error(`Blocked connection to private address ${blocked.address} (${hostname}).`);
      blockedError.code = 'EPRIVATEADDRESS';
      return callback(blockedError);
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * Redirect hook: literal IP redirect targets skip DNS lookup, so they are checked here.
 */
export function guardRedirect(options) {
  if (isBlockedHost(options.hostname || '')) {
    throw new Error(`Blocked redirect to private address ${options.hostname}.`);
  }
}

/**
 * Extra axios options that enforce the private-network policy.
 */
export function safeRequestOptions({ allowPrivate = false } = {}) {
  return allowPrivate ? {} : { lookup: safeLookup, beforeRedirect: guardRedirect };
}

/**
 * Downloads a remote file into memory with SSRF protection, a size cap and a timeout.
 */
export async function fetchRemoteFile(rawUrl, { allowPrivate = false, maxBytes, timeoutMs = 30000 }) {
  assertSafeUrl(rawUrl, { allowPrivate, label: 'Media URL' });
  try {
    const response = await axios.get(rawUrl, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxContentLength: maxBytes,
      maxRedirects: 5,
      ...safeRequestOptions({ allowPrivate })
    });
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim();
    return { buffer: Buffer.from(response.data), contentType: contentType || null };
  } catch (error) {
    throw new AppError(400, `Failed to download media URL: ${error.message}`);
  }
}
