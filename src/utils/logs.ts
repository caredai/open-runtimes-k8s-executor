/**
 * Log parsing utilities
 */

/**
 * Get log offset by finding the first linebreak (script command prefix)
 */
export function getLogOffset(logs: string): number {
  const contentSplit = logs.split('\n', 2) // Find first linebreak to identify prefix
  const offset = (contentSplit[0] ?? '').length // Ignore script addition "Script started on..."
  return offset + 1 // Consider linebreak an intro too
}

/**
 * Parse timing string and return array of timestamp and length pairs
 */
export function parseTiming(timing: string, startDateTime?: Date): Array<{ timestamp: string; length: number }> {
  if (!timing.trim()) {
    return []
  }

  const datetime = startDateTime || new Date()
  const parts: Array<{ timestamp: string; length: number }> = []

  const rows = timing.split('\n')
  for (const row of rows) {
    if (!row.trim()) {
      continue
    }

    const [timingStr, lengthStr] = row.split(' ', 2)
    const timingMicroseconds = Math.ceil(parseFloat(timingStr) * 1000000) // Convert to microseconds
    const length = parseInt(lengthStr || '0', 10)

    // Add microseconds to datetime
    const timestampDate = new Date(datetime.getTime() + timingMicroseconds / 1000)
    const timestamp = timestampDate.toISOString().replace('Z', '+00:00')

    parts.push({
      timestamp,
      length,
    })
  }

  return parts
}

/**
 * Get current timestamp in ISO format
 */
export function getTimestamp(): string {
  return new Date().toISOString().replace('Z', '+00:00')
}
