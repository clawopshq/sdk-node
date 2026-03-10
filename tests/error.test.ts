import { describe, it, expect } from 'vitest';
import {
  ClawOpsError,
  APIError,
  APIStatusError,
  BadRequestError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  InternalServerError,
  ServiceUnavailableError,
  APIConnectionError,
  APITimeoutError,
  APIResponseValidationError,
  AgentError,
  AgentConnectionError,
  makeStatusError,
} from '../src/error.js';

const dummyRequest = { method: 'GET', url: 'https://api.example.com/test' };
const dummyResponse = { status: 400, headers: undefined };

describe('Error hierarchy', () => {
  it('ClawOpsError extends Error', () => {
    const err = new ClawOpsError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ClawOpsError);
    expect(err.name).toBe('ClawOpsError');
    expect(err.message).toBe('test');
  });

  it('APIError extends ClawOpsError', () => {
    const err = new APIError('test', dummyRequest);
    expect(err).toBeInstanceOf(ClawOpsError);
    expect(err).toBeInstanceOf(APIError);
    expect(err.name).toBe('APIError');
    expect(err.request).toEqual(dummyRequest);
  });

  it('APIStatusError extends APIError', () => {
    const err = new APIStatusError('test', { status: 400 }, { error: 'bad' }, dummyRequest);
    expect(err).toBeInstanceOf(APIError);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ error: 'bad' });
  });

  it('BadRequestError extends APIStatusError with status 400', () => {
    const err = new BadRequestError('bad', dummyResponse, null, dummyRequest);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.status).toBe(400);
    expect(err.name).toBe('BadRequestError');
  });

  it('AuthenticationError extends APIStatusError with status 401', () => {
    const err = new AuthenticationError('unauth', { status: 401 }, null, dummyRequest);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.status).toBe(401);
    expect(err.name).toBe('AuthenticationError');
  });

  it('PermissionDeniedError extends APIStatusError with status 403', () => {
    const err = new PermissionDeniedError('denied', { status: 403 }, null, dummyRequest);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.status).toBe(403);
  });

  it('NotFoundError extends APIStatusError with status 404', () => {
    const err = new NotFoundError('not found', { status: 404 }, null, dummyRequest);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.status).toBe(404);
  });

  it('ConflictError extends APIStatusError with status 409', () => {
    const err = new ConflictError('conflict', { status: 409 }, null, dummyRequest);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.status).toBe(409);
  });

  it('UnprocessableEntityError extends APIStatusError with status 422', () => {
    const err = new UnprocessableEntityError('invalid', { status: 422 }, null, dummyRequest);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.status).toBe(422);
  });

  it('InternalServerError extends APIStatusError with status 500', () => {
    const err = new InternalServerError('server error', { status: 500 }, null, dummyRequest);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.status).toBe(500);
  });

  it('ServiceUnavailableError extends APIStatusError with status 503', () => {
    const err = new ServiceUnavailableError('unavailable', { status: 503 }, null, dummyRequest);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.status).toBe(503);
  });

  it('APIConnectionError extends APIError', () => {
    const err = new APIConnectionError(dummyRequest);
    expect(err).toBeInstanceOf(APIError);
    expect(err.message).toBe('Connection error.');
    expect(err.name).toBe('APIConnectionError');
  });

  it('APITimeoutError extends APIConnectionError', () => {
    const err = new APITimeoutError(dummyRequest);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.message).toBe('Request timed out.');
    expect(err.name).toBe('APITimeoutError');
  });

  it('APIResponseValidationError extends APIError', () => {
    const err = new APIResponseValidationError({ status: 200 }, dummyRequest);
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(200);
    expect(err.name).toBe('APIResponseValidationError');
  });

  it('AgentError extends ClawOpsError', () => {
    const err = new AgentError('agent fail');
    expect(err).toBeInstanceOf(ClawOpsError);
    expect(err.name).toBe('AgentError');
  });

  it('AgentConnectionError extends AgentError', () => {
    const err = new AgentConnectionError();
    expect(err).toBeInstanceOf(AgentError);
    expect(err.name).toBe('AgentConnectionError');
    expect(err.message).toBe('Agent WebSocket connection failed.');
  });
});

describe('makeStatusError', () => {
  const headers = new Headers();

  it('maps 400 to BadRequestError', () => {
    const err = makeStatusError(400, { error: 'bad request' }, headers, dummyRequest);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('bad request');
  });

  it('maps 401 to AuthenticationError', () => {
    const err = makeStatusError(401, { error: 'unauthorized' }, headers, dummyRequest);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.status).toBe(401);
  });

  it('maps 403 to PermissionDeniedError', () => {
    const err = makeStatusError(403, null, headers, dummyRequest);
    expect(err).toBeInstanceOf(PermissionDeniedError);
  });

  it('maps 404 to NotFoundError', () => {
    const err = makeStatusError(404, null, headers, dummyRequest);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('maps 409 to ConflictError', () => {
    const err = makeStatusError(409, null, headers, dummyRequest);
    expect(err).toBeInstanceOf(ConflictError);
  });

  it('maps 422 to UnprocessableEntityError', () => {
    const err = makeStatusError(422, null, headers, dummyRequest);
    expect(err).toBeInstanceOf(UnprocessableEntityError);
  });

  it('maps 500 to InternalServerError', () => {
    const err = makeStatusError(500, { error: 'internal' }, headers, dummyRequest);
    expect(err).toBeInstanceOf(InternalServerError);
    expect(err.message).toBe('internal');
  });

  it('maps 503 to ServiceUnavailableError', () => {
    const err = makeStatusError(503, null, headers, dummyRequest);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
  });

  it('maps unknown 5xx to InternalServerError', () => {
    const err = makeStatusError(502, null, headers, dummyRequest);
    expect(err).toBeInstanceOf(InternalServerError);
  });

  it('maps unknown 4xx to APIStatusError (not a subclass)', () => {
    const err = makeStatusError(418, null, headers, dummyRequest);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.constructor).toBe(APIStatusError);
  });

  it('uses body.error as message when available', () => {
    const err = makeStatusError(400, { error: 'custom message' }, headers, dummyRequest);
    expect(err.message).toBe('custom message');
  });

  it('uses "HTTP {status}" as message when body has no error', () => {
    const err = makeStatusError(400, null, headers, dummyRequest);
    expect(err.message).toBe('HTTP 400');
  });

  it('preserves headers and body on the error', () => {
    const body = { error: 'test', details: ['field required'] };
    const err = makeStatusError(400, body, headers, dummyRequest);
    expect(err.body).toEqual(body);
    expect(err.headers).toBe(headers);
  });
});
