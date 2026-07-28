import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const routesRoot = join(serverRoot, 'src', 'routes');
const outputPath = join(serverRoot, 'openapi', 'openapi.json');

async function routeFiles() {
  const names = await readdir(routesRoot);
  return names.filter((name) => name.endsWith('.ts') && name !== 'dev-storage.ts').map((name) => join(routesRoot, name));
}

function collectRoutes(source, file) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const routes = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression.getText(sourceFile);
      const method = node.expression.name.text.toLowerCase();
      const path = node.arguments[0];
      if (target === 'router' && ['get', 'post', 'put', 'patch', 'delete'].includes(method) && path && ts.isStringLiteral(path)) {
        const external = file.endsWith('wechat-events.ts');
        const internal = file.endsWith('storage-events.ts');
        const prefix = external || internal ? '' : '/api/v1';
        routes.push({ method, path: `${prefix}${path.text}`.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}'), file });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return routes;
}

const routes = [
  { method: 'get', path: '/health', file: join(serverRoot, 'src', 'app.ts') },
  { method: 'get', path: '/metrics', file: join(serverRoot, 'src', 'app.ts') },
];
for (const file of await routeFiles()) routes.push(...collectRoutes(await readFile(file, 'utf8'), file));
routes.sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));

const paths = {};
for (const route of routes) {
  paths[route.path] ??= {};
  paths[route.path][route.method] = {
    operationId: operationId(route.method, route.path),
    tags: [tagFor(route.path)],
    summary: `${route.method.toUpperCase()} ${route.path}`,
    'x-source': relative(serverRoot, route.file).replace(/\\/g, '/'),
    parameters: [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    })),
    ...(requestSchema(route) ? { requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${requestSchema(route)}` } } },
    } } : {}),
    responses: {
      200: { description: 'Successful response', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessEnvelope' } } } },
      400: { $ref: '#/components/responses/Error' },
      401: { $ref: '#/components/responses/Error' },
      429: { $ref: '#/components/responses/RateLimited' },
      500: { $ref: '#/components/responses/Error' },
    },
  };
}

const document = {
  openapi: '3.1.0',
  info: {
    title: '七日记（Note4Seven）API',
    version: '0.1.0',
    description: 'Generated route inventory with shared runtime contracts. Examples must use synthetic data.',
  },
  servers: [
    { url: 'https://staging.invalid', description: 'Staging placeholder; inject the real domain outside source control' },
  ],
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    responses: {
      Error: { description: 'Standard error envelope', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } },
      RateLimited: { description: 'Quota exceeded', headers: { 'Retry-After': { schema: { type: 'integer', minimum: 1 } } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } },
    },
    schemas: {
      PublicId: { type: 'string', pattern: '^[a-z]+_[0-9]+$' },
      Timestamp: { type: 'string', format: 'date-time' },
      SuccessEnvelope: {
        type: 'object', required: ['code', 'message', 'data', 'requestId', 'serverTime'], additionalProperties: false,
        properties: { code: { const: 'OK' }, message: { type: 'string' }, data: {}, requestId: { type: 'string' }, serverTime: { $ref: '#/components/schemas/Timestamp' } },
      },
      ErrorEnvelope: {
        type: 'object', required: ['code', 'message', 'requestId', 'serverTime'], additionalProperties: false,
        properties: { code: { type: 'string' }, message: { type: 'string' }, data: { type: ['object', 'null'] }, requestId: { type: 'string' }, serverTime: { $ref: '#/components/schemas/Timestamp' } },
      },
      LoginRequest: {
        type: 'object', required: ['clientRequestId'], additionalProperties: false,
        properties: { wxCode: { type: 'string', maxLength: 256 }, clientRequestId: { type: 'string', minLength: 8, maxLength: 64 } },
      },
      MediaReservationRequest: {
        type: 'object', required: ['clientRequestId', 'fileSize'], additionalProperties: true,
        properties: { clientRequestId: { type: 'string', minLength: 8, maxLength: 64 }, fileSize: { type: 'integer', minimum: 1, maximum: 10485760 } },
      },
      StorageObjectCreatedRequest: {
        type: 'object', required: ['bucket', 'objectKey', 'size', 'eventName'], additionalProperties: false,
        properties: { bucket: { type: 'string' }, objectKey: { type: 'string', pattern: '^media/[0-9]+/[0-9]+/original\\.jpg$' }, size: { type: 'integer', minimum: 1, maximum: 10485760 }, eventName: { type: 'string', pattern: '^cos:ObjectCreated:' } },
      },
    },
  },
};

const serialized = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes('--write')) {
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, serialized);
  console.log(`[openapi] wrote ${routes.length} operations to ${outputPath}`);
} else if (process.argv.includes('--check')) {
  const existing = await readFile(outputPath, 'utf8');
  if (existing !== serialized) {
    console.error('OpenAPI contract is out of date. Run npm run openapi:write and review the diff.');
    process.exitCode = 1;
  } else {
    console.log(`[openapi] ${routes.length} operations match the contract`);
  }
} else {
  process.stdout.write(serialized);
}

function operationId(method, path) {
  return `${method}_${path.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
}

function tagFor(path) {
  if (path.startsWith('/internal/')) return 'internal';
  if (path.startsWith('/wechat/')) return 'wechat-callback';
  return path.split('/').filter(Boolean)[1] ?? 'system';
}

function requestSchema(route) {
  if (route.method === 'post' && route.path === '/api/v1/auth/wechat/login') return 'LoginRequest';
  if (route.method === 'post' && route.path === '/api/v1/media/reservations') return 'MediaReservationRequest';
  if (route.method === 'post' && route.path === '/internal/storage/object-created') return 'StorageObjectCreatedRequest';
  return null;
}
