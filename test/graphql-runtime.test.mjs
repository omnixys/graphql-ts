import { ContextAccessor } from "@omnixys/context-ts";
import { LazyMetadataStorage } from "@nestjs/graphql/dist/schema-builder/storages/lazy-metadata.storage.js";
import { TypeMetadataStorage } from "@nestjs/graphql/dist/schema-builder/storages/type-metadata.storage.js";
import {
  AddAddressInput,
  AddContactInput,
  BaseGraphQLException,
  ContactInput,
  CreateUserInput,
  EventAddressInput,
  FrameworkGraphQLException,
  GraphQLExceptionFilter,
  OmnixysGraphQLModule,
  SeatOccupiedException,
  UserAddressInput,
  accessBlocked,
  createGraphQLConfig,
  createGraphQLFormatError,
  getRegisteredGraphQLEnumNames,
  registerEnum,
  registerOmnixysGraphQLEnums,
} from "../dist/index.js";
import assert from "node:assert/strict";
import test from "node:test";
import { GraphQLError } from "graphql";
import { NotFoundException } from "@nestjs/common";

test("all platform enums are registered deterministically and idempotently", () => {
  registerOmnixysGraphQLEnums();
  registerOmnixysGraphQLEnums();

  assert.deepEqual(getRegisteredGraphQLEnumNames(), [
    "MessageDirection",
    "ContactOptionsType",
    "GenderType",
    "InterestType",
    "MaritalStatusType",
    "PersonStatusType",
    "PhoneNumberType",
    "RelationshipType",
    "StatusType",
    "UserType",
    "RealmRoleType",
    "InterestCategoryType",
  ]);
});

test("enum registration rejects conflicting ownership of a schema name", () => {
  const first = { A: "A" };
  registerEnum("TestOnlyEnum", first);
  registerEnum("TestOnlyEnum", first);
  assert.throws(
    () => registerEnum("TestOnlyEnum", { B: "B" }),
    /already registered/,
  );
});

test("input metadata matches runtime object types and nullability", () => {
  LazyMetadataStorage.load();
  TypeMetadataStorage.compile();

  assert.equal(field(AddAddressInput, "address").typeFn(), UserAddressInput);
  assert.equal(field(AddContactInput, "Contact").typeFn(), ContactInput);
  assert.equal(field(EventAddressInput, "city").options.nullable, undefined);
  assert.equal(field(EventAddressInput, "country").options.nullable, undefined);
  assert.equal(field(CreateUserInput, "addresses").options.nullable, true);
});

test("structured domain errors map to stable GraphQL extensions", () => {
  const formatter = createGraphQLFormatError();
  const domainError = Object.assign(new Error("User does not exist"), {
    code: "USER_NOT_FOUND",
    requestId: "request-domain",
    correlationId: "correlation-domain",
    traceId: "trace-domain",
    actorId: "actor-domain",
    tenantId: "tenant-domain",
    metadata: { userId: "user-1" },
  });
  const error = new GraphQLError(domainError.message, {
    originalError: domainError,
  });
  const formatted = formatter(
    { message: domainError.message, extensions: {} },
    error,
  );

  assert.equal(formatted.message, "User does not exist");
  assert.equal(formatted.extensions.code, "USER_NOT_FOUND");
  assert.equal(formatted.extensions.requestId, "request-domain");
  assert.equal(formatted.extensions.correlationId, "correlation-domain");
  assert.equal(formatted.extensions.traceId, "trace-domain");
  assert.equal("actorId" in formatted.extensions, false);
  assert.equal("tenantId" in formatted.extensions, false);
  assert.equal(formatted.extensions.httpStatus, 404);
  assert.equal(formatted.extensions.retryable, false);
  assert.equal(formatted.extensions.summary, "User not found.");
  assert.equal(typeof formatted.extensions.service, "string");
  assert.equal(typeof formatted.extensions.operation, "string");
  assert.deepEqual(formatted.extensions.metadata, { userId: "user-1" });
  assert.match(formatted.extensions.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("typed GraphQL exceptions expose codes and redact sensitive details", () => {
  const error = new SeatOccupiedException("seat-1", {
    sectionId: "section-1",
    accessToken: "must-not-leak",
    nested: { password: "must-not-leak", row: 2 },
  });

  assert.ok(error instanceof BaseGraphQLException);
  assert.equal(error.extensions.code, "SEAT_OCCUPIED");
  assert.deepEqual(error.extensions.metadata, {
    seatId: "seat-1",
    sectionId: "section-1",
  });
  assert.match(error.extensions.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("unscoped domain errors inherit the active canonical context", () => {
  ContextAccessor.run(
    { requestId: "request-active", correlationId: "correlation-active" },
    () => {
      const formatter = createGraphQLFormatError();
      const domainError = Object.assign(new Error("User does not exist"), {
        code: "USER_NOT_FOUND",
        requestId: "unscoped",
        correlationId: "unscoped",
      });
      const formatted = formatter(
        { message: domainError.message, extensions: {} },
        new GraphQLError(domainError.message, { originalError: domainError }),
      );

      assert.equal(formatted.extensions.requestId, "request-active");
      assert.equal(formatted.extensions.correlationId, "correlation-active");
    },
  );
});

test("unknown resolver errors are redacted but retain canonical diagnostics", () => {
  ContextAccessor.run(
    {
      requestId: "request-1",
      correlationId: "correlation-1",
      actorId: "actor-1",
      tenantId: "tenant-1",
      traceId: "trace-1",
    },
    () => {
      const formatter = createGraphQLFormatError();
      const formatted = formatter(
        { message: "database password leaked", extensions: {} },
        new Error("database password leaked"),
      );

      assert.equal(formatted.message, "An unexpected error occurred.");
      assert.equal(formatted.extensions.code, "INTERNAL_SERVER_ERROR");
      assert.equal(formatted.extensions.requestId, "request-1");
      assert.equal(formatted.extensions.correlationId, "correlation-1");
      assert.equal(formatted.extensions.traceId, "trace-1");
      assert.equal("actorId" in formatted.extensions, false);
      assert.equal("tenantId" in formatted.extensions, false);
      assert.equal(formatted.extensions.httpStatus, 500);
    },
  );
});

test("legacy Nest HTTP exceptions receive stable GraphQL codes", () => {
  const exception = new NotFoundException("Report not found.");
  const formatted = createGraphQLFormatError({ serviceName: "blog" })(
    { message: exception.message, extensions: {} },
    new GraphQLError(exception.message, { originalError: exception }),
  );

  assert.equal(formatted.extensions.code, "NOT_FOUND");
  assert.equal(formatted.extensions.httpStatus, 404);
  assert.equal(formatted.message, "Report not found.");
});

test("compatibility security errors now include canonical identifiers", () => {
  ContextAccessor.run(
    { requestId: "request-2", correlationId: "correlation-2" },
    () => {
      const error = accessBlocked(["risk"]);
      assert.ok(error instanceof FrameworkGraphQLException);
      assert.equal(error.extensions.code, "ACCESS_BLOCKED");
      assert.equal(error.extensions.requestId, "request-2");
      assert.equal(error.extensions.correlationId, "correlation-2");
      assert.equal("reasons" in error.extensions, false);
      assert.deepEqual(error.extensions.metadata, {});
    },
  );
});

test("GraphQL exception filter maps without duplicating request error logs", () => {
  const calls = [];
  const logger = {
    child() {
      return {
        error(message, metadata) {
          calls.push({ message, metadata });
        },
      };
    },
  };
  const filter = new GraphQLExceptionFilter(logger);
  const mapped = filter.catch(
    Object.assign(new Error("Unauthorized tenant"), {
      code: "UNAUTHORIZED_TENANT",
      requestId: "request-3",
    }),
  );

  assert.equal(mapped.extensions.code, "UNAUTHORIZED_TENANT");
  assert.equal(mapped.extensions.requestId, "request-3");
  assert.equal(calls.length, 0);
});

test("GraphQL extensions contain only the public error contract", () => {
  const cause = Object.assign(new Error("database password leaked"), {
    response: { data: { client_secret: "must-not-leak" } },
  });
  const domainError = Object.assign(
    new Error("The requested user was not found."),
    {
      code: "USER_NOT_FOUND",
      summary: "User lookup failed.",
      httpStatus: 404,
      retryable: false,
      actorId: "actor-secret",
      tenantId: "tenant-secret",
      metadata: {
        userId: "user-1",
        password: "must-not-leak",
        sql: "select *",
      },
      diagnostics: { sql: "select *" },
      cause,
    },
  );
  const mapped = GraphQLExceptionFilter.prototype.catch.call(
    new GraphQLExceptionFilter(),
    domainError,
  );

  assert.deepEqual(Object.keys(mapped.extensions).sort(), [
    "code",
    "correlationId",
    "httpStatus",
    "metadata",
    "operation",
    "requestId",
    "retryable",
    "service",
    "summary",
    "timestamp",
    "traceId",
  ].filter((key) => mapped.extensions[key] !== undefined).sort());
  assert.deepEqual(mapped.extensions.metadata, { userId: "user-1" });
  const json = JSON.stringify(mapped);
  assert.equal(json.includes("actor-secret"), false);
  assert.equal(json.includes("tenant-secret"), false);
  assert.equal(json.includes("must-not-leak"), false);
  assert.equal(json.includes("select *"), false);
});

test("federation configuration is production-safe and override-compatible", () => {
  const config = createGraphQLConfig({ introspection: false, path: "/query" });
  assert.deepEqual(config.autoSchemaFile, {
    path: "dist/schema.gql",
    federation: 2,
  });
  assert.equal(config.stopOnApplicationShutdown, true);
  assert.equal(config.csrfPrevention, true);
  assert.equal(config.debug, false);
  assert.equal(config.introspection, false);
  assert.equal(config.path, "/query");
  assert.equal(typeof config.formatError, "function");

  const syncModule = OmnixysGraphQLModule.forRoot();
  const asyncModule = OmnixysGraphQLModule.forRootAsync({
    useFactory: () => ({ introspection: false }),
  });
  assert.equal(syncModule.imports.length, 1);
  assert.equal(asyncModule.imports.length, 1);
  assert.ok(syncModule.providers.includes(GraphQLExceptionFilter));
});

test("Fastify context preserves positional request and reply values", async () => {
  const config = createGraphQLConfig();
  const req = { id: "request-1" };
  const reply = { setCookie() {} };

  const context = await config.context(req, reply);

  assert.equal(context.req, req);
  assert.equal(context.reply, reply);
});

function field(target, name) {
  const metadata = TypeMetadataStorage.getInputTypeMetadataByTarget(target);
  const property = metadata?.properties?.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(property, `Missing GraphQL field ${target.name}.${name}`);
  return property;
}
