import type * as k8s from '@kubernetes/client-node'
import { S3_ACCESS_KEY_ID, S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_SECRET_ACCESS_KEY } from '../s3/config'
import { getS3DeleteScript, getS3DownloadScript } from '../s3/scripts'

// --- Build Job Definition ---
interface BuildJobParams {
  jobName: string
  runtimeId: string
  image: string
  sourceCode: string
  command: string
  artifactPath: string
  version: string
  variables: Record<string, string>
}

export const createBuildJobDefinition = ({
  jobName,
  runtimeId,
  image,
  sourceCode,
  command,
  artifactPath,
  version,
  variables,
}: BuildJobParams): k8s.V1Job => {
  // Determine source file extension
  const sourceFile = sourceCode.includes('tar.gz') ? 'code.tar.gz' : 'code.tar'
  const buildFile = variables['OPEN_RUNTIMES_BUILD_COMPRESSION'] === 'none' ? 'code.tar' : 'code.tar.gz'

  // Build command with logging for v5
  let buildCommand = command
  if (version === 'v2') {
    buildCommand = `touch /var/tmp/logs.txt && (${command}) >> /var/tmp/logs.txt 2>&1 && cat /var/tmp/logs.txt`
  } else {
    buildCommand = `mkdir -p /tmp/logging && touch /tmp/logging/timings.txt && touch /tmp/logging/logs.txt && script --log-out /tmp/logging/logs.txt --flush --log-timing /tmp/logging/timings.txt --return --quiet --command "${command.replace(/"/g, '\\"')}"`
  }

  const codeMountPath = version === 'v2' ? '/usr/code' : '/mnt/code'
  const workdir = version === 'v2' ? '/usr/code' : ''

  // Convert variables to env array
  const envVars = Object.entries(variables).map(([key, value]) => ({
    name: key,
    value: String(value),
  }))

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      labels: {
        'appwrite.io/role': 'build',
        'appwrite.io/runtime-id': runtimeId,
      },
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 0,
      template: {
        spec: {
          restartPolicy: 'Never',
          volumes: [
            { name: 'source-dir', emptyDir: {} },
            { name: 'build-dir', emptyDir: {} },
            ...(version === 'v5' ? [{ name: 'logging-dir', emptyDir: {} }] : []),
          ],
          initContainers: [
            {
              name: 'prepare-source',
              image: 'alpine:latest',
              command: ['/bin/sh', '-c'],
              args: [
                `echo "$SOURCE_CODE_BASE64" | base64 -d > /source/${sourceFile} && ` +
                  `tar -xzf /source/${sourceFile} -C /source 2>/dev/null || tar -xf /source/${sourceFile} -C /source`,
              ],
              env: [{ name: 'SOURCE_CODE_BASE64', value: sourceCode }],
              volumeMounts: [{ name: 'source-dir', mountPath: '/source' }],
            },
          ],
          containers: [
            {
              name: 'build-container',
              image: image,
              workingDir: workdir || '/source',
              command: ['/bin/sh', '-c'],
              args: [
                `${buildCommand} && ` +
                  `tar -czf /tmp/artifact.tar.gz . && ` +
                  `aws configure set aws_access_key_id $S3_ACCESS_KEY_ID && ` +
                  `aws configure set aws_secret_access_key $S3_SECRET_ACCESS_KEY && ` +
                  `aws configure set region $S3_REGION && ` +
                  `aws --endpoint-url $S3_ENDPOINT s3 cp /tmp/artifact.tar.gz s3://$S3_BUCKET/${artifactPath}`,
              ],
              env: [
                { name: 'S3_ENDPOINT', value: S3_ENDPOINT },
                { name: 'S3_BUCKET', value: S3_BUCKET },
                { name: 'S3_ACCESS_KEY_ID', value: S3_ACCESS_KEY_ID },
                {
                  name: 'S3_SECRET_ACCESS_KEY',
                  value: S3_SECRET_ACCESS_KEY,
                },
                { name: 'S3_REGION', value: S3_REGION },
                ...envVars,
              ],
              volumeMounts: [
                { name: 'source-dir', mountPath: '/tmp' },
                { name: 'build-dir', mountPath: codeMountPath },
                ...(version === 'v5' ? [{ name: 'logging-dir', mountPath: '/tmp/logging' }] : []),
              ],
            },
          ],
        },
      },
    },
  }
}

// --- Runtime Service and Deployment Definitions ---
interface RuntimeResourcesParams {
  runtimeId: string
  image: string
  artifactPath: string
  version: string
  entrypoint: string
  runtimeEntrypoint: string
  variables: Record<string, string>
  secret: string
  cpus: number
  memory: number
  hostname: string
}

export const createRuntimeServiceDefinition = ({ runtimeId }: { runtimeId: string }): k8s.V1Service => {
  const labels = {
    'appwrite.io/role': 'runtime',
    'appwrite.io/runtime-id': runtimeId,
  }
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `svc-${runtimeId}`,
      labels,
    },
    spec: {
      selector: labels,
      ports: [{ port: 3000, targetPort: 3000 }],
    },
  }
}

export const createRuntimeDeploymentDefinition = ({
  runtimeId,
  image,
  artifactPath,
  version,
  entrypoint,
  runtimeEntrypoint,
  variables,
  secret,
  cpus,
  memory,
  hostname,
}: RuntimeResourcesParams): k8s.V1Deployment => {
  const labels = {
    'appwrite.io/role': 'runtime',
    'appwrite.io/runtime-id': runtimeId,
  }

  const codeMountPath = version === 'v2' ? '/usr/code' : '/mnt/code'
  const workdir = version === 'v2' ? '/usr/code' : ''

  // Build environment variables
  const envVars: k8s.V1EnvVar[] = Object.entries(variables).map(([key, value]) => ({
    name: key,
    value: String(value),
  }))

  // Determine runtime entrypoint command
  let entrypointCommand: string[] = []
  if (runtimeEntrypoint) {
    entrypointCommand = ['/bin/sh', '-c', runtimeEntrypoint]
  } else if (version === 'v2' && !entrypoint) {
    entrypointCommand = []
  } else {
    entrypointCommand = ['tail', '-f', '/dev/null']
  }

  const now = Date.now()
  const annotations: Record<string, string> = {
    'appwrite.io/status': 'pending',
    'appwrite.io/initialised': '0',
    'appwrite.io/listening': '0',
    'appwrite.io/created': now.toString(),
    'appwrite.io/updated': now.toString(),
    'appwrite.io/version': version,
    'appwrite.io/secret': secret,
    'appwrite.io/hostname': hostname,
  }

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: `dep-${runtimeId}`,
      labels,
      annotations,
    },
    spec: {
      replicas: 0,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Always',
          volumes: [
            { name: 'code-dir', emptyDir: {} },
            ...(version === 'v5' ? [{ name: 'logs-dir', emptyDir: {} }] : []),
          ],
          initContainers: [
            {
              name: 'fetch-artifact',
              image: 'amazon/aws-cli:latest',
              command: ['/bin/sh', '-c'],
              args: [getS3DownloadScript()],
              env: [
                { name: 'AWS_ACCESS_KEY_ID', value: S3_ACCESS_KEY_ID },
                {
                  name: 'AWS_SECRET_ACCESS_KEY',
                  value: S3_SECRET_ACCESS_KEY,
                },
                { name: 'AWS_REGION', value: S3_REGION },
                { name: 'S3_ENDPOINT', value: S3_ENDPOINT },
                { name: 'S3_BUCKET', value: S3_BUCKET },
                { name: 'ARTIFACT_PATH', value: artifactPath },
              ],
              volumeMounts: [{ name: 'code-dir', mountPath: '/code' }],
            },
          ],
          containers: [
            {
              name: 'runtime-container',
              image: image,
              workingDir: workdir || codeMountPath,
              command: entrypointCommand,
              ports: [{ containerPort: 3000 }],
              env: envVars,
              volumeMounts: [
                { name: 'code-dir', mountPath: codeMountPath },
                ...(version === 'v5' ? [{ name: 'logs-dir', mountPath: '/mnt/logs' }] : []),
              ],
              resources: {
                requests: {
                  cpu: `${cpus}`,
                  memory: `${memory}Mi`,
                },
                limits: {
                  cpu: `${cpus}`,
                  memory: `${memory}Mi`,
                },
              },
            },
          ],
        },
      },
    },
  }
}

// --- Cleanup Job Definition ---
export const createCleanupJobDefinition = (jobName: string, runtimeId: string): k8s.V1Job => ({
  apiVersion: 'batch/v1',
  kind: 'Job',
  metadata: { name: jobName },
  spec: {
    ttlSecondsAfterFinished: 60,
    backoffLimit: 1,
    template: {
      spec: {
        restartPolicy: 'Never',
        containers: [
          {
            name: 'cleanup-container',
            image: 'amazon/aws-cli:latest',
            command: ['/bin/sh', '-c'],
            args: [getS3DeleteScript()],
            env: [
              { name: 'AWS_ACCESS_KEY_ID', value: S3_ACCESS_KEY_ID },
              { name: 'AWS_SECRET_ACCESS_KEY', value: S3_SECRET_ACCESS_KEY },
              { name: 'AWS_REGION', value: S3_REGION },
              { name: 'S3_ENDPOINT', value: S3_ENDPOINT },
              { name: 'S3_BUCKET', value: S3_BUCKET },
              { name: 'RUNTIME_ID', value: runtimeId },
            ],
          },
        ],
      },
    },
  },
})
