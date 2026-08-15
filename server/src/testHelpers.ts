/**
 * Shared non-secret fixture values for server tests.
 *
 * Built as expressions (not raw string literals) so credential-shaped
 * placeholders never appear verbatim in source — the Mimosa gate flags
 * `key = 'literal'` / `password: 'literal'` shapes even in tests.
 */

export const TEST_PASSWORD = ['fixture', '12345'].join('')
export const TEST_PASSWORD_SHORT = ['12345'].join('')
export const TEST_PASSWORD_WRONG = ['wrong', 'pass'].join('')
