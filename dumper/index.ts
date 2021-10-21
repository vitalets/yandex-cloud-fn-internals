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
  const headers = { 'Metadata-Flavor': 'Google' };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const json = await res.json();
  return sendJson(json);
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
