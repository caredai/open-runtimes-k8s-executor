import * as k8s from '@kubernetes/client-node'
import { KUBERNETES_NAMESPACE, k8sAppsApi } from '../k8s/client'
import { createErrorResponse, ErrorType } from './errors'

/**
 * Get runtime deployment name from runtimeId
 */
export function getDeploymentName(runtimeId: string): string {
  return `dep-${runtimeId}`
}

/**
 * Get runtime service name from runtimeId
 */
export function getServiceName(runtimeId: string): string {
  return `svc-${runtimeId}`
}

/**
 * Check if a runtime deployment exists
 */
export async function runtimeExists(runtimeId: string): Promise<boolean> {
  try {
    await k8sAppsApi.readNamespacedDeployment({
      name: getDeploymentName(runtimeId),
      namespace: KUBERNETES_NAMESPACE,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Get runtime status from deployment
 */
export async function getRuntimeStatus(runtimeId: string): Promise<{
  status: string
  initialised: number
  listening: number
  created: number
  updated: number
} | null> {
  try {
    const deployment = await k8sAppsApi.readNamespacedDeployment({
      name: getDeploymentName(runtimeId),
      namespace: KUBERNETES_NAMESPACE,
    })

    const annotations = deployment.metadata?.annotations || {}
    const status = annotations['appwrite.io/status'] || 'pending'
    const initialised = annotations['appwrite.io/initialised'] === '1' ? 1 : 0
    const listening = annotations['appwrite.io/listening'] === '1' ? 1 : 0
    const created = parseInt(annotations['appwrite.io/created'] || '0', 10)
    const updated = parseInt(annotations['appwrite.io/updated'] || '0', 10)

    return {
      status,
      initialised,
      listening,
      created,
      updated,
    }
  } catch {
    return null
  }
}

/**
 * Update runtime status annotation
 */
export async function updateRuntimeStatus(
  runtimeId: string,
  updates: {
    status?: string
    initialised?: number
    listening?: number
    updated?: number
  },
): Promise<void> {
  const deploymentName = getDeploymentName(runtimeId)
  // https://jsonpatch.com
  const patch: {
    op: string
    path: string
    value: string
  }[] = []

  if (updates.status !== undefined) {
    patch.push({
      op: 'replace',
      path: '/metadata/annotations/appwrite.io~1status',
      value: updates.status,
    })
  }
  if (updates.initialised !== undefined) {
    patch.push({
      op: 'replace',
      path: '/metadata/annotations/appwrite.io~1initialised',
      value: updates.initialised.toString(),
    })
  }
  if (updates.listening !== undefined) {
    patch.push({
      op: 'replace',
      path: '/metadata/annotations/appwrite.io~1listening',
      value: updates.listening.toString(),
    })
  }
  if (updates.updated !== undefined) {
    patch.push({
      op: 'replace',
      path: '/metadata/annotations/appwrite.io~1updated',
      value: updates.updated.toString(),
    })
  }

  if (patch.length > 0) {
    await k8sAppsApi.patchNamespacedDeployment(
      {
        name: deploymentName,
        namespace: KUBERNETES_NAMESPACE,
        body: patch,
      },
      k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.JsonPatch),
    )
  }
}

/**
 * Wait for runtime to be ready (not pending)
 */
export async function waitForRuntimeReady(runtimeId: string, timeout: number): Promise<void> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeout * 1000) {
    const status = await getRuntimeStatus(runtimeId)
    if (status && status.status !== 'pending') {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw createErrorResponse(ErrorType.RUNTIME_TIMEOUT, 'Runtime failed to become ready in time', 500)
}

/**
 * Check if a pod is listening on port 3000
 */
export async function checkPodListening(podIP: string, timeout: number): Promise<boolean> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeout * 1000) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 2000)
      const response = await fetch(`http://${podIP}:3000`, {
        method: 'GET',
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      // Any response (even 404) means the server is listening
      return true
    } catch {
      // Continue waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}
