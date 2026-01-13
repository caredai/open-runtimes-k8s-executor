import type { Context, Next } from 'hono'

/**
 * Authentication middleware that validates the executor secret key
 */
export const authMiddleware = async (c: Context, next: Next) => {
  const authHeader = c.req.header('authorization')
  const secretKey = authHeader?.split(' ')[1] || ''
  const expectedSecret = process.env.OPR_EXECUTOR_SECRET || ''

  if (!secretKey || secretKey !== expectedSecret) {
    return c.json({ error: 'Missing executor key' }, 401)
  }

  await next()
}
