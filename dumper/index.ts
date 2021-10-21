/* eslint-disable @typescript-eslint/no-unused-vars */

import path from 'path';
import fg from 'fast-glob';
import AdmZip from 'adm-zip';
import contentDisposition from 'content-disposition';
import fetch from 'node-fetch';

export async function handler(event: ServerlessHttpEvent) {
  const query = event.queryStringParameters || {};
  switch (query.action) {
    case 'env': return dumpEnv();
    case 'metadata': return dumpMetadata();
    case 'internalUrl': return dumpInternalUrl();
    default: return dumpCode();
  }
}

async function dumpCode() {
  const zip = new AdmZip();
  const files = await fg([
    '/function/**',
    '!/function/runtime/lib/node/**',
    '!/function/runtime/lib/node_modules/**',
    '!/function/runtime/include/node/**',
    '!/function/runtime/bin/**',
    '!/function/code/**',
  ], { dot: true });
  files.forEach(file => zip.addLocalFile(file, path.dirname(file)));
  return sendFile('function.zip', zip.toBuffer());
}

function dumpEnv() {
  return sendJson(process.env);
}

async function dumpMetadata() {
  // see: https://cloud.yandex.ru/docs/serverless-containers/operations/sa
  const url = 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token';
  const reqHeaders = { 'Metadata-Flavor': 'Google' };
  const res = await fetch(url, { headers: reqHeaders });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const headers = Array.from(res.headers.entries());
  const body = await res.json();
  return sendJson({ headers, body });
}

async function dumpInternalUrl() {
  // const [ method, url ] = [ 'post', 'http://169.254.169.254/2018-06-01/runtime/init/ready' ];
  const [ method, url ] = [ 'get', 'http://169.254.169.254/2018-06-01/runtime/init/await' ];
  const res = await fetch(url, { method });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const headers = Array.from(res.headers.entries());
  const body = await res.json();
  return sendJson({ headers, body });
}

function sendJson(json: unknown) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    isBase64Encoded: false,
    body: JSON.stringify(json, null, 2),
  };
}

function sendFile(fileName: string, buffer: Buffer) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(fileName),
    },
    isBase64Encoded: true,
    body: buffer.toString('base64'),
  };
}

export interface ServerlessHttpEvent {
  httpMethod: string;
  queryStringParameters: Record<string, string>;
  isBase64Encoded: boolean;
  body?: string;
}
