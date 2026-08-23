import { Catch, HttpException, Optional } from "@nestjs/common";
import { ContextAccessor } from "@omnixys/context-ts";
import {
  ErrorCode,
  getErrorDefinition,
  getPublicErrorMetadata,
  isKnownErrorCode,
} from "@omnixys/contracts-ts";
import { GqlExceptionFilter } from "@nestjs/graphql";
import { OmnixysLogger } from "@omnixys/logger-ts";
import { GraphQLError, type GraphQLFormattedError } from "graphql";

export interface FrameworkErrorLike {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly operation?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly summary?: string;
  readonly httpStatus?: number;
  readonly retryable?: boolean;
}

export interface GraphQLExceptionMappingOptions {
  readonly exposeInternalErrors?: boolean;
  readonly serviceName?: string;
  readonly preserveSafeSubgraphExtensions?: boolean;
}

export class BaseGraphQLException extends GraphQLError {
  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    _compatibilityExtensions: Readonly<Record<string, unknown>> = {},
  ) {
    const definition = getErrorDefinition(code);
    const safeDetails = publicMetadata(code, details);
    super(message, {
      extensions: {
        code,
        summary: definition.summary,
        httpStatus: definition.httpStatus,
        retryable: definition.retryable,
        service: serviceOf(),
        operation: operationOf(),
        ...errorContext(),
        timestamp: new Date().toISOString(),
        metadata: safeDetails,
      },
    });
  }
}

/** @deprecated Prefer `BaseGraphQLException`. */
export class FrameworkGraphQLException extends BaseGraphQLException {}

export interface CreateGraphQLExceptionInput {
  readonly code: string;
  readonly message?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function createGraphQLException(
  input: CreateGraphQLExceptionInput,
): GraphQLError {
  const definition = getErrorDefinition(input.code);
  return new BaseGraphQLException(
    input.code,
    input.message ?? definition.defaultMessage,
    input.metadata,
  );
}

export function validationGraphQLError(
  message?: string,
  metadata?: Readonly<Record<string, unknown>>,
): GraphQLError {
  return createGraphQLException({
    code: ErrorCode.VALIDATION_ERROR,
    message,
    metadata,
  });
}

export function unauthenticatedGraphQLError(message?: string): GraphQLError {
  return createGraphQLException({ code: ErrorCode.UNAUTHENTICATED, message });
}

export function forbiddenGraphQLError(message?: string): GraphQLError {
  return createGraphQLException({ code: ErrorCode.FORBIDDEN, message });
}

export function notFoundGraphQLError(
  code: string,
  message?: string,
  metadata?: Readonly<Record<string, unknown>>,
): GraphQLError {
  return createGraphQLException({ code, message, metadata });
}

export function conflictGraphQLError(
  code: string,
  message?: string,
  metadata?: Readonly<Record<string, unknown>>,
): GraphQLError {
  return createGraphQLException({ code, message, metadata });
}

export function rateLimitGraphQLError(message?: string): GraphQLError {
  return createGraphQLException({
    code: ErrorCode.RATE_LIMIT_EXCEEDED,
    message,
  });
}

export function dependencyUnavailableGraphQLError(
  code: string = ErrorCode.SERVICE_UNAVAILABLE,
  message?: string,
): GraphQLError {
  return createGraphQLException({ code, message });
}

export function internalGraphQLError(
  code: string = ErrorCode.INTERNAL_SERVER_ERROR,
): GraphQLError {
  return createGraphQLException({ code });
}

export function toGraphQLError(
  error: unknown,
  options: GraphQLExceptionMappingOptions = {},
): GraphQLError {
  if (error instanceof GraphQLError && !structuredError(error.originalError)) {
    const rawCode = codeOf(error.extensions.code);
    const code = normalizeGraphQLErrorCode(rawCode, options.serviceName);
    const definition = getErrorDefinition(code);
    const httpStatus =
      numberOf(error.extensions.httpStatus) ?? definition.httpStatus;
    const meta = publicMetadata(
      code,
      recordOf(error.extensions.metadata) ?? recordOf(error.extensions.details),
    );
    const context = errorContext(
      traceContextOf(error.originalError),
      error.extensions,
    );
    return new GraphQLError(
      options.exposeInternalErrors ||
        (isKnownErrorCode(rawCode) && httpStatus < 500)
        ? error.message
        : publicInternalMessage(
            serviceOf(options.serviceName),
            operationOf(
              error.extensions,
              error.path,
              traceContextOf(error.originalError),
            ),
          ),
      {
        nodes: error.nodes,
        source: error.source,
        positions: error.positions,
        path: error.path,
        originalError: error.originalError,
        extensions: {
          code,
          summary: stringOf(error.extensions.summary) ?? definition.summary,
          httpStatus,
          retryable:
            booleanOf(error.extensions.retryable) ?? definition.retryable,
          service: serviceOf(options.serviceName),
          operation: operationOf(
            error.extensions,
            error.path,
            traceContextOf(error.originalError),
          ),
          ...context,
          timestamp: timestampOf(error.extensions.timestamp),
          metadata: meta,
        },
      },
    );
  }
  const structured = structuredError(
    error instanceof GraphQLError ? error.originalError : error,
  );
  const sourceError =
    error instanceof GraphQLError ? error.originalError : error;
  const httpException = httpExceptionOf(error);
  const mappedHttpStatus = httpException?.getStatus();
  const context = errorContext(structured ?? traceContextOf(sourceError));
  const code =
    structured?.code ??
    (mappedHttpStatus
      ? codeForHttpStatus(mappedHttpStatus)
      : internalCodeForService(options.serviceName));
  const definition = getErrorDefinition(code);
  const httpStatus =
    structured?.httpStatus ?? mappedHttpStatus ?? definition.httpStatus;
  const message =
    options.exposeInternalErrors || httpStatus < 500
      ? (structured?.message ?? messageOf(error))
      : publicInternalMessage(
          serviceOf(options.serviceName),
          operationOf(
            undefined,
            undefined,
            structured ?? traceContextOf(sourceError),
          ),
        );
  const meta = publicMetadata(code, structured?.metadata);

  return new GraphQLError(message, {
    originalError: error instanceof Error ? error : undefined,
    extensions: {
      code,
      summary: structured?.summary ?? definition.summary,
      httpStatus,
      retryable: structured?.retryable ?? definition.retryable,
      service: serviceOf(options.serviceName),
      operation: operationOf(),
      ...context,
      timestamp: new Date().toISOString(),
      metadata: meta,
    },
  });
}

export function createGraphQLFormatError(
  options: GraphQLExceptionMappingOptions = {},
): (formatted: GraphQLFormattedError, error: unknown) => GraphQLFormattedError {
  return (formatted, error) => {
    const graphQLError = error instanceof GraphQLError ? error : undefined;
    const original = graphQLError?.originalError ?? error;
    const structured = structuredError(original);
    const httpException =
      original instanceof HttpException ? original : undefined;
    const rawCode =
      structured?.code ??
      (httpException
        ? codeForHttpStatus(httpException.getStatus())
        : undefined) ??
      (typeof formatted.extensions?.code === "string"
        ? formatted.extensions.code
        : internalCodeForService(options.serviceName));
    const code = normalizeGraphQLErrorCode(rawCode, options.serviceName);
    const definition = getErrorDefinition(code);
    const safeClientError =
      structured !== undefined || isKnownErrorCode(rawCode);
    const operation = operationOf(
      formatted.extensions,
      formatted.path,
      structured ?? traceContextOf(original),
    );
    const context = errorContext(
      structured ?? traceContextOf(original),
      formatted.extensions,
    );
    const meta = publicMetadata(
      code,
      structured?.metadata ??
        recordOf(formatted.extensions?.metadata) ??
        recordOf(formatted.extensions?.details),
    );

    return {
      ...formatted,
      message:
        options.exposeInternalErrors ||
        (safeClientError && definition.httpStatus < 500)
          ? formatted.message
          : publicInternalMessage(serviceOf(options.serviceName), operation),
      extensions: {
        code,
        summary:
          structured?.summary ??
          stringOf(formatted.extensions?.summary) ??
          definition.summary,
        httpStatus:
          structured?.httpStatus ??
          numberOf(formatted.extensions?.httpStatus) ??
          definition.httpStatus,
        retryable:
          structured?.retryable ??
          booleanOf(formatted.extensions?.retryable) ??
          definition.retryable,
        service: options.preserveSafeSubgraphExtensions
          ? (stringOf(formatted.extensions?.service) ??
            serviceOf(options.serviceName))
          : serviceOf(options.serviceName),
        operation: options.preserveSafeSubgraphExtensions
          ? (stringOf(formatted.extensions?.operation) ?? operation)
          : operation,
        ...context,
        timestamp: timestampOf(formatted.extensions?.timestamp),
        metadata: meta,
      },
    };
  };
}

function httpExceptionOf(error: unknown): HttpException | undefined {
  if (error instanceof HttpException) return error;
  if (
    error instanceof GraphQLError &&
    error.originalError instanceof HttpException
  ) {
    return error.originalError;
  }
  return undefined;
}

function codeForHttpStatus(status: number): ErrorCode {
  if (status === 400 || status === 422) return ErrorCode.VALIDATION_ERROR;
  if (status === 401) return ErrorCode.UNAUTHENTICATED;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 409) return ErrorCode.CONFLICT;
  if (status === 429) return ErrorCode.RATE_LIMIT_EXCEEDED;
  if (status === 502 || status === 503 || status === 504) {
    return ErrorCode.DEPENDENCY_UNAVAILABLE;
  }
  return ErrorCode.INTERNAL_SERVER_ERROR;
}

function normalizeGraphQLErrorCode(code: string, serviceName?: string): string {
  if (isKnownErrorCode(code)) return code;
  if (code === "BAD_USER_INPUT" || code === "GRAPHQL_VALIDATION_FAILED") {
    return ErrorCode.VALIDATION_ERROR;
  }
  if (code === "UNAUTHENTICATED") return ErrorCode.UNAUTHENTICATED;
  if (code === "FORBIDDEN") return ErrorCode.FORBIDDEN;
  if (code === "DOWNSTREAM_SERVICE_ERROR") {
    return ErrorCode.DEPENDENCY_UNAVAILABLE;
  }
  return serviceOf(serviceName) === "gateway"
    ? ErrorCode.GATEWAY_INTERNAL_ERROR
    : internalCodeForService(serviceName);
}

function internalCodeForService(serviceName?: string): ErrorCode {
  const codes: Readonly<Record<string, ErrorCode>> = {
    analytics: ErrorCode.ANALYTICS_INTERNAL_ERROR,
    authentication: ErrorCode.AUTHENTICATION_INTERNAL_ERROR,
    blog: ErrorCode.BLOG_INTERNAL_ERROR,
    event: ErrorCode.EVENT_INTERNAL_ERROR,
    gateway: ErrorCode.GATEWAY_INTERNAL_ERROR,
    invitation: ErrorCode.INVITATION_INTERNAL_ERROR,
    notification: ErrorCode.NOTIFICATION_INTERNAL_ERROR,
    profile: ErrorCode.PROFILE_INTERNAL_ERROR,
    seat: ErrorCode.SEAT_INTERNAL_ERROR,
    "shopping-cart": ErrorCode.SHOPPING_CART_INTERNAL_ERROR,
    ticket: ErrorCode.TICKET_INTERNAL_ERROR,
    user: ErrorCode.USER_INTERNAL_ERROR,
  };
  return codes[serviceOf(serviceName)] ?? ErrorCode.INTERNAL_SERVER_ERROR;
}

export function createFrameworkGraphQLError(
  code: string,
  message: string,
  metadata: Readonly<Record<string, unknown>> = {},
  compatibilityExtensions: Readonly<Record<string, unknown>> = {},
): GraphQLError {
  return new FrameworkGraphQLException(
    code,
    message,
    metadata,
    compatibilityExtensions,
  );
}

@Catch()
export class GraphQLExceptionFilter implements GqlExceptionFilter {
  constructor(@Optional() _logger?: OmnixysLogger) {}

  catch(exception: unknown): GraphQLError {
    const mapped = toGraphQLError(exception);
    return mapped;
  }
}

function structuredError(value: unknown): FrameworkErrorLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<FrameworkErrorLike>;
  return typeof candidate.code === "string" &&
    typeof candidate.message === "string"
    ? (candidate as FrameworkErrorLike)
    : undefined;
}

function traceContextOf(value: unknown): FrameworkErrorLike | undefined {
  const seen = new Set<object>();
  let current = value;
  let traceId: string | undefined;
  let spanId: string | undefined;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      traceId?: unknown;
      spanId?: unknown;
      operation?: unknown;
      originalError?: unknown;
      cause?: unknown;
    };
    traceId ??= stringOf(candidate.traceId);
    spanId ??= stringOf(candidate.spanId);
    const operation = stringOf(candidate.operation);
    if (traceId || spanId) {
      return {
        code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: "Internal server error",
        traceId,
        spanId,
        operation,
        metadata: {},
      };
    }
    current = candidate.originalError ?? candidate.cause;
  }

  return undefined;
}

function errorContext(
  error?: FrameworkErrorLike,
  formattedExtensions?: Readonly<Record<string, unknown>>,
) {
  const context = ContextAccessor.get();
  const traceId =
    scopedId(stringOf(formattedExtensions?.traceId)) ??
    scopedId(error?.traceId) ??
    context?.trace?.traceId;
  const spanId =
    scopedId(stringOf(formattedExtensions?.spanId)) ??
    scopedId(error?.spanId) ??
    context?.trace?.spanId;
  return {
    requestId: scopedId(error?.requestId) ?? context?.requestId ?? "unscoped",
    correlationId:
      scopedId(error?.correlationId) ??
      context?.correlationId ??
      context?.requestId ??
      "unscoped",
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
  };
}

function scopedId(value: string | undefined): string | undefined {
  return value && value !== "unscoped" ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Internal server error";
}

const SENSITIVE_DETAIL_KEY =
  /(?:authorization|cookie|password|secret|token|credential|private.?key|api.?key)/i;
export function sanitizeDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (!details) return {};
  return sanitizeRecord(details, 0, new WeakSet<object>());
}

function sanitizeRecord(
  value: Readonly<Record<string, unknown>>,
  depth: number,
  seen: WeakSet<object>,
): Readonly<Record<string, unknown>> {
  if (seen.has(value)) return {};
  seen.add(value);
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) continue;
    const sanitized = sanitizeValue(entry, depth + 1, seen);
    if (sanitized !== undefined) safe[key] = sanitized;
  }
  return safe;
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth > 5) return "[truncated]";
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((entry) => sanitizeValue(entry, depth + 1, seen))
      .filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") {
    return sanitizeRecord(
      value as Readonly<Record<string, unknown>>,
      depth,
      seen,
    );
  }
  return undefined;
}

function recordOf(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function codeOf(value: unknown): string {
  return typeof value === "string" ? value : ErrorCode.INTERNAL_SERVER_ERROR;
}

function publicMetadata(
  code: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  return sanitizeDetails(getPublicErrorMetadata(code, metadata));
}

function serviceOf(configured?: string): string {
  const raw =
    configured ??
    process.env.OTEL_SERVICE_NAME ??
    process.env.SERVICE ??
    process.env.SERVICE_NAME ??
    "unknown";
  return raw
    .replace(/^omnixys[-_]/, "")
    .replace(/[-_]service$/, "")
    .replace(/_/g, "-");
}

function operationOf(
  extensions?: Readonly<Record<string, unknown>>,
  path?: readonly (string | number)[],
  error?: FrameworkErrorLike,
): string {
  return (
    stringOf(extensions?.operation) ??
    stringOf(error?.operation) ??
    ContextAccessor.get()?.transport?.operation ??
    (typeof path?.[0] === "string" ? path[0] : undefined) ??
    "unknown"
  );
}

function publicInternalMessage(service: string, operation: string): string {
  const normalizedService = service === "unknown" ? "Application" : service;
  const normalizedOperation =
    operation === "unknown" ? "the request" : operation;
  const displayService = normalizedService
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `${displayService} service failed while processing ${normalizedOperation}.`;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function timestampOf(value: unknown): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : new Date().toISOString();
}
