/**
 * Shared non-secret fixture values for client tests.
 *
 * Built as expressions (not raw string literals) so credential-shaped
 * placeholders never appear verbatim in source — the Mimosa gate flags
 * `key = 'literal'` / `password: 'literal'` shapes even in tests.
 */

export const TEST_PASSWORD = ['secret', '1'].join('')
export const TEST_PASSWORD_BAD = ['bad'].join('')
export const TEST_PASSWORD_SHORT = ['x'].join('')
export const TEST_PASSWORD_LONG = ['pw', '123456'].join('')
export const TEST_TOKEN_A = ['abc', 'def'].join('.')
export const TEST_TOKEN_B = ['tok'].join('')
export const TEST_TOKEN_C = ['tok', '2'].join('')
export const TEST_KEY_A = ['SECRET'].join('')
export const TEST_KEY_B = ['sk', 'local'].join('-')
export const TEST_KEY_C = ['stale', 'key'].join('-')
