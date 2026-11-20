export function readUpstreamCompletedAt(value: unknown, unit: 'seconds' | 'milliseconds') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined
  const timestamp = unit === 'seconds' ? value * 1000 : value
  return timestamp >= Date.UTC(2000, 0, 1) && timestamp < Date.UTC(2100, 0, 1) ? timestamp : undefined
}

export function imageCompletionMetadata(upstreamCompletedAt: number | undefined) {
  return upstreamCompletedAt === undefined ? null : JSON.stringify({ upstreamCompletedAt })
}

export function readImageCompletionMetadata(metadataJson: string | null) {
  if (!metadataJson) return undefined
  try {
    const metadata = JSON.parse(metadataJson) as { upstreamCompletedAt?: unknown } | null
    return readUpstreamCompletedAt(metadata?.upstreamCompletedAt, 'milliseconds')
  } catch {
    return undefined
  }
}
