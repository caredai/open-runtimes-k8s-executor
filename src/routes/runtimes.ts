import { Writable } from 'node:stream'
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type * as k8s from '@kubernetes/client-node'
import { Exec, KubeConfig } from '@kubernetes/client-node'
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { KUBERNETES_NAMESPACE, k8sAppsApi, k8sBatchApi, k8sCoreApi } from '../k8s/client'
import {
  createBuildJobDefinition,
  createCleanupJobDefinition,
  createRuntimeDeploymentDefinition,
  createRuntimeServiceDefinition,
} from '../k8s/definitions'
import { authMiddleware } from '../middleware/auth'
import { S3_ACCESS_KEY_ID, S3_BUCKET, S3_ENDPOINT, S3_SECRET_ACCESS_KEY } from '../s3/config'
import { delay } from '../utils/delay'
import { createErrorResponse, ErrorType } from '../utils/errors'
import { getLogOffset, parseTiming } from '../utils/logs'
import { createMultipartBody, getMultipartContentType } from '../utils/multipart'
import { fileExistsInPod, readFileFromPod, tailFileInPod } from '../utils/pod-exec'
import {
  checkPodListening,
  getDeploymentName,
  getRuntimeStatus,
  getServiceName,
  runtimeExists,
  updateRuntimeStatus,
  waitForRuntimeReady,
} from '../utils/runtime'

const runtimesApp = new Hono()

// Apply authentication middleware to all routes
runtimesApp.use('*', authMiddleware)

/**
 * POST /v1/runtimes
 * Create a new runtime server
 */
runtimesApp.post('/', async (c) => {
  const {
    runtimeId,
    image,
    entrypoint = '',
    source = '',
    destination = '',
    outputDirectory = '',
    variables = {},
    runtimeEntrypoint = '',
    command = '',
    timeout = 600,
    remove = false,
    cpus = 1,
    memory = 512,
    version = 'v5',
    restartPolicy = 'Always',
  } = await c.req.json()

  if (!runtimeId || !image) {
    return c.json(
      createErrorResponse(ErrorType.EXECUTION_BAD_REQUEST, 'Missing required fields: runtimeId, image'),
      400,
    )
  }

  // Check if runtime already exists
  if (await runtimeExists(runtimeId)) {
    const status = await getRuntimeStatus(runtimeId)
    if (status && status.status === 'pending') {
      return c.json(
        createErrorResponse(
          ErrorType.RUNTIME_CONFLICT,
          'A runtime with the same ID is already being created. Attempt an execution soon.',
        ),
        409,
      )
    }
    return c.json(createErrorResponse(ErrorType.RUNTIME_CONFLICT, 'Runtime already exists'), 409)
  }

  const startTime = Date.now() / 1000
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const hostname = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  // Merge environment variables based on version
  const mergedVariables: Record<string, string> = {
    ...variables,
    CI: 'true',
  }

  if (version === 'v2') {
    mergedVariables.INTERNAL_RUNTIME_KEY = secret
    mergedVariables.INTERNAL_RUNTIME_ENTRYPOINT = entrypoint
    mergedVariables.INERNAL_EXECUTOR_HOSTNAME = process.env.HOSTNAME || 'unknown'
  } else if (version === 'v4' || version === 'v5') {
    mergedVariables.OPEN_RUNTIMES_SECRET = secret
    mergedVariables.OPEN_RUNTIMES_ENTRYPOINT = entrypoint
    mergedVariables.OPEN_RUNTIMES_HOSTNAME = process.env.HOSTNAME || 'unknown'
    mergedVariables.OPEN_RUNTIMES_CPUS = String(cpus)
    mergedVariables.OPEN_RUNTIMES_MEMORY = String(memory)
  }

  if (outputDirectory) {
    mergedVariables.OPEN_RUNTIMES_OUTPUT_DIRECTORY = outputDirectory
  }

  // Convert all values to strings
  const stringVariables: Record<string, string> = {}
  for (const [key, value] of Object.entries(mergedVariables)) {
    stringVariables[key] = String(value)
  }

  try {
    let artifactPath = ''
    let buildOutput: Array<{ timestamp: string; content: string }> = []

    // If command is provided, create a build job
    if (command) {
      const buildId = uuidv4()
      const jobName = `build-${runtimeId}-${buildId.substring(0, 8)}`
      artifactPath = `${runtimeId}/${buildId}.tar.gz`

      // Download source from S3 if source is provided
      let sourceCodeBase64 = ''
      if (source) {
        try {
          const s3Client = new S3Client({
            endpoint: S3_ENDPOINT,
            region: process.env.S3_REGION || 'us-east-1',
            credentials: {
              accessKeyId: S3_ACCESS_KEY_ID,
              secretAccessKey: S3_SECRET_ACCESS_KEY,
            },
            forcePathStyle: true,
          })

          const getObjectResponse = await s3Client.send(
            new GetObjectCommand({
              Bucket: S3_BUCKET,
              Key: source,
            }),
          )

          if (getObjectResponse.Body) {
            const chunks: Uint8Array[] = []
            // @ts-expect-error - Body is a stream
            for await (const chunk of getObjectResponse.Body) {
              chunks.push(chunk)
            }
            const buffer = Buffer.concat(chunks)
            sourceCodeBase64 = buffer.toString('base64')
          }
        } catch (err) {
          console.error('Failed to download source from S3:', err)
          return c.json(createErrorResponse(ErrorType.RUNTIME_FAILED, `Failed to download source: ${err}`), 500)
        }
      }

      const buildJob = createBuildJobDefinition({
        jobName,
        runtimeId,
        image,
        sourceCode: sourceCodeBase64,
        command,
        artifactPath,
        version,
        variables: stringVariables,
      })

      await k8sBatchApi.createNamespacedJob({
        namespace: KUBERNETES_NAMESPACE,
        body: buildJob,
      })

      // Wait for build job to complete
      const buildStartTime = Date.now()
      const buildTimeout = timeout * 1000
      let buildSucceeded = false

      while (Date.now() - buildStartTime < buildTimeout) {
        try {
          const jobInfo = await k8sBatchApi.readNamespacedJobWithHttpInfo({
            name: jobName,
            namespace: KUBERNETES_NAMESPACE,
          })

          if (jobInfo.httpStatusCode === 404) {
            await delay(1000)
            continue
          }

          if (jobInfo.httpStatusCode && jobInfo.httpStatusCode >= 400) {
            throw new Error(`Failed to read job ${jobName} (status ${jobInfo.httpStatusCode})`)
          }

          const job = jobInfo.data

          if (job.status?.succeeded === 1) {
            buildSucceeded = true
            // Try to get logs from pod (matching executor behavior - reads from container files)
            try {
              const podList = await k8sCoreApi.listNamespacedPod({
                namespace: KUBERNETES_NAMESPACE,
                labelSelector: `job-name=${jobName}`,
              })

              if (podList.items.length > 0) {
                const podName = podList.items[0].metadata?.name
                if (podName) {
                  try {
                    // For v2, read from /var/tmp/logs.txt
                    if (version === 'v2') {
                      const logsContent = await readFileFromPod(podName, 'build-container', '/var/tmp/logs.txt')
                      buildOutput = [
                        {
                          timestamp: new Date().toISOString(),
                          content: logsContent,
                        },
                      ]
                    } else {
                      // For v5, read from /tmp/logging/
                      const logsContent = await readFileFromPod(podName, 'build-container', '/tmp/logging/logs.txt')
                      const timingsContent = await readFileFromPod(
                        podName,
                        'build-container',
                        '/tmp/logging/timings.txt',
                      )

                      // Parse logs using the same logic as logs endpoint
                      const introOffset = getLogOffset(logsContent)
                      const parts = parseTiming(timingsContent)
                      let offset = 0

                      for (const part of parts) {
                        const timestamp = part.timestamp
                        const length = part.length
                        const logContent =
                          logsContent.slice(introOffset + offset, introOffset + offset + Math.abs(length)) || ''
                        buildOutput.push({
                          timestamp,
                          content: logContent,
                        })
                        offset += length
                      }
                    }
                  } catch {
                    // If pod read fails, buildOutput remains empty
                  }
                }
              }
            } catch {
              // Ignore errors
            }
            break
          }
          if (job.status?.failed === 1) {
            // Try to get logs from pod (matching executor behavior - reads from container files)
            try {
              const podList = await k8sCoreApi.listNamespacedPod({
                namespace: KUBERNETES_NAMESPACE,
                labelSelector: `job-name=${jobName}`,
              })

              if (podList.items.length > 0) {
                const podName = podList.items[0].metadata?.name
                if (podName) {
                  try {
                    // For v2, read from /var/tmp/logs.txt
                    if (version === 'v2') {
                      const logsContent = await readFileFromPod(podName, 'build-container', '/var/tmp/logs.txt')
                      buildOutput = [
                        {
                          timestamp: new Date().toISOString(),
                          content: logsContent,
                        },
                      ]
                    } else {
                      // For v5, read from /tmp/logging/
                      const logsContent = await readFileFromPod(podName, 'build-container', '/tmp/logging/logs.txt')
                      const timingsContent = await readFileFromPod(
                        podName,
                        'build-container',
                        '/tmp/logging/timings.txt',
                      )

                      // Parse logs using the same logic as logs endpoint
                      const introOffset = getLogOffset(logsContent)
                      const parts = parseTiming(timingsContent)
                      let offset = 0

                      for (const part of parts) {
                        const timestamp = part.timestamp
                        const length = part.length
                        const logContent =
                          logsContent.slice(introOffset + offset, introOffset + offset + Math.abs(length)) || ''
                        buildOutput.push({
                          timestamp,
                          content: logContent,
                        })
                        offset += length
                      }
                    }
                  } catch {
                    // If pod read fails, try to get logs from pod logs as fallback
                    try {
                      const logs = await k8sCoreApi.readNamespacedPodLog({
                        name: podName,
                        namespace: KUBERNETES_NAMESPACE,
                        container: 'build-container',
                      })
                      buildOutput = [
                        {
                          timestamp: new Date().toISOString(),
                          content: logs as string,
                        },
                      ]
                    } catch {
                      // Ignore log read errors
                    }
                  }
                }
              }
            } catch {
              // Ignore errors
            }

            throw new Error('Build job failed')
          }

          await delay(1000)
        } catch (err: unknown) {
          if (!buildSucceeded) {
            const message = (err instanceof Error ? err.message : String(err)) || 'Build failed'
            return c.json(createErrorResponse(ErrorType.RUNTIME_FAILED, message), 500)
          }
        }
      }

      if (!buildSucceeded) {
        return c.json(createErrorResponse(ErrorType.RUNTIME_TIMEOUT, 'Build job timed out'), 500)
      }

      // If destination is provided, artifactPath is already set
      if (destination) {
        artifactPath = destination
      }
    } else if (source) {
      // No build command, use source directly as artifact
      artifactPath = source
    }

    // Create service and deployment
    const service = createRuntimeServiceDefinition({ runtimeId })
    const deployment = createRuntimeDeploymentDefinition({
      runtimeId,
      image,
      artifactPath: artifactPath || '',
      version,
      entrypoint,
      runtimeEntrypoint,
      variables: stringVariables,
      secret,
      cpus,
      memory,
      hostname,
    })

    // Create or update service
    try {
      const serviceInfo = await k8sCoreApi.readNamespacedServiceWithHttpInfo({
        name: service.metadata!.name!,
        namespace: KUBERNETES_NAMESPACE,
      })

      if (serviceInfo.httpStatusCode === 404) {
        await k8sCoreApi.createNamespacedService({
          namespace: KUBERNETES_NAMESPACE,
          body: service,
        })
      } else if (serviceInfo.httpStatusCode && serviceInfo.httpStatusCode >= 400) {
        throw new Error(`Failed to read service ${service.metadata!.name!} (status ${serviceInfo.httpStatusCode})`)
      }
    } catch (err: unknown) {
      throw err
    }

    // Create or update deployment
    try {
      const deploymentInfo = await k8sAppsApi.readNamespacedDeploymentWithHttpInfo({
        name: deployment.metadata!.name!,
        namespace: KUBERNETES_NAMESPACE,
      })

      if (deploymentInfo.httpStatusCode === 404) {
        await k8sAppsApi.createNamespacedDeployment({
          namespace: KUBERNETES_NAMESPACE,
          body: deployment,
        })
      } else if (deploymentInfo.httpStatusCode && deploymentInfo.httpStatusCode >= 400) {
        throw new Error(
          `Failed to read deployment ${deployment.metadata!.name!} (status ${deploymentInfo.httpStatusCode})`,
        )
      } else {
        await k8sAppsApi.replaceNamespacedDeployment({
          name: deployment.metadata!.name!,
          namespace: KUBERNETES_NAMESPACE,
          body: deployment,
        })
      }
    } catch (err: unknown) {
      throw err
    }

    const endTime = Date.now() / 1000
    const duration = endTime - startTime

    // Update runtime status
    await updateRuntimeStatus(runtimeId, {
      status: `Up ${duration.toFixed(2)}s`,
      initialised: 1,
      updated: Math.floor(endTime * 1000),
    })

    const response: Record<string, unknown> = {
      output: buildOutput,
      startTime,
      duration,
    }

    if (destination && artifactPath) {
      // Get artifact size from S3
      try {
        const s3Client = new S3Client({
          endpoint: S3_ENDPOINT,
          region: process.env.S3_REGION || 'us-east-1',
          credentials: {
            accessKeyId: S3_ACCESS_KEY_ID,
            secretAccessKey: S3_SECRET_ACCESS_KEY,
          },
          forcePathStyle: true,
        })

        const headObject = await s3Client.send(
          new HeadObjectCommand({
            Bucket: S3_BUCKET,
            Key: artifactPath,
          }),
        )

        response.size = headObject.ContentLength || 0
        response.path = artifactPath
      } catch {
        // Ignore S3 errors for size
      }
    }

    // Remove runtime if requested
    if (remove) {
      await delay(2000) // Allow time to read logs
      try {
        await k8sAppsApi.deleteNamespacedDeployment({
          name: getDeploymentName(runtimeId),
          namespace: KUBERNETES_NAMESPACE,
        })
        await k8sCoreApi.deleteNamespacedService({
          name: getServiceName(runtimeId),
          namespace: KUBERNETES_NAMESPACE,
        })
      } catch {
        // Ignore deletion errors
      }
    }

    return c.json(response, 201)
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error('Failed to create runtime:', errorMessage)
    return c.json(createErrorResponse(ErrorType.RUNTIME_FAILED, errorMessage || 'Failed to create runtime'), 500)
  }
})

/**
 * GET /v1/runtimes
 * List currently active runtimes with pagination support
 * Query parameters:
 *   - limit: Number of items per page (default: 25, max: 100)
 *   - continue: Continuation token for pagination (from previous response)
 */
runtimesApp.get('/', async (c) => {
  try {
    // Parse pagination parameters
    const limitParam = c.req.query('limit')
    const continueParam = c.req.query('continue')

    const defaultLimit = 25
    const maxLimit = 100
    // Calculate limit
    let limit = defaultLimit
    if (limitParam) {
      const parsedLimit = parseInt(limitParam, 10)
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        limit = Math.min(parsedLimit, maxLimit)
      }
    }

    const deploymentList = await k8sAppsApi.listNamespacedDeployment({
      namespace: KUBERNETES_NAMESPACE,
      labelSelector: 'appwrite.io/role=runtime',
      limit,
      _continue: continueParam,
    })

    const runtimeData = deploymentList.items.map((dep: k8s.V1Deployment) => {
      const annotations = dep.metadata?.annotations || {}
      return {
        version: annotations['appwrite.io/version'] || 'v5',
        created: parseFloat(annotations['appwrite.io/created'] || '0') / 1000,
        updated: parseFloat(annotations['appwrite.io/updated'] || '0') / 1000,
        name: dep.metadata?.name || '',
        hostname: annotations['appwrite.io/hostname'] || '',
        status: annotations['appwrite.io/status'] || 'pending',
        key: annotations['appwrite.io/secret'] || '',
        listening: annotations['appwrite.io/listening'] === '1' ? 1 : 0,
        image: dep.spec?.template.spec?.containers?.[0]?.image || '',
        initialised: annotations['appwrite.io/initialised'] === '1' ? 1 : 0,
      }
    })

    return c.json(runtimeData, undefined, {
      'X-PAGINATION-LIMIT': limit.toString(),
      'X-PAGINATION-CONTINUE': deploymentList.metadata?._continue ?? '',
      'X-PAGINATION-REMAINING': deploymentList.metadata?.remainingItemCount?.toString() ?? '',
    })
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error('Failed to list runtimes:', errorMessage)
    return c.json(createErrorResponse(ErrorType.GENERAL_UNKNOWN, 'Failed to list runtimes'), 500)
  }
})

/**
 * GET /v1/runtimes/:runtimeId
 * Get a runtime by its ID
 */
runtimesApp.get('/:runtimeId', async (c) => {
  const runtimeId = c.req.param('runtimeId')
  const deploymentName = getDeploymentName(runtimeId)

  try {
    const depInfo = await k8sAppsApi.readNamespacedDeploymentWithHttpInfo({
      name: deploymentName,
      namespace: KUBERNETES_NAMESPACE,
    })

    if (depInfo.httpStatusCode === 404) {
      return c.json(createErrorResponse(ErrorType.RUNTIME_NOT_FOUND, 'Runtime not found'), 404)
    }

    if (depInfo.httpStatusCode && depInfo.httpStatusCode >= 400) {
      throw new Error(`Failed to read runtime ${runtimeId} (status ${depInfo.httpStatusCode})`)
    }

    const dep = depInfo.data

    const annotations = dep.metadata?.annotations || {}
    const runtime = {
      version: annotations['appwrite.io/version'] || 'v5',
      created: parseFloat(annotations['appwrite.io/created'] || '0') / 1000,
      updated: parseFloat(annotations['appwrite.io/updated'] || '0') / 1000,
      name: dep.metadata?.name || '',
      hostname: annotations['appwrite.io/hostname'] || '',
      status: annotations['appwrite.io/status'] || 'pending',
      key: annotations['appwrite.io/secret'] || '',
      listening: annotations['appwrite.io/listening'] === '1' ? 1 : 0,
      image: dep.spec?.template.spec?.containers?.[0]?.image || '',
      initialised: annotations['appwrite.io/initialised'] === '1' ? 1 : 0,
    }

    return c.json(runtime)
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error(`Failed to get runtime ${runtimeId}:`, errorMessage)
    return c.json(createErrorResponse(ErrorType.GENERAL_UNKNOWN, `Failed to get runtime ${runtimeId}`), 500)
  }
})

/**
 * DELETE /v1/runtimes/:runtimeId
 * Delete a runtime
 */
runtimesApp.delete('/:runtimeId', async (c) => {
  const runtimeId = c.req.param('runtimeId')
  const deploymentName = getDeploymentName(runtimeId)
  const serviceName = getServiceName(runtimeId)

  try {
    // Delete deployment
    const deleteDeploymentInfo = await k8sAppsApi.deleteNamespacedDeploymentWithHttpInfo({
      name: deploymentName,
      namespace: KUBERNETES_NAMESPACE,
    })
    const deleteStatus = deleteDeploymentInfo.httpStatusCode ?? 0
    const deleteMessage =
      typeof deleteDeploymentInfo.data === 'string'
        ? deleteDeploymentInfo.data
        : ((deleteDeploymentInfo.data as { message?: string } | undefined)?.message ?? '')

    if (deleteStatus === 500 && deleteMessage.includes('already in progress')) {
      return c.json({ status: `Runtime ${runtimeId} deletion already in progress` })
    }

    if (deleteStatus === 404) {
      return c.json({ status: `Runtime ${runtimeId} was not found or already deleted` }, 404)
    }

    if (deleteStatus >= 400) {
      throw new Error(`Failed to delete deployment ${deploymentName} (status ${deleteStatus})`)
    }

    // Delete service
    try {
      await k8sCoreApi.deleteNamespacedService({
        name: serviceName,
        namespace: KUBERNETES_NAMESPACE,
      })
    } catch {
      // Service might not exist, ignore
    }

    // Create cleanup job to delete S3 artifacts
    const jobName = `delete-${runtimeId}-${uuidv4().substring(0, 8)}`
    const cleanupJob = createCleanupJobDefinition(jobName, runtimeId)
    try {
      await k8sBatchApi.createNamespacedJob({
        namespace: KUBERNETES_NAMESPACE,
        body: cleanupJob,
      })
    } catch {
      // Ignore cleanup job creation errors
    }

    return c.json({ status: `Runtime ${runtimeId} deleted` })
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error(`Failed to delete runtime ${runtimeId}:`, errorMessage)
    return c.json(createErrorResponse(ErrorType.GENERAL_UNKNOWN, `Failed to delete runtime ${runtimeId}`), 500)
  }
})

/**
 * POST /v1/runtimes/:runtimeId/executions
 * Create an execution
 */
runtimesApp.on('POST', ['/:runtimeId/executions', '/:runtimeId/execution'], async (c) => {
  const runtimeId = c.req.param('runtimeId')
  const body = await c.req.json()

  const {
    body: payload = '',
    path = '/',
    method = 'GET',
    headers = {},
    timeout = 15,
    image = '',
    source = '',
    entrypoint = '',
    variables = {},
    cpus = 1,
    memory = 512,
    version = 'v5',
    runtimeEntrypoint = '',
    logging = true,
    restartPolicy = 'Always',
  } = body

  const prepareStart = Date.now() / 1000

  // Merge variables - add INERNAL_EXECUTOR_HOSTNAME
  const mergedVariables: Record<string, string> = {
    ...variables,
    INERNAL_EXECUTOR_HOSTNAME: process.env.HOSTNAME || 'unknown',
  }

  // Convert all values to strings
  const stringVariables: Record<string, string> = {}
  for (const [key, value] of Object.entries(mergedVariables)) {
    stringVariables[key] = String(value)
  }

  // Check if runtime exists, if not, create it
  if (!(await runtimeExists(runtimeId))) {
    if (!image || !source) {
      return c.json(
        createErrorResponse(
          ErrorType.RUNTIME_NOT_FOUND,
          'Runtime not found. Please start it first or provide runtime-related parameters.',
        ),
        404,
      )
    }

    // Create runtime by calling the create endpoint internally
    const createResponse = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/v1/runtimes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${process.env.OPR_EXECUTOR_SECRET || ''}`,
      },
      body: JSON.stringify({
        runtimeId,
        image,
        source,
        entrypoint,
        variables: stringVariables,
        cpus,
        memory,
        version,
        runtimeEntrypoint,
        restartPolicy,
      }),
    })

    if (!createResponse.ok) {
      const errorData = await createResponse.json()
      return c.json(errorData, createResponse.status as 200 | 201 | 400 | 401 | 404 | 500)
    }

    // Wait for runtime to be ready
    try {
      await waitForRuntimeReady(runtimeId, timeout)
    } catch {
      return c.json(createErrorResponse(ErrorType.RUNTIME_TIMEOUT, 'Runtime failed to become ready in time'), 500)
    }
  }

  // Lower timeout by time it took to prepare
  const remainingTimeout = timeout - (Date.now() / 1000 - prepareStart)

  // Update runtime last execution time
  await updateRuntimeStatus(runtimeId, {
    updated: Date.now(),
  })

  // Ensure runtime is ready (not pending)
  try {
    await waitForRuntimeReady(runtimeId, remainingTimeout)
  } catch {
    return c.json(createErrorResponse(ErrorType.RUNTIME_TIMEOUT, 'Runtime failed to become ready in time'), 500)
  }

  // Get runtime status to get secret and hostname
  const status = await getRuntimeStatus(runtimeId)
  if (!status) {
    return c.json(createErrorResponse(ErrorType.RUNTIME_NOT_FOUND, 'Runtime not found'), 404)
  }

  // Get deployment to read secret and hostname from annotations
  const deployment = await k8sAppsApi.readNamespacedDeployment({
    name: getDeploymentName(runtimeId),
    namespace: KUBERNETES_NAMESPACE,
  })

  const annotations = deployment.metadata?.annotations || {}
  const secret = annotations['appwrite.io/secret'] || ''
  const hostname = annotations['appwrite.io/hostname'] || ''

  if (!secret) {
    return c.json(
      createErrorResponse(ErrorType.RUNTIME_NOT_FOUND, 'Runtime secret not found. Please re-create the runtime.'),
      500,
    )
  }

  // Scale deployment to 1 replica if it's 0
  const currentReplicas = deployment.spec?.replicas || 0
  if (currentReplicas === 0) {
    await k8sAppsApi.patchNamespacedDeployment({
      name: getDeploymentName(runtimeId),
      namespace: KUBERNETES_NAMESPACE,
      body: [{ op: 'replace', path: '/spec/replicas', value: 1 }],
    })
  }

  // Wait for pod to be ready
  const startTime = Date.now()
  const readyTimeout = 60 * 1000
  let isReady = false

  while (Date.now() - startTime < readyTimeout) {
    const currentDeployment = await k8sAppsApi.readNamespacedDeployment({
      name: getDeploymentName(runtimeId),
      namespace: KUBERNETES_NAMESPACE,
    })

    if (currentDeployment.status?.readyReplicas === 1) {
      isReady = true
      break
    }
    await delay(500)
  }

  if (!isReady) {
    return c.json(createErrorResponse(ErrorType.RUNTIME_TIMEOUT, 'Runtime failed to become ready in time'), 504)
  }

  // Get pod IP
  const podList = await k8sCoreApi.listNamespacedPod({
    namespace: KUBERNETES_NAMESPACE,
    labelSelector: `appwrite.io/runtime-id=${runtimeId}`,
  })

  if (podList.items.length === 0) {
    return c.json(createErrorResponse(ErrorType.RUNTIME_NOT_FOUND, 'Could not find a pod for this runtime'), 500)
  }

  const pod = podList.items[0]
  const podIP = pod.status?.podIP

  if (!podIP) {
    return c.json(createErrorResponse(ErrorType.RUNTIME_NOT_FOUND, 'Runtime pod is not ready or has no IP'), 500)
  }

  // Check if listening (cold start)
  if (status.listening === 0) {
    const listening = await checkPodListening(podIP, remainingTimeout)
    if (!listening) {
      return c.json(createErrorResponse(ErrorType.RUNTIME_TIMEOUT, 'Runtime failed to start listening in time'), 500)
    }
    await updateRuntimeStatus(runtimeId, { listening: 1 })
  }

  // Execute function
  const executionStartTime = Date.now() / 1000
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const executionUrl = `http://${podIP}:3000${normalizedPath}`

  // Build request headers
  const requestHeaders: Record<string, string> = {
    ...headers,
  }

  if (version === 'v2') {
    requestHeaders['x-internal-challenge'] = secret
    requestHeaders['host'] = 'null'
    requestHeaders['Content-Type'] = 'application/json'
  } else {
    requestHeaders['Authorization'] = `Basic ${Buffer.from(`opr:${secret}`).toString('base64')}`
    requestHeaders['x-open-runtimes-secret'] = secret
    requestHeaders['x-open-runtimes-timeout'] = String(Math.max(Math.floor(remainingTimeout), 1))
    requestHeaders['x-open-runtimes-logging'] = logging ? 'enabled' : 'disabled'
  }

  // Execute request
  let executionResponse: Response
  try {
    executionResponse = await fetch(executionUrl, {
      method: method.toUpperCase(),
      headers: requestHeaders,
      body: method !== 'GET' && method !== 'HEAD' ? payload : undefined,
      signal: AbortSignal.timeout((remainingTimeout + 5) * 1000), // Extra 5s buffer
    })
  } catch (err) {
    return c.json(
      createErrorResponse(ErrorType.EXECUTION_TIMEOUT, (err as Error).message || 'Execution request failed'),
      500,
    )
  }

  // Extract response
  const responseBody = await executionResponse.text()
  const responseHeaders: Record<string, string | string[]> = {}

  executionResponse.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase()
    if (lowerKey.startsWith('x-open-runtimes-')) {
      // Skip internal headers
      return
    }
    if (responseHeaders[lowerKey]) {
      if (Array.isArray(responseHeaders[lowerKey])) {
        ;(responseHeaders[lowerKey] as string[]).push(value)
      } else {
        responseHeaders[lowerKey] = [responseHeaders[lowerKey] as string, value]
      }
    } else {
      responseHeaders[lowerKey] = value
    }
  })

  // Extract logs and errors for v5
  let logs = ''
  let errors = ''
  const logIdHeader = executionResponse.headers.get('x-open-runtimes-log-id')
  const logId = logIdHeader ? decodeURIComponent(logIdHeader) : ''

  if (version === 'v5' && logId && logging) {
    try {
      // Read logs and errors from pod files
      const podName = pod.metadata?.name
      if (podName) {
        const logFile = `/mnt/logs/${logId}_logs.log`
        const errorFile = `/mnt/logs/${logId}_errors.log`

        try {
          const logContent = await readFileFromPod(podName, 'runtime-container', logFile)
          // Limit log size to 1MB
          const MAX_LOG_SIZE = 1048576
          if (logContent.length > MAX_LOG_SIZE) {
            logs = logContent.slice(0, MAX_LOG_SIZE)
            logs += `\nLog file has been truncated to ${(MAX_LOG_SIZE / 1048576).toFixed(2)}MB.`
          } else {
            logs = logContent
          }
        } catch {
          // Log file doesn't exist or can't be read, ignore
        }

        try {
          const errorContent = await readFileFromPod(podName, 'runtime-container', errorFile)
          // Limit error size to 1MB
          const MAX_LOG_SIZE = 1048576
          if (errorContent.length > MAX_LOG_SIZE) {
            errors = errorContent.slice(0, MAX_LOG_SIZE)
            errors += `\nError file has been truncated to ${(MAX_LOG_SIZE / 1048576).toFixed(2)}MB.`
          } else {
            errors = errorContent
          }
        } catch {
          // Error file doesn't exist or can't be read, ignore
        }
      }
    } catch {
      // Ignore log extraction errors
    }
  }

  const executionEndTime = Date.now() / 1000
  const duration = executionEndTime - executionStartTime

  // Update last execution time
  try {
    await k8sAppsApi.patchNamespacedDeployment({
      name: getDeploymentName(runtimeId),
      namespace: KUBERNETES_NAMESPACE,
      body: [
        {
          op: 'replace',
          path: '/metadata/annotations/appwrite.io~1last-execution-time',
          value: Date.now().toString(),
        },
      ],
    })
  } catch {
    // Ignore annotation update errors
  }

  // Update runtime status
  await updateRuntimeStatus(runtimeId, {
    updated: Date.now(),
  })

  // Prepare execution response data
  const executionData: Record<string, unknown> = {
    statusCode: executionResponse.status,
    headers: responseHeaders,
    body: responseBody,
    logs,
    errors,
    duration,
    startTime: executionStartTime,
  }

  // Backwards compatibility for headers
  const responseFormat = c.req.header('x-executor-response-format') || '0.10.0'
  if (responseFormat < '0.11.0') {
    // Convert array headers to single value (last element)
    const compatibleHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(executionData.headers as Record<string, string | string[]>)) {
      if (Array.isArray(value)) {
        compatibleHeaders[key] = value[value.length - 1] || ''
      } else {
        compatibleHeaders[key] = value
      }
    }
    executionData.headers = compatibleHeaders
  }

  // Format response based on Accept header
  const acceptHeader = c.req.header('accept') || ''
  const isJson = acceptHeader.includes('application/json') || acceptHeader.includes('application/*')

  if (isJson) {
    return c.json(executionData)
  } else {
    // Multipart form data response
    const { body: multipartBody, boundary } = createMultipartBody(executionData)
    return c.text(multipartBody, {
      headers: {
        'Content-Type': getMultipartContentType(boundary),
      },
    })
  }
})

/**
 * POST /v1/runtimes/:runtimeId/commands
 * Execute a command inside an existing runtime
 */
runtimesApp.post('/:runtimeId/commands', async (c) => {
  const runtimeId = c.req.param('runtimeId')
  const body = await c.req.json()
  const { command, timeout = 600 } = body

  if (!command) {
    return c.json(createErrorResponse(ErrorType.EXECUTION_BAD_REQUEST, 'Missing required field: command'), 400)
  }

  // Check if runtime exists
  if (!(await runtimeExists(runtimeId))) {
    return c.json(createErrorResponse(ErrorType.RUNTIME_NOT_FOUND, 'Runtime not found'), 404)
  }

  try {
    // Get pod for the runtime
    const podList = await k8sCoreApi.listNamespacedPod({
      namespace: KUBERNETES_NAMESPACE,
      labelSelector: `appwrite.io/runtime-id=${runtimeId},appwrite.io/role=runtime`,
    })

    if (podList.items.length === 0) {
      return c.json(createErrorResponse(ErrorType.RUNTIME_NOT_FOUND, 'Runtime pod not found'), 404)
    }

    const pod = podList.items[0]
    const podName = pod.metadata?.name

    if (!podName) {
      return c.json(createErrorResponse(ErrorType.RUNTIME_NOT_FOUND, 'Runtime pod name not found'), 404)
    }

    // Execute command in the runtime container
    const output = await new Promise<string>((resolve, reject) => {
      const kc = new KubeConfig()
      kc.loadFromDefault()
      const exec = new Exec(kc)
      let stdout = ''
      let stderr = ''

      const stdoutStream = new Writable({
        write(chunk: Buffer, encoding: string, callback: () => void) {
          stdout += chunk.toString('utf-8')
          callback()
        },
      })

      const stderrStream = new Writable({
        write(chunk: Buffer, encoding: string, callback: () => void) {
          stderr += chunk.toString('utf-8')
          callback()
        },
      })

      exec.exec(
        KUBERNETES_NAMESPACE,
        podName,
        'runtime-container',
        ['bash', '-c', command],
        stdoutStream,
        stderrStream,
        process.stdin,
        false,
        (status) => {
          if (status.status === 'Success') {
            resolve(stdout)
          } else {
            reject(new Error(`Command failed: ${stderr || status.status}`))
          }
        },
      )

      // Set timeout
      setTimeout(() => {
        reject(new Error('Command execution timed out'))
      }, timeout * 1000)
    })

    return c.json({ output })
  } catch (err: unknown) {
    const error = err as Error
    if (error.message.includes('timed out')) {
      return c.json(createErrorResponse(ErrorType.COMMAND_TIMEOUT, error.message), 500)
    }
    return c.json(createErrorResponse(ErrorType.COMMAND_FAILED, error.message || 'Command execution failed'), 500)
  }
})

/**
 * GET /v1/runtimes/:runtimeId/logs
 * Get live stream of logs of a runtime (build logs)
 * Uses k8s exec to read from pod, not pod logs
 */
runtimesApp.get('/:runtimeId/logs', async (c) => {
  const runtimeId = c.req.param('runtimeId')
  const timeoutSeconds = parseInt(c.req.query('timeout') || '600', 10)

  try {
    // Wait for runtime deployment to exist (similar to Docker version checking container)
    let deployment: k8s.V1Deployment | null = null
    for (let i = 0; i < 10; i++) {
      try {
        deployment = await k8sAppsApi.readNamespacedDeployment({
          name: getDeploymentName(runtimeId),
          namespace: KUBERNETES_NAMESPACE,
        })
        break
      } catch {
        if (i === 9) {
          return c.json(
            createErrorResponse(ErrorType.RUNTIME_NOT_FOUND, 'Runtime not ready. Deployment not found.'),
            404,
          )
        }
        await delay(500)
      }
    }

    if (!deployment) {
      return c.json(createErrorResponse(ErrorType.RUNTIME_NOT_FOUND, 'Runtime not found'), 404)
    }

    // Get version from deployment annotations
    const annotations = deployment.metadata?.annotations || {}
    const version = annotations['appwrite.io/version'] || 'v5'

    // v2 doesn't support log streaming
    if (version === 'v2') {
      return c.text('')
    }

    // Wait for runtime status (similar to Docker version)
    const checkStart = Date.now()
    let runtimeStatus = null
    while (Date.now() - checkStart < 10000) {
      // 10s timeout like Docker version
      runtimeStatus = await getRuntimeStatus(runtimeId)
      if (runtimeStatus) {
        break
      }
      await delay(500)
    }

    if (!runtimeStatus) {
      return c.json(createErrorResponse(ErrorType.RUNTIME_TIMEOUT, 'Runtime status not found'), 500)
    }

    // Find build job pod (for build logs) or runtime pod
    const jobList = await k8sBatchApi.listNamespacedJob({
      namespace: KUBERNETES_NAMESPACE,
      labelSelector: `appwrite.io/runtime-id=${runtimeId},appwrite.io/role=build`,
    })

    let podName: string | null = null
    let containerName = 'build-container'
    const loggingPath = '/tmp/logging'

    if (jobList.items.length > 0) {
      // Find pod for the most recent build job
      const job = jobList.items[0]
      const podList = await k8sCoreApi.listNamespacedPod({
        namespace: KUBERNETES_NAMESPACE,
        labelSelector: `job-name=${job.metadata?.name}`,
      })

      if (podList.items.length > 0) {
        podName = podList.items[0].metadata?.name || null
      }
    }

    // If no build job pod found, try to find runtime pod (for runtime logs)
    if (!podName) {
      const podList = await k8sCoreApi.listNamespacedPod({
        namespace: KUBERNETES_NAMESPACE,
        labelSelector: `appwrite.io/runtime-id=${runtimeId},appwrite.io/role=runtime`,
      })

      if (podList.items.length > 0) {
        podName = podList.items[0].metadata?.name || null
        containerName = 'runtime-container'
      }
    }

    if (!podName) {
      return c.json(createErrorResponse(ErrorType.RUNTIME_NOT_FOUND, 'No pod found for this runtime'), 404)
    }

    // Wait for logging files to exist (similar to Docker version)
    const checkStartTime = Date.now()
    while (Date.now() - checkStartTime < timeoutSeconds * 1000) {
      try {
        const logsExists = await fileExistsInPod(podName, containerName, `${loggingPath}/logs.txt`)
        const timingsExists = await fileExistsInPod(podName, containerName, `${loggingPath}/timings.txt`)

        if (logsExists && timingsExists) {
          // Check if timings file has content
          const timingsContent = await readFileFromPod(podName, containerName, `${loggingPath}/timings.txt`)
          if (timingsContent.trim().length > 0) {
            break
          }
        }
      } catch {
        // Continue waiting
      }

      // Ensure runtime is still present
      const status = await getRuntimeStatus(runtimeId)
      if (status === null) {
        return c.text('')
      }

      await delay(500)
    }

    // Create a readable stream for log streaming
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Stream logs - use tail -F directly
          const streamInterval = 1000 // 1 second for sending accumulated logs
          let logsChunk = ''
          let offset = 0
          const startDateTime = new Date()

          // Read initial logs content to get offset
          let logsContent = ''
          let introOffset = 0
          try {
            logsContent = await readFileFromPod(podName!, containerName, `${loggingPath}/logs.txt`)
            introOffset = getLogOffset(logsContent)
          } catch {
            // If we can't read logs, close stream
            controller.close()
            return
          }

          // Timer to send accumulated logs periodically (similar to Docker version)
          const streamTimer = setInterval(() => {
            // Check if runtime is still present and not initialised
            getRuntimeStatus(runtimeId).then((status) => {
              if (status === null) {
                clearInterval(streamTimer)
                if (logsChunk) {
                  controller.enqueue(new TextEncoder().encode(logsChunk))
                }
                controller.close()
                return
              }

              // If runtime is initialised, send remaining logs and stop
              if (status.initialised === 1) {
                if (logsChunk) {
                  controller.enqueue(new TextEncoder().encode(logsChunk))
                  logsChunk = ''
                }
                clearInterval(streamTimer)
                controller.close()
                return
              }

              // Send accumulated logs
              if (logsChunk) {
                controller.enqueue(new TextEncoder().encode(logsChunk))
                logsChunk = ''
              }
            })
          }, streamInterval)

          // Use tail -F directly (like Docker version)
          let tailProcessCleanup: (() => void) | null = null
          tailProcessCleanup = tailFileInPod(
            podName!,
            containerName,
            `${loggingPath}/timings.txt`,
            async (timingChunk: string) => {
              try {
                // Check if logs file still exists
                const logsExists = await fileExistsInPod(podName!, containerName, `${loggingPath}/logs.txt`)
                if (!logsExists) {
                  if (tailProcessCleanup) {
                    tailProcessCleanup()
                  }
                  return
                }

                // Parse timing entries
                const parts = parseTiming(timingChunk, startDateTime)

                // Read logs content again to get latest
                logsContent = await readFileFromPod(podName!, containerName, `${loggingPath}/logs.txt`)

                // Process each timing part
                for (const part of parts) {
                  const timestamp = part.timestamp
                  const length = part.length

                  const logContent =
                    logsContent.slice(introOffset + offset, introOffset + offset + Math.abs(length)) || ''
                  const escapedContent = logContent.replace(/\n/g, '\\n')

                  const output = `${timestamp} ${escapedContent}\n`
                  logsChunk += output
                  offset += length
                }
              } catch (err) {
                console.error(`Error processing log chunk for ${runtimeId}:`, err)
              }
            },
            (error: Error) => {
              console.error(`Error in tail process for ${runtimeId}:`, error)
              clearInterval(streamTimer)
              controller.close()
            },
          )

          // Cleanup on timeout
          setTimeout(() => {
            clearInterval(streamTimer)
            if (tailProcessCleanup) {
              tailProcessCleanup()
            }
            if (logsChunk) {
              controller.enqueue(new TextEncoder().encode(logsChunk))
            }
            controller.close()
          }, timeoutSeconds * 1000)
        } catch (err) {
          console.error(`Error in log stream for ${runtimeId}:`, err)
          controller.close()
        }
      },
    })

    // Return streaming response
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error(`Failed to stream logs for runtime ${runtimeId}:`, errorMessage)
    return c.json(createErrorResponse(ErrorType.LOGS_TIMEOUT, `Failed to stream logs for runtime ${runtimeId}`), 500)
  }
})

export default runtimesApp
