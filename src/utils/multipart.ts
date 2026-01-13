/**
 * Multipart form data utilities
 */

/**
 * Create multipart form data body and boundary
 */
export function createMultipartBody(data: Record<string, unknown>): { body: string; boundary: string } {
  const boundary = `----WebKitFormBoundary${Date.now().toString(36)}`
  const parts: string[] = []

  for (const [key, value] of Object.entries(data)) {
    parts.push(`--${boundary}`)
    parts.push(`Content-Disposition: form-data; name="${key}"`)
    parts.push('')
    // Convert value to string, handling arrays and objects
    let stringValue = ''
    if (value === null || value === undefined) {
      stringValue = ''
    } else if (typeof value === 'object') {
      stringValue = JSON.stringify(value)
    } else {
      stringValue = String(value)
    }
    parts.push(stringValue)
  }

  parts.push(`--${boundary}--`)
  parts.push('')

  return {
    body: parts.join('\r\n'),
    boundary,
  }
}

/**
 * Get multipart content type header
 */
export function getMultipartContentType(boundary: string): string {
  return `multipart/form-data; boundary=${boundary}`
}
