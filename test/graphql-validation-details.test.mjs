import {
  createGraphQLFormatError,
} from '../dist/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphQLError } from 'graphql';

function formattedFor(options) {
  const error = new GraphQLError(
    "Unknown field 'plusOneAgeCategory' on type 'PublicPlusOneInput'.",
    { path: ['CreateInvitationFromRsvp'] },
  );
  return createGraphQLFormatError(options)(
    {
      message: error.message,
      path: error.path,
      extensions: { code: 'BAD_USER_INPUT' },
    },
    error,
  );
}

test('validation error keeps code VALIDATION_ERROR and masked message', () => {
  const formatted = formattedFor({ serviceName: 'gateway' });
  assert.equal(formatted.extensions.code, 'VALIDATION_ERROR');
  assert.equal(formatted.extensions.httpStatus, 400);
  assert.match(formatted.message, /failed while processing/);
});

test('validation details are not exposed unless opted in', () => {
  const formatted = formattedFor({ serviceName: 'gateway' });
  assert.equal(formatted.extensions.metadata.details, undefined);
});

test('validation details are exposed under metadata.details when enabled', () => {
  const formatted = formattedFor({
    serviceName: 'gateway',
    exposeValidationDetails: true,
  });
  assert.equal(formatted.extensions.code, 'VALIDATION_ERROR');
  assert.match(formatted.message, /failed while processing/);
  assert.match(
    formatted.extensions.metadata.details,
    /Unknown field 'plusOneAgeCategory'/,
  );
});

test('internal errors never leak details even when validation details are enabled', () => {
  const error = new GraphQLError('boom', {
    originalError: new Error('boom'),
    path: ['CreateInvitationFromRsvp'],
  });
  const formatted = createGraphQLFormatError({
    serviceName: 'gateway',
    exposeValidationDetails: true,
  })(
    { message: error.message, path: error.path, extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    error,
  );

  assert.equal(formatted.extensions.metadata.details, undefined);
  assert.notEqual(formatted.extensions.httpStatus, 400);
});
