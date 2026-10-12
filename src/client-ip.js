import { isIP } from 'node:net';

function isLoopback(address) {
  if (typeof address !== 'string' || !isIP(address)) return false;
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'));
}

// The local reverse proxy must overwrite this header, not append to it.
// Never infer trust from X-Forwarded-For or from a private network address.
export function clientIp(req, trustProxy = '') {
  const remote = req.socket.remoteAddress ?? 'local';
  if (trustProxy !== 'loopback' || !isLoopback(remote)) return remote;
  const forwarded = req.headers['x-bbpoker-client-ip'];
  return typeof forwarded === 'string' && isIP(forwarded) ? forwarded : remote;
}
