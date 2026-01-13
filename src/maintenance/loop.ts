import type * as k8s from '@kubernetes/client-node'
import { KUBERNETES_NAMESPACE, k8sAppsApi, k8sCoordinationApi } from '../k8s/client'

const MAINTENANCE_INTERVAL = parseInt(process.env.OPR_EXECUTOR_MAINTENANCE_INTERVAL || '60', 10) * 1000
const INACTIVE_THRESHOLD = parseInt(process.env.OPR_EXECUTOR_INACTIVE_THRESHOLD || '300', 10) * 1000

const LEASE_NAME = 'executor-maintenance-lock'
const LEASE_DURATION = 30
const LEASE_IDENTITY = `${process.env.HOSTNAME || 'unknown'}-${process.pid}`

// Graceful shutdown control
let shutdownRequested = false
let maintenanceTimeoutId: ReturnType<typeof setTimeout> | null = null
let isRunning = false

async function acquireLease(): Promise<boolean> {
  const now = new Date()
  const leaseBody: k8s.V1Lease = {
    metadata: {
      name: LEASE_NAME,
    },
    spec: {
      holderIdentity: LEASE_IDENTITY,
      leaseDurationSeconds: LEASE_DURATION,
      acquireTime: now,
      renewTime: now,
    },
  }

  try {
    const leaseInfo = await k8sCoordinationApi.readNamespacedLeaseWithHttpInfo({
      name: LEASE_NAME,
      namespace: KUBERNETES_NAMESPACE,
    })

    if (leaseInfo.httpStatusCode === 404) {
      await k8sCoordinationApi.createNamespacedLease({
        namespace: KUBERNETES_NAMESPACE,
        body: leaseBody,
      })
      return true
    }

    if (leaseInfo.httpStatusCode && leaseInfo.httpStatusCode >= 400) {
      throw new Error(`Failed to read lease ${LEASE_NAME} (status ${leaseInfo.httpStatusCode})`)
    }

    const currentLease = leaseInfo.data
    const renewTime = new Date(currentLease.spec?.renewTime || 0)

    if (currentLease.spec?.holderIdentity === LEASE_IDENTITY) {
      leaseBody.spec = { ...currentLease.spec, renewTime: new Date() }
      await k8sCoordinationApi.replaceNamespacedLease({
        name: LEASE_NAME,
        namespace: KUBERNETES_NAMESPACE,
        body: leaseBody,
      })
      return true
    }
    if (now.getTime() - renewTime.getTime() > (currentLease.spec?.leaseDurationSeconds || LEASE_DURATION) * 1000) {
      leaseBody.spec = {
        ...currentLease.spec,
        holderIdentity: LEASE_IDENTITY,
        acquireTime: new Date(),
        renewTime: new Date(),
      }
      await k8sCoordinationApi.replaceNamespacedLease({
        name: LEASE_NAME,
        namespace: KUBERNETES_NAMESPACE,
        body: leaseBody,
      })
      return true
    }
    return false
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error('Error acquiring lease:', errorMessage)
    return false
  }
}

export async function runMaintenanceLoop() {
  if (isRunning) {
    console.warn('Maintenance loop is already running.')
    return
  }

  isRunning = true
  shutdownRequested = false

  console.log(
    `Starting maintenance loop. Interval: ${
      MAINTENANCE_INTERVAL / 1000
    }s, Inactive Threshold: ${INACTIVE_THRESHOLD / 1000}s`,
  )

  while (!shutdownRequested) {
    // Use a cancellable sleep
    await new Promise<void>((resolve) => {
      const timeoutId = setTimeout(resolve, MAINTENANCE_INTERVAL)
      maintenanceTimeoutId = timeoutId

      // Check if shutdown was requested during the wait
      if (shutdownRequested) {
        clearTimeout(timeoutId)
        resolve()
      }
    })

    if (shutdownRequested) {
      console.log('Shutdown requested. Stopping maintenance loop.')
      break
    }

    if (!(await acquireLease())) {
      console.log('Another instance holds the lease. Skipping maintenance cycle.')
      continue
    }
    console.log(`Lease acquired by ${LEASE_IDENTITY}. Running maintenance.`)

    try {
      const deploymentList = await k8sAppsApi.listNamespacedDeployment({
        namespace: KUBERNETES_NAMESPACE,
        labelSelector: 'appwrite.io/role=runtime',
      })

      for (const dep of deploymentList.items) {
        // Check for shutdown during iteration
        if (shutdownRequested) {
          console.log('Shutdown requested during maintenance cycle. Stopping.')
          break
        }

        const runtimeId = dep.metadata?.labels?.['appwrite.io/runtime-id']
        const deploymentName = dep.metadata?.name
        const lastExecutionTimeStr = dep.metadata?.annotations?.['appwrite.io/last-execution-time']

        if (!runtimeId || !deploymentName || dep.spec?.replicas !== 1) {
          continue
        }

        const lastExecutionTime = lastExecutionTimeStr ? parseInt(lastExecutionTimeStr, 10) : 0
        const now = Date.now()

        if (now - lastExecutionTime > INACTIVE_THRESHOLD) {
          console.log(`Runtime ${runtimeId} (Deployment: ${deploymentName}) is inactive. Scaling down to 0.`)
          const patch = [{ op: 'replace', path: '/spec/replicas', value: 0 }]
          await k8sAppsApi.patchNamespacedDeployment({
            name: deploymentName,
            namespace: KUBERNETES_NAMESPACE,
            body: patch,
          })
        }
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error('Error during maintenance cycle:', errorMessage)
    }
  }

  isRunning = false
  maintenanceTimeoutId = null
  console.log('Maintenance loop stopped.')
}

/**
 * Request graceful shutdown of the maintenance loop
 */
export function stopMaintenanceLoop() {
  if (!isRunning) {
    console.log('Maintenance loop is not running.')
    return
  }

  console.log('Requesting maintenance loop shutdown...')
  shutdownRequested = true

  // Clear any pending timeout
  if (maintenanceTimeoutId) {
    clearTimeout(maintenanceTimeoutId)
    maintenanceTimeoutId = null
  }
}

/**
 * Check if maintenance loop is currently running
 */
export function isMaintenanceLoopRunning(): boolean {
  return isRunning
}
