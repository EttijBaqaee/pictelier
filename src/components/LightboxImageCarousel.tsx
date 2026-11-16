import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { useStore, cacheTaskImageForEditing } from '../store'
import { useTrackedImageLoad } from '../hooks/useTrackedImageLoad'
import { resolveTaskImageDisplaySrc } from '../lib/resolveTaskImageDisplay'
import {
  isTouchTapLike,
  resolveTouchAxisLock,
  resolveTouchSwipeThreshold,
  type ImageCarouselHandle,
  type TouchAxisLock,
} from '../lib/touchGesture'
import ImageLoadingOverlay from './ImageLoadingOverlay'

interface LightboxSlideProps {
  imageId: string
  isActive: boolean
  imageIndex: number
  imageTotal: number
  maskPreviewSrc?: string
}

function LightboxSlide({
  imageId,
  isActive,
  imageIndex,
  imageTotal,
  maskPreviewSrc,
}: LightboxSlideProps) {
  const slideRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const [fitSize, setFitSize] = useState<{ width: number; height: number } | null>(null)
  const tasks = useStore((s) => s.tasks)
  const matchedTask = tasks.find((item) =>
    item.inputImageIds.includes(imageId) ||
    item.outputImages.includes(imageId) ||
    item.maskImageId === imageId,
  ) ?? null
  const remoteSrc = matchedTask?.imageUrlsById?.[imageId] ?? ''
  const syncSrc = resolveTaskImageDisplaySrc(imageId, tasks)
  const loadSrc = remoteSrc || syncSrc
  const expectedBytes = matchedTask?.imageBytesById?.[imageId] ?? null

  const {
    displaySrc,
    isLoading,
    showLoadingOverlay,
    progress,
  } = useTrackedImageLoad(loadSrc, {
    imageId,
    expectedBytes,
    enabled: Boolean(imageId && loadSrc),
  })

  const showOverlay = isActive && (showLoadingOverlay || (!displaySrc && isLoading))

  useLayoutEffect(() => {
    const image = imageRef.current
    const slide = slideRef.current
    if (!image || !slide || !displaySrc) return
    // 完整显示整张图片，在视口内尽可能放大。
    const fitImage = () => {
      if (!image.complete || !image.naturalWidth || !image.naturalHeight) return
      const style = getComputedStyle(slide)
      const width = slide.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const height = slide.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      if (width <= 0 || height <= 0) return
      const ratio = Math.min(width / image.naturalWidth, height / image.naturalHeight)
      const next = { width: image.naturalWidth * ratio, height: image.naturalHeight * ratio }
      setFitSize((previous) => previous?.width === next.width && previous.height === next.height ? previous : next)
    }
    fitImage()
    const observer = new ResizeObserver(fitImage)
    observer.observe(slide)
    image.addEventListener('load', fitImage)
    return () => {
      observer.disconnect()
      image.removeEventListener('load', fitImage)
    }
  }, [displaySrc])

  return (
    <div
      ref={slideRef}
      className="relative flex h-full w-full flex-shrink-0 items-center justify-center px-2 py-2 sm:px-4 sm:py-4"
    >
      {showOverlay && (
        <ImageLoadingOverlay
          progress={progress}
          imageIndex={imageIndex}
          imageTotal={imageTotal}
          variant="dark"
        />
      )}
      <div className="relative inline-flex max-h-full max-w-full items-center justify-center">
        {displaySrc ? (
          <img
            ref={imageRef}
            src={displaySrc}
            data-image-id={imageId}
            data-lightbox-active={isActive ? 'true' : undefined}
            data-original-src={matchedTask?.imageUrlsById?.[imageId]}
            style={fitSize ?? undefined}
            className={`saveable-image max-h-full max-w-full object-contain rounded-lg shadow-2xl ${
              showLoadingOverlay && isActive ? 'opacity-0' : 'opacity-100'
            }`}
            onLoad={(event) => {
              if (!isActive) return
              const remoteUrl = matchedTask?.imageUrlsById?.[imageId]
              if (!remoteUrl) return
              void cacheTaskImageForEditing(imageId, remoteUrl, event.currentTarget)
            }}

            onDragStart={(event) => event.preventDefault()}
            alt=""
            draggable={false}
          />
        ) : null}
        {isActive && maskPreviewSrc && !showLoadingOverlay && displaySrc ? (
          <img
            src={maskPreviewSrc}
            className="pointer-events-none absolute inset-0 m-auto h-full w-full rounded-lg object-contain"
            alt=""
          />
        ) : null}
      </div>
    </div>
  )
}

export interface LightboxCarouselNavState {
  dragOffset: number
  isDragging: boolean
  panelWidth: number
}

interface LightboxImageCarouselProps {
  imageIds: string[]
  currentIndex: number
  maskPreviewSrc?: string
  zoomTransform: string
  zoomTransition: string
  swipeEnabled: boolean
  onIndexChangeRequest: (nextIndex: number) => void
  onNavStateChange?: (state: LightboxCarouselNavState) => void
  onSwipeGesture?: (payload: { didSwipe: boolean; tapLike: boolean }) => void
  carouselPanelRef?: React.RefObject<HTMLDivElement | null>
}

const LightboxImageCarousel = forwardRef<ImageCarouselHandle, LightboxImageCarouselProps>(
  function LightboxImageCarousel({
  imageIds,
  currentIndex,
  maskPreviewSrc,
  zoomTransform,
  zoomTransition,
  swipeEnabled,
  onIndexChangeRequest,
  onNavStateChange,
  onSwipeGesture,
  carouselPanelRef,
}, ref) {
  const internalPanelRef = useRef<HTMLDivElement>(null)
  const panelRef = carouselPanelRef ?? internalPanelRef
  const [dragOffset, setDragOffset] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const isDraggingRef = useRef(false)
  const [panelWidth, setPanelWidth] = useState(0)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const swipeLockRef = useRef<TouchAxisLock>(null)
  const dragOffsetRef = useRef(0)
  const currentIndexRef = useRef(currentIndex)

  const imageTotal = imageIds.length
  const showTrack = imageTotal > 1
  const slideWidth = panelWidth > 0 ? panelWidth : 0

  useLayoutEffect(() => {
    currentIndexRef.current = currentIndex
  }, [currentIndex])

  useEffect(() => {
    isDraggingRef.current = isDragging
  }, [isDragging])

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const updateWidth = () => {
      const nextWidth = Math.round(panel.clientWidth)
      if (nextWidth > 0) setPanelWidth(nextWidth)
    }
    updateWidth()

    const observer = new ResizeObserver(updateWidth)
    observer.observe(panel)
    window.addEventListener('resize', updateWidth)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateWidth)
    }
  }, [panelRef])

  const updateDragOffset = useCallback((offset: number) => {
    dragOffsetRef.current = offset
    setDragOffset(offset)
  }, [])

  useLayoutEffect(() => {
    onNavStateChange?.({ dragOffset, isDragging, panelWidth })
  }, [dragOffset, isDragging, onNavStateChange, panelWidth])

  const goToIndex = useCallback((nextIndex: number) => {
    if (imageTotal <= 0) return
    const wrapped = ((nextIndex % imageTotal) + imageTotal) % imageTotal
    currentIndexRef.current = wrapped
    onIndexChangeRequest(wrapped)
  }, [imageTotal, onIndexChangeRequest])

  const finishSwipe = useCallback((nextIndex?: number) => {
    isDraggingRef.current = false
    setIsDragging(false)
    updateDragOffset(0)
    if (nextIndex != null) goToIndex(nextIndex)
  }, [goToIndex, updateDragOffset])

  useEffect(() => {
    if (!isDragging) {
      updateDragOffset(0)
    }
  }, [currentIndex, isDragging, updateDragOffset])

  const handleTouchStart = (event: React.TouchEvent) => {
    if (event.touches.length !== 1) {
      touchStartRef.current = null
      swipeLockRef.current = null
      finishSwipe()
      return
    }
    if (!swipeEnabled || !showTrack || slideWidth <= 0) return
    if (!(event.target instanceof Element)) return
    if (!event.target.closest('img.saveable-image') && !event.target.closest('[data-lightbox-carousel]')) return

    touchStartRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }
    swipeLockRef.current = null
    setIsDragging(false)
    updateDragOffset(0)
  }

  const handleTouchMove = (event: React.TouchEvent) => {
    if (event.touches.length !== 1) {
      touchStartRef.current = null
      swipeLockRef.current = null
      finishSwipe()
      return
    }
    if (!touchStartRef.current || !swipeEnabled || !showTrack || slideWidth <= 0) return

    const deltaX = event.touches[0].clientX - touchStartRef.current.x
    const deltaY = event.touches[0].clientY - touchStartRef.current.y
    const nextLock = resolveTouchAxisLock(deltaX, deltaY, swipeLockRef.current)

    if (!swipeLockRef.current && nextLock) {
      swipeLockRef.current = nextLock
      if (nextLock === 'vertical') {
        touchStartRef.current = null
        updateDragOffset(0)
        setIsDragging(false)
        onSwipeGesture?.({ didSwipe: false, tapLike: true })
        return
      }
      if (nextLock === 'horizontal') {
        setIsDragging(true)
      }
    }

    if (swipeLockRef.current !== 'horizontal') return

    if (!isTouchTapLike(deltaX, deltaY)) {
      onSwipeGesture?.({ didSwipe: true, tapLike: false })
    }

    event.preventDefault()
    const atFirst = currentIndexRef.current === 0 && deltaX > 0
    const atLast = currentIndexRef.current === imageTotal - 1 && deltaX < 0
    const resistance = atFirst || atLast ? 0.35 : 1
    updateDragOffset(deltaX * resistance)
  }

  const handleTouchEnd = (event: React.TouchEvent) => {
    if (!touchStartRef.current) return

    const locked = swipeLockRef.current
    const start = touchStartRef.current
    const endX = event.changedTouches[0]?.clientX ?? start.x
    const endY = event.changedTouches[0]?.clientY ?? start.y
    const totalDeltaX = endX - start.x
    const totalDeltaY = endY - start.y
    const tapLike = isTouchTapLike(totalDeltaX, totalDeltaY)
    const currentDragOffset = dragOffsetRef.current
    const activeIndex = currentIndexRef.current

    touchStartRef.current = null
    swipeLockRef.current = null
    setIsDragging(false)

    if (locked !== 'horizontal' || slideWidth <= 0) {
      updateDragOffset(0)
      onSwipeGesture?.({ didSwipe: false, tapLike })
      return
    }

    const threshold = resolveTouchSwipeThreshold(slideWidth)
    const shouldGoNext = currentDragOffset <= -threshold && activeIndex < imageTotal - 1
    const shouldGoPrev = currentDragOffset >= threshold && activeIndex > 0

    if (shouldGoNext) {
      onSwipeGesture?.({ didSwipe: true, tapLike: false })
      finishSwipe(activeIndex + 1)
      return
    }

    if (shouldGoPrev) {
      onSwipeGesture?.({ didSwipe: true, tapLike: false })
      finishSwipe(activeIndex - 1)
      return
    }

    if (!tapLike) {
      onSwipeGesture?.({ didSwipe: true, tapLike: false })
    } else {
      onSwipeGesture?.({ didSwipe: false, tapLike: true })
    }

    finishSwipe()
  }

  const step = useCallback((direction: -1 | 1) => {
    if (isDraggingRef.current || imageTotal <= 1) return
    const current = currentIndexRef.current
    if (direction < 0 && current <= 0) return
    if (direction > 0 && current >= imageTotal - 1) return
    const next = current + direction
    goToIndex(next)
  }, [goToIndex, imageTotal])

  useImperativeHandle(ref, () => ({
    animatePrev: () => step(-1),
    animateNext: () => step(1),
  }), [step])

  const handleTouchCancel = () => {
    touchStartRef.current = null
    swipeLockRef.current = null
    finishSwipe()
    onSwipeGesture?.({ didSwipe: false, tapLike: true })
  }

  const translateX = showTrack && slideWidth > 0
    ? -(currentIndex * slideWidth) + dragOffset
    : 0

  return (
    <div
      ref={panelRef}
      data-lightbox-carousel
      className="relative h-[100dvh] w-[100vw] overflow-hidden"
      style={{ touchAction: 'none' }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
    >
      <div
        className="flex h-full flex-nowrap"
        style={{
          width: slideWidth > 0 ? slideWidth * imageTotal : '100%',
          transform: slideWidth > 0 ? `translate3d(${translateX}px, 0, 0)` : undefined,
          transition: 'none',
          willChange: 'transform',
        }}
      >
        {imageIds.map((imageId, index) => (
          <div
            key={imageId}
            className="h-full flex-shrink-0"
            style={{ width: slideWidth > 0 ? slideWidth : '100%' }}
          >
            <div
              className="relative flex h-full w-full items-center justify-center"
              style={{
                transform: index === currentIndex ? zoomTransform : 'none',
                transition: index === currentIndex ? zoomTransition : 'none',
                willChange: index === currentIndex ? 'transform' : undefined,
              }}
            >
              {Math.abs(index - currentIndex) <= 1 && (
                <LightboxSlide
                  imageId={imageId}
                  isActive={index === currentIndex}
                  imageIndex={index + 1}
                  imageTotal={imageTotal}
                  maskPreviewSrc={index === currentIndex ? maskPreviewSrc : undefined}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})

export default LightboxImageCarousel
