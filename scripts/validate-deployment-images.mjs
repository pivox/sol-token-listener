import { pathToFileURL } from 'node:url';

export const MAX_DEPLOYMENT_IMAGE_INPUT_BYTES = 8 * 1024;

const IMAGE_PATTERN = /^[^\s@]+@sha256:[0-9a-f]{64}$/u;
const validationCodes = new Set([
  'DEPLOYMENT_IMAGES_INPUT_TOO_LARGE',
  'DEPLOYMENT_IMAGES_INVALID',
]);

export class DeploymentImageValidationError extends Error {
  constructor(code) {
    super(`Deployment image validation failed: ${code}.`);
    this.name = 'DeploymentImageValidationError';
    this.code = code;
  }
}

export async function readBoundedDeploymentImageInput(input) {
  const chunks = [];
  let total = 0;
  for await (const chunk of input) {
    if (!(chunk instanceof Uint8Array)) throw failure('DEPLOYMENT_IMAGES_INVALID');
    total += chunk.byteLength;
    if (total > MAX_DEPLOYMENT_IMAGE_INPUT_BYTES) {
      throw failure('DEPLOYMENT_IMAGES_INPUT_TOO_LARGE');
    }
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw failure('DEPLOYMENT_IMAGES_INVALID');
  }
}

export function validateDeploymentImages(input) {
  if (typeof input !== 'string') throw failure('DEPLOYMENT_IMAGES_INVALID');
  const normalized = input.replaceAll('\r\n', '\n');
  if (normalized.includes('\r')) throw failure('DEPLOYMENT_IMAGES_INVALID');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  const images = body.split('\n');
  if (images.length !== 4 || images.some((image) => !IMAGE_PATTERN.test(image))) {
    throw failure('DEPLOYMENT_IMAGES_INVALID');
  }

  const counts = new Map();
  for (const image of images) counts.set(image, (counts.get(image) ?? 0) + 1);
  const frequencies = [...counts.values()].sort((left, right) => left - right);
  if (counts.size !== 2 || frequencies[0] !== 1 || frequencies[1] !== 3) {
    throw failure('DEPLOYMENT_IMAGES_INVALID');
  }
}

function failure(code) {
  return new DeploymentImageValidationError(code);
}

async function main() {
  try {
    const input = await readBoundedDeploymentImageInput(process.stdin);
    validateDeploymentImages(input);
    process.exitCode = 0;
  } catch (error) {
    const code = error instanceof DeploymentImageValidationError && validationCodes.has(error.code)
      ? error.code
      : 'DEPLOYMENT_IMAGES_INVALID';
    process.stderr.write(`${JSON.stringify({ event: 'deployment.images', code })}\n`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
