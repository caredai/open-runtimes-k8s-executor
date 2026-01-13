/**
 * Error types
 */
export const ErrorType = {
  GENERAL_UNKNOWN: 'general_unknown',
  GENERAL_ROUTE_NOT_FOUND: 'general_route_not_found',
  GENERAL_UNAUTHORIZED: 'general_unauthorized',
  EXECUTION_BAD_REQUEST: 'execution_bad_request',
  EXECUTION_TIMEOUT: 'execution_timeout',
  EXECUTION_BAD_JSON: 'execution_bad_json',
  RUNTIME_NOT_FOUND: 'runtime_not_found',
  RUNTIME_CONFLICT: 'runtime_conflict',
  RUNTIME_FAILED: 'runtime_failed',
  RUNTIME_TIMEOUT: 'runtime_timeout',
  LOGS_TIMEOUT: 'logs_timeout',
  COMMAND_TIMEOUT: 'command_timeout',
  COMMAND_FAILED: 'command_failed',
} as const

export type ErrorType = (typeof ErrorType)[keyof typeof ErrorType]

/**
 * Create an error response
 */
export function createErrorResponse(
  type: ErrorType,
  message: string,
  code: number = 500,
): { type: string; message: string; code: number } {
  return {
    type,
    message,
    code,
  }
}
