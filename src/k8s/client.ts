import * as k8s from '@kubernetes/client-node'

// Initialize Kubernetes Client
const kc = new k8s.KubeConfig()
kc.loadFromDefault() // Or kc.loadFromCluster() if running inside a cluster

export const k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api)
export const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api)
export const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api)
export const k8sCoordinationApi = kc.makeApiClient(k8s.CoordinationV1Api)

export const KUBERNETES_NAMESPACE = process.env.KUBERNETES_NAMESPACE || 'default'
