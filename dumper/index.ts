/* eslint-disable @typescript-eslint/no-unused-vars */

import path from 'path';
import fg from 'fast-glob';
import AdmZip from 'adm-zip';
import contentDisposition from 'content-disposition';

export async function handler() {
  const zip = new AdmZip();
  const files = await fg([
    '/function/**',
    '!/function/runtime/lib/node/**',
    '!/function/runtime/lib/node_modules/**',
    '!/function/runtime/include/node/**',
    '!/function/runtime/bin/**',
    '!/function/code/**',
  ], { dot: true });
  // console.log(files.length);
  // console.log(files);
  files.forEach(file => zip.addLocalFile(file, path.dirname(file)));
  return sendFile('function.zip', zip.toBuffer());
  // return sendJson({ files });
}

// function sendJson(json: unknown) {
//   return {
//     statusCode: 200,
//     headers: { 'Content-Type': 'application/json' },
//     isBase64Encoded: false,
//     body: JSON.stringify(json),
//   };
// }

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
