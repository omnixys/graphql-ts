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

test('internal errors include reason in metadata with the original error message', () => {
  const error = new GraphQLError("Cannot query field 'foo' on type 'Bar'.", {
    originalError: new Error("Cannot query field 'foo' on type 'Bar'."),
    path: ['Query', 'foo'],
  });
  const formatted = createGraphQLFormatError({
    serviceName: 'gateway',
    exposeValidationDetails: true,
  })(
    { message: error.message, path: error.path, extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    error,
  );

  assert.equal(formatted.extensions.httpStatus, 500);
  assert.match(formatted.message, /failed while processing/);
  assert.match(formatted.extensions.metadata.reason, /Cannot query field 'foo' on type 'Bar'/);
});

test('structured 5xx reason is preserved over the raw error message', () => {
  const error = new GraphQLError('Guest sign-up could not be completed', {
    originalError: new Error('Guest sign-up could not be completed'),
    path: ['verifyGuestSignUp'],
  });
  const formatted = createGraphQLFormatError({ serviceName: 'gateway' })(
    {
      message: error.message,
      path: error.path,
      extensions: {
        code: 'GATEWAY_INTERNAL_ERROR',
        httpStatus: 500,
        retryable: false,
        summary: 'Gateway error.',
        metadata: { reason: 'provisioning-incomplete' },
      },
    },
    error,
  );

  assert.equal(formatted.extensions.code, 'GATEWAY_INTERNAL_ERROR');
  assert.equal(formatted.extensions.httpStatus, 500);
  assert.equal(formatted.extensions.retryable, false);
  assert.equal(formatted.extensions.metadata.reason, 'provisioning-incomplete');
  assert.match(formatted.message, /failed while processing/);
});

test('GATEWAY_INTERNAL_ERROR from unknown code includes reason in metadata', () => {
  const error = new GraphQLError('some resolver blew up', {
    originalError: new Error('some resolver blew up'),
    path: ['CreateEvent'],
  });
  const formatted = createGraphQLFormatError({ serviceName: 'gateway' })(
    { message: error.message, path: error.path, extensions: { code: 'SOME_UNKNOWN_CODE' } },
    error,
  );

  assert.equal(formatted.extensions.code, 'GATEWAY_INTERNAL_ERROR');
  assert.equal(formatted.extensions.httpStatus, 500);
  assert.match(formatted.extensions.metadata.reason, /some resolver blew up/);
});

test('validation errors (400) do not include reason in metadata', () => {
  const error = new GraphQLError("Unknown field 'plusOneAgeCategory'.", {
    path: ['CreateInvitationFromRsvp'],
  });
  const formatted = createGraphQLFormatError({
    serviceName: 'gateway',
    exposeValidationDetails: true,
  })(
    { message: error.message, path: error.path, extensions: { code: 'BAD_USER_INPUT' } },
    error,
  );

  assert.equal(formatted.extensions.httpStatus, 400);
  assert.equal(formatted.extensions.metadata.reason, undefined);
});
