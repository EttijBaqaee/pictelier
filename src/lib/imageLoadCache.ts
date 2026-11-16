type ImageLoadCacheEntry = {
  displaySrc: string
  ownsObjectUrl: boolean
}

const imageLoadCache = new Map<string, ImageLoadCacheEntry>()
const imageLoadCacheById = new Map<string, ImageLoadCacheEntry>()
const MAX_IMAGE_LOAD_CACHE_SIZE = 64

function releaseUnreferencedObjectUrl(entry: ImageLoadCacheEntry | undefined) {
  if (!entry?.ownsObjectUrl || !entry.displaySrc.startsWith('blob:')) return
  // A URL may be shared by its source URL and image ID, including two viewers.
  if ([...imageLoadCache.values(), ...imageLoadCacheById.values()]
    .some((current) => current.displaySrc === entry.displaySrc)) return
  URL.revokeObjectURL(entry.displaySrc)
}

function touchCacheEntry<T>(cache: Map<string, T>, key: string, entry: T) {
  cache.delete(key)
  cache.set(key, entry)
}

function evictCacheIfNeeded(cache: Map<string, ImageLoadCacheEntry>) {
  while (cache.size > MAX_IMAGE_LOAD_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) break
    const entry = cache.get(oldestKey)
    cache.delete(oldestKey)
    releaseUnreferencedObjectUrl(entry)
  }
}

function setCacheEntry(
  cache: Map<string, ImageLoadCacheEntry>,
  key: string,
  displaySrc: string,
  ownsObjectUrl: boolean,
) {
  if (!key || !displaySrc) return
  const existing = cache.get(key)
  touchCacheEntry(cache, key, { displaySrc, ownsObjectUrl })
  if (existing?.displaySrc !== displaySrc) releaseUnreferencedObjectUrl(existing)
  evictCacheIfNeeded(cache)
}

export function peekCachedLoadedImageSrc(src: string) {
  if (!src) return null
  return imageLoadCache.get(src)?.displaySrc ?? null
}

export function getCachedLoadedImageSrc(src: string) {
  if (!src) return null
  const entry = imageLoadCache.get(src)
  if (!entry) return null
  touchCacheEntry(imageLoadCache, src, entry)
  return entry.displaySrc
}

export function setCachedLoadedImageSrc(src: string, displaySrc: string, ownsObjectUrl: boolean) {
  setCacheEntry(imageLoadCache, src, displaySrc, ownsObjectUrl)
}

export function peekCachedLoadedImageById(imageId: string) {
  if (!imageId) return null
  return imageLoadCacheById.get(imageId)?.displaySrc ?? null
}

export function getCachedLoadedImageById(imageId: string) {
  if (!imageId) return null
  const entry = imageLoadCacheById.get(imageId)
  if (!entry) return null
  touchCacheEntry(imageLoadCacheById, imageId, entry)
  return entry.displaySrc
}

export function setCachedLoadedImageById(imageId: string, displaySrc: string, ownsObjectUrl: boolean) {
  setCacheEntry(imageLoadCacheById, imageId, displaySrc, ownsObjectUrl)
}

export function releaseCachedLoadedImageSrc(src: string) {
  const entry = imageLoadCache.get(src)
  if (!entry) return
  imageLoadCache.delete(src)
  releaseUnreferencedObjectUrl(entry)
}

export function releaseCachedLoadedImageById(imageId: string) {
  const entry = imageLoadCacheById.get(imageId)
  if (!entry) return
  imageLoadCacheById.delete(imageId)
  releaseUnreferencedObjectUrl(entry)
}
