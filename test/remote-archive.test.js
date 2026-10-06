'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RestArchiveClient } = require('../src/archive');

test('remote archive client authenticates with deployment API key file', async () => {
  let seenKey = null;
  const server = http.createServer((req,res) => {
    seenKey = req.headers['x-api-key'] || null;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({sources:[]}));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'archive-key-'));
  const keyFile=path.join(dir,'key'); fs.writeFileSync(keyFile,'secret-value\n',{mode:0o600});
  const client=new RestArchiveClient({baseURL:'http://127.0.0.1:'+port+'/',apiKeyFile:keyFile});
  await client.sources();
  assert.equal(seenKey,'secret-value');
  server.close();
});
