import { Writable } from 'node:stream'
import * as k8s from '@kubernetes/client-node'
import { KUBERNETES_NAMESPACE, k8sCoreApi } from '../k8s/client'

/**
 * Read file content from pod using exec
 */
export async function readFileFromPod(podName: string, containerName: string, filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const kc = new k8s.KubeConfig()
    kc.loadFromDefault()
    const exec = new k8s.Exec(kc)
    let stdout = ''
    let stderr = ''

    // Create writable streams to capture output
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
      containerName,
      ['cat', filePath],
      stdoutStream,
      stderrStream,
      process.stdin,
      false,
      (status) => {
        if (status.status === 'Success') {
          resolve(stdout)
        } else {
          reject(new Error(`Failed to read file: ${status.status}. stderr: ${stderr}`))
        }
      },
    )
  })
}

/**
 * Check if file exists in pod
 */
export async function fileExistsInPod(podName: string, containerName: string, filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const kc = new k8s.KubeConfig()
    kc.loadFromDefault()
    const exec = new k8s.Exec(kc)

    const stdoutStream = new Writable({
      write(chunk: Buffer, encoding: string, callback: () => void) {
        callback()
      },
    })

    const stderrStream = new Writable({
      write(chunk: Buffer, encoding: string, callback: () => void) {
        callback()
      },
    })

    exec.exec(
      KUBERNETES_NAMESPACE,
      podName,
      containerName,
      ['test', '-f', filePath],
      stdoutStream,
      stderrStream,
      process.stdin,
      false,
      (status) => {
        resolve(status.status === 'Success')
      },
    )
  })
}

/**
 * Execute tail -F command in pod and stream output via callback
 * Similar to Docker version's Console::execute with callback
 */
export function tailFileInPod(
  podName: string,
  containerName: string,
  filePath: string,
  onData: (chunk: string) => void,
  onError?: (error: Error) => void,
): () => void {
  const kc = new k8s.KubeConfig()
  kc.loadFromDefault()
  const exec = new k8s.Exec(kc)

  const stdoutStream = new Writable({
    write(chunk: Buffer, encoding: string, callback: () => void) {
      onData(chunk.toString('utf-8'))
      callback()
    },
  })

  const stderrStream = new Writable({
    write(chunk: Buffer, encoding: string, callback: () => void) {
      if (onError) {
        onError(new Error(chunk.toString('utf-8')))
      }
      callback()
    },
  })

  exec.exec(
    KUBERNETES_NAMESPACE,
    podName,
    containerName,
    ['tail', '-F', filePath],
    stdoutStream,
    stderrStream,
    process.stdin,
    false,
    (status) => {
      // Status callback - tail -F runs indefinitely, so this may not be called
      if (status.status !== 'Success' && onError) {
        onError(new Error(`Tail command failed: ${status.status}`))
      }
    },
  )

  // Return cleanup function
  return () => {
    // Note: k8s exec doesn't provide a direct way to terminate the process
    // The stream will be closed when the pod is deleted or connection is closed
  }
}
