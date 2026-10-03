import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { assertClientToolSchemas, createClientSchemaValidator } from './client-schema-test-helpers.mjs';

const port = String(43000 + Math.floor(Math.random() * 1000));
const healthCheckAttempts = 100;
const healthCheckDelayMs = 200;
const home = await mkdtemp(join(tmpdir(), 'withings-mcp-http-smoke-'));
const schemaValidator = createClientSchemaValidator();
const client = new Client({ name: 'withings-http-smoke-test', version: '0.0.0' }, {
  jsonSchemaValidator: new AjvJsonSchemaValidator(schemaValidator)
});
const child = spawn(process.execPath, ['dist/index.js', '--http'], {
  env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, WITHINGS_MCP_PORT: port, WITHINGS_MCP_HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 1000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, data: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('HTTP health check timed out')));
    request.on('error', reject);
  });
}

try {
  let ok = false;
  for (let i = 0; i < healthCheckAttempts; i += 1) {
    try {
      const { statusCode, data } = await getJson(`http://127.0.0.1:${port}/health`);
      assert.equal(statusCode, 200);
      assert.equal(data.ok, true);
      ok = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, healthCheckDelayMs));
    }
  }
  if (!ok) throw new Error(`HTTP server did not become healthy. stderr=${stderr}`);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const { tools } = await client.listTools();
  const schemas = assertClientToolSchemas(tools, schemaValidator);
  const result = await client.callTool({ name: 'withings_capabilities', arguments: { response_format: 'json' } });
  assert.equal(result.structuredContent?.unofficial, true);
  console.log(JSON.stringify({ ok: true, transport: 'http', schemas, port: Number(port) }, null, 2));
} finally {
  await client.close();
  child.kill('SIGTERM');
  await rm(home, { recursive: true, force: true });
}
