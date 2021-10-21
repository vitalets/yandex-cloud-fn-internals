/* eslint-disable @typescript-eslint/no-unused-vars */

import path from 'path';
import fg from 'fast-glob';
import AdmZip from 'adm-zip';
import contentDisposition from 'content-disposition';

export async function handler(event: ServerlessHttpEvent) {
  const query = event.queryStringParameters || {};
  return query.action === 'env'
    ? dumpEnv()
    : await dumpCode();
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
