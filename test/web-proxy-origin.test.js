'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RestArchiveClient } = require('../src/archive');

test('Web proxy translates browser origin to the loopback upstream boundary', async () => {
  let seen;
  const upstream = http.createServer((req, res) => {
    seen = { host: req.headers.host, origin: req.headers.origin, referer: req.headers.referer, xfHost: req.headers['x-forwarded-host'] };
    res.writeHead(204); res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-web-proxy-'));
  const runtime = path.join(dir, 'daemon.1.json');
  fs.writeFileSync(runtime, JSON.stringify({address:'127.0.0.1:' + port}));
  const client = new RestArchiveClient(runtime);
  const req = new (require('node:stream').PassThrough)();
  req.method='POST'; req.url='/api/v1/relationships';
  req.headers={host:'msgvault.example',origin:'https://msgvault.example',referer:'https://msgvault.example/', 'x-forwarded-host':'msgvault.example','x-forwarded-proto':'https'};
  const res = new (require('node:stream').PassThrough)();
  res.writeHead = () => {};
  const ended = new Promise(resolve => res.on('finish', resolve));
  client.proxy(req,res); req.end('{}');
  await ended;
  assert.equal(seen.host,'127.0.0.1:' + port);
  assert.equal(seen.origin,'http://127.0.0.1:' + port);
  assert.equal(seen.referer,'http://127.0.0.1:' + port + '/');
  assert.equal(seen.xfHost,undefined);
  upstream.close();
});
