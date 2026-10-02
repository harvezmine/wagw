import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assertSafeUrl, fetchRemoteFile, guardRedirect, isPrivateAddress, safeLookup } from '../src/utils/netGuard.js';

test('isPrivateAddress flags internal IPv4 and IPv6 ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test('isPrivateAddress allows public addresses and ignores hostnames', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', 'example.com']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('assertSafeUrl enforces http(s) and blocks literal private hosts', () => {
  assert.equal(assertSafeUrl('https://example.com/a.png').hostname, 'example.com');
  for (const url of ['ftp://example.com/x', 'not a url', 'http://localhost:5432', 'http://127.0.0.1/x', 'http://[::1]/x', 'http://169.254.169.254/latest/meta-data']) {
    assert.throws(() => assertSafeUrl(url), { status: 400 }, url);
  }
  assert.doesNotThrow(() => assertSafeUrl('http://127.0.0.1/x', { allowPrivate: true }));
});

test('safeLookup refuses hostnames that resolve to private addresses', async () => {
  const error = await new Promise((resolve) => safeLookup('localhost', { all: true }, (err) => resolve(err)));
  assert.equal(error?.code, 'EPRIVATEADDRESS');
});

test('guardRedirect blocks redirects to literal private IPs', () => {
  assert.throws(() => guardRedirect({ hostname: '127.0.0.1' }), /Blocked redirect/);
  assert.doesNotThrow(() => guardRedirect({ hostname: 'example.com' }));
});

test('fetchRemoteFile blocks private URLs and enforces the size limit', async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'image/png; charset=binary');
    res.end(Buffer.alloc(req.url === '/big' ? 2048 : 16, 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await assert.rejects(fetchRemoteFile(`${base}/small`, { maxBytes: 1024 }), { status: 400 });

  const file = await fetchRemoteFile(`${base}/small`, { allowPrivate: true, maxBytes: 1024 });
  assert.equal(file.buffer.length, 16);
  assert.equal(file.contentType, 'image/png');

  await assert.rejects(fetchRemoteFile(`${base}/big`, { allowPrivate: true, maxBytes: 1024 }), /maxContentLength/);
});
