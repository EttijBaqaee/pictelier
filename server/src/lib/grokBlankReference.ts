import sharp from 'sharp'

let blankPng: Promise<Buffer> | undefined

export function shouldAddGrokBlankReference(
  provider: {
    apiMode?: string
    grokApiCompat?: number | boolean
    codexCli?: number | boolean
    grokAddBlankReferenceForSingleImage?: number | boolean
  },
  taskType: 'image' | 'video',
  inputImageCount: number,
) {
  return taskType === 'image'
    && inputImageCount === 1
    && provider.apiMode === 'images'
    && Boolean(provider.grokApiCompat)
    && !provider.codexCli
    && Boolean(provider.grokAddBlankReferenceForSingleImage)
}

export function applyGrokBlankReferenceTaskSnapshot<T extends object>(
  provider: T,
  taskParams: { grok_add_blank_reference_for_single_image?: unknown },
) {
  return {
    ...provider,
    grokAddBlankReferenceForSingleImage: taskParams.grok_add_blank_reference_for_single_image === true ? 1 : 0,
  }
}

export function getGrokBlankReferencePng() {
  blankPng ??= sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer()
  return blankPng
}
