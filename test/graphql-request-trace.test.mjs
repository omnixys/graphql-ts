import {
  attachGraphQLErrorRequestContext,
  createGraphQLFormatError,
} from '../dist/index.js';
import {
  ContextMiddleware,
  DefaultClientIpResolver,
  DefaultCorrelationIdResolver,
  DefaultRequestIdResolver,
  setRequestTraceContext,
} from '@omnixys/context-ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphQLError } from 'graphql';

test('GraphQL errors keep request trace metadata after the request scope closes', () => {
  const request = {};
  setRequestTraceContext(request, { traceId: 'trace-1', spanId: 'span-1' });
  const error = new GraphQLError('guard failed', { path: ['credentialsLogin'] });

  const middleware = new ContextMiddleware(
    {},
    new DefaultRequestIdResolver(),
    new DefaultCorrelationIdResolver(),
    new DefaultClientIpResolver(),
  );
  middleware.use(request, {}, () => attachGraphQLErrorRequestContext(error, request));

  const formatted = createGraphQLFormatError({ serviceName: 'authentication' })(
    {
      message: error.message,
      path: error.path,
      extensions: error.extensions,
    },
    error,
  );

  assert.equal(formatted.extensions.code, 'AUTHENTICATION_INTERNAL_ERROR');
  assert.equal(formatted.extensions.operation, 'credentialsLogin');
  assert.equal(typeof formatted.extensions.requestId, 'string');
  assert.equal(typeof formatted.extensions.correlationId, 'string');
  assert.equal(formatted.extensions.traceId, 'trace-1');
  assert.equal(formatted.extensions.spanId, 'span-1');
});
