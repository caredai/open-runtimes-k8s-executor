// --- S3 Configuration ---
// Validate required S3 environment variables
const S3_ENDPOINT_RAW = process.env.S3_ENDPOINT
const S3_BUCKET_RAW = process.env.S3_BUCKET
const S3_ACCESS_KEY_ID_RAW = process.env.S3_ACCESS_KEY_ID
const S3_SECRET_ACCESS_KEY_RAW = process.env.S3_SECRET_ACCESS_KEY

if (!S3_ENDPOINT_RAW || !S3_BUCKET_RAW || !S3_ACCESS_KEY_ID_RAW || !S3_SECRET_ACCESS_KEY_RAW) {
  const missingVars: string[] = []
  if (!S3_ENDPOINT_RAW) missingVars.push('S3_ENDPOINT')
  if (!S3_BUCKET_RAW) missingVars.push('S3_BUCKET')
  if (!S3_ACCESS_KEY_ID_RAW) missingVars.push('S3_ACCESS_KEY_ID')
  if (!S3_SECRET_ACCESS_KEY_RAW) missingVars.push('S3_SECRET_ACCESS_KEY')

  throw new Error(`S3 environment variables are not fully configured. Missing: ${missingVars.join(', ')}`)
}

// Export validated variables with non-nullable types
export const S3_ENDPOINT: string = S3_ENDPOINT_RAW
export const S3_BUCKET: string = S3_BUCKET_RAW
export const S3_ACCESS_KEY_ID: string = S3_ACCESS_KEY_ID_RAW
export const S3_SECRET_ACCESS_KEY: string = S3_SECRET_ACCESS_KEY_RAW
export const S3_REGION = process.env.S3_REGION || 'us-east-1'
