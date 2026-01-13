import { Hono } from 'hono'
import { runMaintenanceLoop, stopMaintenanceLoop } from './maintenance/loop'
import runtimesApp from './routes/runtimes'

const app = new Hono()

// Health check endpoint
app.get('/v1/health', (c) => c.text('OK'))

// Register the runtimes routes under the /v1/runtimes prefix
app.route('/v1/runtimes', runtimesApp)

// Start the background maintenance loop
const maintenanceLoopPromise = runMaintenanceLoop().catch((err) => {
  console.error('Maintenance loop error:', err)
})

// Graceful shutdown handler
let isShuttingDown = false
let server: ReturnType<typeof Bun.serve> | null = null

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log('Shutdown already in progress. Forcing exit...')
    process.exit(1)
  }

  isShuttingDown = true
  console.log(`Received ${signal}. Starting graceful shutdown...`)

  try {
    // Stop accepting new requests by stopping the server
    if (server) {
      console.log('Stopping server (no new connections)...')
      server.stop()
    }

    // Stop the maintenance loop
    console.log('Stopping maintenance loop...')
    stopMaintenanceLoop()

    // Wait for maintenance loop to finish (with timeout)
    const MAINTENANCE_SHUTDOWN_TIMEOUT = 5000 // 5 seconds
    await Promise.race([
      maintenanceLoopPromise,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          console.warn('Maintenance loop shutdown timeout. Proceeding with exit.')
          resolve()
        }, MAINTENANCE_SHUTDOWN_TIMEOUT)
      }),
    ])

    console.log('Graceful shutdown completed.')
    process.exit(0)
  } catch (err) {
    console.error('Error during graceful shutdown:', err)
    process.exit(1)
  }
}

// Register signal handlers for graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
  gracefulShutdown('uncaughtException').catch(() => process.exit(1))
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason)
  gracefulShutdown('unhandledRejection').catch(() => process.exit(1))
})

// Start the server using Bun.serve() to get server instance for graceful shutdown
const port = parseInt(process.env.PORT || '3000', 10)
server = Bun.serve({
  port,
  fetch: app.fetch,
})

console.log(`Server started on port ${port}`)

// Export default for compatibility (though we're using Bun.serve directly)
export default {
  port,
  fetch: app.fetch,
}
