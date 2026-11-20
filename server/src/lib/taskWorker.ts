import { normalizeReferenceImageMode } from './referenceImageMode.js'
import type { ImageRequestParams } from './imageCapabilities.js'
import path from 'node:path'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { decryptText } from './crypto.js'
import { createPublicBlankReferenceUrl, preparePublicReferenceImageUrl } from './publicReferenceImages.js'
import { applyGrokBlankReferenceTaskSnapshot } from './grokBlankReference.js'
import type { AppDatabase, TaskRecord } from './db.js'
import { executeImageTask, writeOutputImage, writeOutputImageThumbnail, type GeneratedImageResult } from './imageApi.js'
import { recoverKieTaskOutputs } from './kieApi.js'
import { buildKieUpstreamUsageJson, parseUpstreamUsageJson } from './kieFailedTaskRecover.js'
import { imageCompletionMetadata } from './upstreamImageTime.js'
import { assertAllOutputImagesPersisted, createOutputImagePersistQueue } from './outputImagePersist.js'
import { downloadVideoOutput, generateVideoPoster, pollVideoGeneration, submitVideoGeneration } from './videoApi.js'
import type { TaskEventBus } from './eventBus.js'
import { normalizeProviderErrorMessage } from './providerImageExtract.js'
import { cleanupEmptyTaskMediaDirectories } from './mediaCleanup.js'

export class TaskWorker {
  private running = new Set<string>()
  private cancelled = new Set<string>()
  private pending: string[] = []
  private maxConcurrentTasks: number

  constructor(
    private readonly db: AppDatabase,
    private readonly taskEvents: TaskEventBus,
    private readonly config: {
      appSecret: string
      mediaDir: string
      referenceBasePath?: string
      outputsDir: string
      thumbsDir: string
      maxConcurrentTasks: number
    },
  ) {
    this.maxConcurrentTasks = Math.max(1, Math.floor(config.maxConcurrentTasks) || 1)
  }

  enqueue(taskId: string) {
    if (this.running.has(taskId)) return
    if (this.pending.includes(taskId)) return
    this.pending.push(taskId)
    this.drain()
  }

  setMaxConcurrentTasks(value: number) {
    this.maxConcurrentTasks = Math.max(1, Math.floor(value) || 1)
    this.drain()
  }

  private drain() {
    while (this.running.size < this.maxConcurrentTasks && this.pending.length > 0) {
      const taskId = this.pending.shift()
      if (!taskId || this.running.has(taskId)) continue
      if (this.cancelled.has(taskId) || !this.db.taskExists(taskId)) {
        this.cancelled.delete(taskId)
        continue
      }

      this.start(taskId)
    }
  }

  private start(taskId: string) {
    this.running.add(taskId)
    this.cancelled.delete(taskId)
    void this.process(taskId)
      .catch((error) => {
        console.error(`[TaskWorker] 未处理任务异常: ${taskId}`, error)
      })
      .finally(async () => {
        // A deleted task may still be finishing an in-flight write. Retry the
        // empty-directory cleanup once the worker has stopped writing.
        if (!this.db.taskExists(taskId)) {
          await cleanupEmptyTaskMediaDirectories(this.config.mediaDir, taskId).catch((error) => {
            console.error(`[TaskWorker] 清理任务空目录失败: ${taskId}`, error)
          })
        }
        this.running.delete(taskId)
        this.cancelled.delete(taskId)
        this.drain()
      })
  }

  cancel(taskId: string) {
    this.cancelled.add(taskId)
    this.pending = this.pending.filter((id) => id !== taskId)
  }

  getSnapshot() {
    return {
      runningCount: this.running.size,
      pendingCount: this.pending.length,
      activeTaskIds: [...this.running],
      pendingTaskIds: [...this.pending],
    }
  }

  getTaskRuntimeMeta(taskId: string) {
    const runningCount = this.running.size
    const pendingCount = this.pending.length
    if (this.running.has(taskId)) {
      return {
        runtimeStatus: 'running' as const,
        queuePosition: 0,
        queueAhead: 0,
        runningCount,
        pendingCount,
      }
    }

    const pendingIndex = this.pending.indexOf(taskId)
    if (pendingIndex >= 0) {
      return {
        runtimeStatus: 'queued' as const,
        queuePosition: pendingIndex + 1,
        queueAhead: pendingIndex,
        runningCount,
        pendingCount,
      }
    }

    return {
      runtimeStatus: 'idle' as const,
      queuePosition: null,
      queueAhead: null,
      runningCount,
      pendingCount,
    }
  }

  private isTaskInactive(taskId: string) {
    return this.cancelled.has(taskId) || !this.db.taskExists(taskId)
  }

  private emit(taskId: string, input: { status: string; step: string; percent: number; message?: string | null }) {
    if (this.isTaskInactive(taskId)) return false

    if (input.status === 'failed') {
      this.db.refundTaskQuota(taskId, 'task_failed')
    }

    const updatedTask = this.db.updateTaskProgress({
      id: taskId,
      status: input.status,
      progressPercent: input.percent,
      currentStep: input.step,
      errorMessage: input.status === 'failed' ? input.message ?? null : null,
      finishedAt: input.status === 'succeeded' || input.status === 'failed' ? new Date().toISOString() : null,
    })
    if (!updatedTask) return false

    const event = this.db.appendTaskEvent({
      taskId,
      status: input.status,
      step: input.step,
      percent: input.percent,
      message: input.message ?? null,
    })
    if (!event) return false

    this.taskEvents.emit(taskId, event)
    return true
  }

  private finishImageTask(task: TaskRecord, count: number, recovered = false) {
    // Commit completion and usage statistics together, including restart recovery.
    this.db.sqlite.transaction(() => {
      if (this.isTaskInactive(task.id) || this.db.getTaskCleanupAccess(task.id)?.status === 'succeeded') return
      if (task.ownerKind === 'usage_code' && task.ownerUsageCodeId) {
        this.db.recordUsageCodeOutputImages({ usageCodeId: task.ownerUsageCodeId, count })
        this.db.insertUsageCodeActivityLog({
          usageCodeId: task.ownerUsageCodeId, taskId: task.id, actorKind: 'user', eventType: 'image_task_succeeded',
          message: `使用码用户生成图片 ${count} 张${recovered ? '（任务恢复）' : ''}`,
        })
      }
      this.emit(task.id, { status: 'succeeded', step: 'succeeded', percent: 100, message: `生成完成，共 ${count} 张图片` })
    }).immediate()
  }

  private async process(taskId: string) {
    const task = this.db.getTask(taskId)
    if (!task) return

    const providerId = task.providerProfileId
    if (!providerId) {
      this.emit(taskId, { status: 'failed', step: 'config', percent: 5, message: '缺少默认 provider 配置' })
      return
    }

    const provider = this.db.getProviderProfile(providerId)
    if (!provider) {
      this.emit(taskId, { status: 'failed', step: 'config', percent: 5, message: 'provider 配置不存在' })
      return
    }

    if (task.taskType === 'video') {
      await this.processVideoTask(taskId, task, provider)
      return
    }

    let runtimeProvider = provider
    let apiKey = ''
    let outputDir = path.join(this.config.outputsDir, taskId)

    try {
      const params = JSON.parse(task.paramsJson) as ImageRequestParams & {
        grok_add_blank_reference_for_single_image?: boolean
      }
      const storedImages = this.db.listTaskImages(taskId)
      const storedOutputs = storedImages.filter((image) => image.kind === 'output')
      // A crash can occur after output commit but before thumbnail/completion.
      // Recover complete, verified outputs instead of submitting them again.
      if (['submitted', 'processing', 'downloading'].includes(task.status) && storedOutputs.length >= params.n) {
        const verified: Array<{ record: typeof storedOutputs[number]; image: GeneratedImageResult }> = []
        for (const record of storedOutputs) {
          const buffer = await fs.readFile(path.join(this.config.mediaDir, record.filePath)).catch(() => null)
          if (!buffer || buffer.length !== record.bytes || crypto.createHash('sha256').update(buffer).digest('hex') !== record.sha256) break
          verified.push({ record, image: { buffer, mimeType: record.mimeType } })
        }
        if (verified.length === storedOutputs.length) {
          for (const { record, image } of verified) {
            if (this.isTaskInactive(taskId)) return
            const thumbnailRecord = storedImages.find((candidate) => {
              if (candidate.kind !== 'thumb') return false
              try { return JSON.parse(candidate.metadataJson ?? '{}').imageId === record.id } catch { return false }
            })
            if (thumbnailRecord && await fs.stat(path.join(this.config.mediaDir, thumbnailRecord.filePath)).then((stat) => stat.isFile() && stat.size === thumbnailRecord.bytes, () => false)) continue
            const thumbnail = await writeOutputImageThumbnail(path.join(this.config.thumbsDir, taskId), record.id, image)
            if (this.isTaskInactive(taskId)) return
            this.db.sqlite.transaction(() => {
              if (thumbnailRecord) this.db.sqlite.prepare('DELETE FROM task_images WHERE id = ?').run(thumbnailRecord.id)
              if (!this.db.addTaskImage({
                id: crypto.randomUUID(), taskId, kind: 'thumb', filePath: path.join('thumbs', taskId, thumbnail.fileName),
                mimeType: thumbnail.mimeType, bytes: thumbnail.bytes, sha256: thumbnail.sha256,
                width: thumbnail.width, height: thumbnail.height, metadataJson: JSON.stringify({ imageId: record.id }),
              })) throw new Error('恢复缩略图失败')
            }).immediate()
          }
          this.finishImageTask(task, storedOutputs.length, true)
          return
        }
      }
      const inputImages = this.db.listTaskImages(taskId).filter((image) => image.kind === 'input')
      const maskImage = this.db.listTaskImages(taskId).find((image) => image.kind === 'mask') ?? null
      apiKey = decryptText(provider.apiKeyEncrypted, this.config.appSecret)

      if (!this.emit(taskId, { status: 'submitted', step: 'submitted', percent: 35, message: '已提交到上游接口' })) return
      if (!this.emit(taskId, { status: 'processing', step: 'processing', percent: 60, message: '正在生成图片' })) return

      const shouldPersistIncrementally = params.n > 1
      outputDir = path.join(this.config.outputsDir, taskId)
      const outputPersistQueue = createOutputImagePersistQueue<GeneratedImageResult>({
        isInactive: () => this.isTaskInactive(taskId),
        getItemKey: (image) => crypto.createHash('sha256').update(image.buffer).digest('hex'),
        persistOne: async (image) => {
          const outputImageId = crypto.randomUUID()
          const written = await writeOutputImage(outputDir, outputImageId, image)
          const saved = this.db.addTaskImage({
            id: outputImageId,
            taskId,
            kind: 'output',
            filePath: path.join('outputs', taskId, written.fileName),
            mimeType: written.mimeType,
            bytes: written.bytes,
            sha256: written.sha256,
            width: written.width,
            height: written.height,
            metadataJson: imageCompletionMetadata(image.upstreamCompletedAt),
          })
          if (!saved) return false

          const thumbnailDir = path.join(this.config.thumbsDir, taskId)
          const thumbnail = await writeOutputImageThumbnail(thumbnailDir, outputImageId, image)
          const thumbnailSaved = this.db.addTaskImage({
            id: crypto.randomUUID(),
            taskId,
            kind: 'thumb',
            filePath: path.join('thumbs', taskId, thumbnail.fileName),
            mimeType: thumbnail.mimeType,
            bytes: thumbnail.bytes,
            sha256: thumbnail.sha256,
            width: thumbnail.width,
            height: thumbnail.height,
            metadataJson: JSON.stringify({ imageId: outputImageId }),
          })
          return thumbnailSaved
        },
      })

      const persistOutputImages = (images: Awaited<ReturnType<typeof executeImageTask>>) =>
        outputPersistQueue.enqueue(images)

      // 任务创建时记录的模型优先于配置当前默认模型
      // runtimeProvider/apiKey/outputDir 提到 try 外层变量，供失败恢复复用
      runtimeProvider = task.providerProfileModel?.trim()
        ? { ...provider, model: task.providerProfileModel.trim() }
        : provider

      // Use the reference options captured when the task was created.
      runtimeProvider = {
        ...runtimeProvider,
        referenceImageMode: normalizeReferenceImageMode(params.reference_image_mode),
      }
      runtimeProvider = applyGrokBlankReferenceTaskSnapshot(runtimeProvider, params)
      const images = await executeImageTask(
        this.db,
        {
          prompt: task.prompt,
          params,
          provider: runtimeProvider,
          inputImages: inputImages.map((image) => ({
            filePath: path.join(this.config.mediaDir, image.filePath),
            mimeType: image.mimeType,
          })),
          maskImage: maskImage
            ? {
                filePath: path.join(this.config.mediaDir, maskImage.filePath),
                mimeType: maskImage.mimeType,
              }
            : null,
        },
        apiKey,
        {
          publicBlankReferenceUrl: () => createPublicBlankReferenceUrl(
            { appSecret: this.config.appSecret, referenceBasePath: this.config.referenceBasePath ?? '' }, runtimeProvider,
          ),
          publicReferenceImageUrl: (image, matchReferenceUrl) => preparePublicReferenceImageUrl(
            { appSecret: this.config.appSecret, referenceBasePath: this.config.referenceBasePath ?? '', mediaDir: this.config.mediaDir }, runtimeProvider,
            path.relative(this.config.mediaDir, image.filePath).split(path.sep).join('/'),
            { mode: runtimeProvider.referenceImageMode, mimeType: image.mimeType, mask: image.filePath === (maskImage ? path.join(this.config.mediaDir, maskImage.filePath) : ''), matchReferenceUrl },
          ),
          onUpstreamRequestId: (requestId) => {
            this.db.updateTaskProgress({
              id: taskId,
              status: 'processing',
              progressPercent: 60,
              currentStep: 'processing',
              upstreamRequestId: requestId,
              upstreamUsageJson: buildKieUpstreamUsageJson({
                kieTaskId: requestId,
                previousJson: this.db.getTask(taskId)?.upstreamUsageJson,
              }),
            })
          },
          onUpstreamMeta: (meta) => {
            const latest = this.db.getTask(taskId)
            this.db.updateTaskProgress({
              id: taskId,
              status: meta.resultUrls?.length ? 'downloading' : 'processing',
              progressPercent: meta.resultUrls?.length ? 82 : 60,
              currentStep: meta.resultUrls?.length ? 'downloading' : 'processing',
              upstreamRequestId: meta.requestId || latest?.upstreamRequestId || null,
              upstreamUsageJson: buildKieUpstreamUsageJson({
                kieTaskId: meta.requestId || latest?.upstreamRequestId || null,
                kieResultUrls: meta.resultUrls || null,
                upstreamCompletedAt: meta.upstreamCompletedAt,
                previousJson: latest?.upstreamUsageJson,
              }),
            })
          },
          onImagesReady: shouldPersistIncrementally
            ? async (readyImages, state) => {
                const ok = await persistOutputImages(readyImages)
                if (!ok) throw new Error('输出图片保存失败')
                void this.emit(taskId, {
                  status: 'downloading',
                  step: 'downloading',
                  percent: Math.min(95, 82 + Math.floor((state.completed / state.total) * 13)),
                  message: `已收到并保存第 ${state.completed}/${state.total} 张图片`,
                })
              }
            : undefined,
          onImageComplete: (completed, total) => {
            if (total <= 1 || shouldPersistIncrementally) return
            const percent = Math.min(80, 60 + Math.floor((completed / total) * 20))
            void this.emit(taskId, {
              status: 'processing',
              step: 'processing',
              percent,
              message: `正在生成图片（${completed}/${total}）`,
            })
          },
        },
      )
      if (this.isTaskInactive(taskId)) return

      if (!shouldPersistIncrementally) {
        if (!this.emit(
          taskId,
          {
            status: 'downloading',
            step: 'downloading',
            percent: 85,
            message: images.length > 1 ? `正在保存输出图片（${images.length} 张）` : '正在保存输出图片',
          },
        )) return

        const ok = await persistOutputImages(images)
        if (!ok) throw new Error('输出图片保存失败')
      } else {
        const ok = await outputPersistQueue.waitForIdle()
        if (!ok) throw new Error('输出图片保存失败')

        const remainingImages = outputPersistQueue.getMissingItems(images)
        if (remainingImages.length > 0) {
          const remainingOk = await persistOutputImages(remainingImages)
          if (!remainingOk) throw new Error('输出图片保存失败')
          const finalOk = await outputPersistQueue.waitForIdle()
          if (!finalOk) throw new Error('输出图片保存失败')
        }
      }

      await outputPersistQueue.waitForIdle()
      assertAllOutputImagesPersisted(outputPersistQueue.getPersistedCount(), images.length)

      if (this.isTaskInactive(taskId)) return
      this.finishImageTask(task, images.length)
    } catch (error) {
      if (this.isTaskInactive(taskId)) return

      const latestTask = this.db.getTask(taskId)
      const upstreamTaskId = latestTask?.upstreamRequestId?.trim() || ''
      const existingOutputs = this.db.listTaskImages(taskId).filter((image) => image.kind === 'output')
      if (existingOutputs.length === 0 && upstreamTaskId && provider.apiMode === 'kie') {
        try {
          if (!this.emit(taskId, {
            status: 'processing',
            step: 'recovering',
            percent: 70,
            message: '上游可能已出图，正在按任务 ID 重新拉取',
          })) return

          const usage = parseUpstreamUsageJson(latestTask?.upstreamUsageJson)
          const recoveredImages = await recoverKieTaskOutputs(
            runtimeProvider, apiKey, upstreamTaskId,
            upstreamTaskId === usage.kieTaskId ? usage.upstreamCompletedAt : undefined,
          )
          if (this.isTaskInactive(taskId)) return

          if (!this.emit(taskId, {
            status: 'downloading',
            step: 'downloading',
            percent: 90,
            message: recoveredImages.length > 1
              ? `正在保存恢复的输出图片（${recoveredImages.length} 张）`
              : '正在保存恢复的输出图片',
          })) return

          const recoverPersistQueue = createOutputImagePersistQueue<GeneratedImageResult>({
            isInactive: () => this.isTaskInactive(taskId),
            getItemKey: (image) => crypto.createHash('sha256').update(image.buffer).digest('hex'),
            persistOne: async (image) => {
              const outputImageId = crypto.randomUUID()
              const written = await writeOutputImage(outputDir, outputImageId, image)
              const saved = this.db.addTaskImage({
                id: outputImageId,
                taskId,
                kind: 'output',
                filePath: path.join('outputs', taskId, written.fileName),
                mimeType: written.mimeType,
                bytes: written.bytes,
                sha256: written.sha256,
                width: written.width,
                height: written.height,
                metadataJson: imageCompletionMetadata(image.upstreamCompletedAt),
              })
              if (!saved) return false

              const thumbnailDir = path.join(this.config.thumbsDir, taskId)
              const thumbnail = await writeOutputImageThumbnail(thumbnailDir, outputImageId, image)
              const thumbnailSaved = this.db.addTaskImage({
                id: crypto.randomUUID(),
                taskId,
                kind: 'thumb',
                filePath: path.join('thumbs', taskId, thumbnail.fileName),
                mimeType: thumbnail.mimeType,
                bytes: thumbnail.bytes,
                sha256: thumbnail.sha256,
                width: thumbnail.width,
                height: thumbnail.height,
                metadataJson: JSON.stringify({ imageId: outputImageId }),
              })
              return thumbnailSaved
            },
          })

          const ok = await recoverPersistQueue.enqueue(recoveredImages)
          if (!ok) throw new Error('输出图片保存失败')
          await recoverPersistQueue.waitForIdle()
          assertAllOutputImagesPersisted(recoverPersistQueue.getPersistedCount(), recoveredImages.length)

          this.finishImageTask(task, recoveredImages.length, true)
          return
        } catch (recoverError) {
          if (this.isTaskInactive(taskId)) return
          this.emit(taskId, {
            status: 'failed',
            step: 'failed',
            percent: 60,
            message: normalizeProviderErrorMessage(recoverError, normalizeProviderErrorMessage(error)),
          })
          return
        }
      }

      this.emit(taskId, {
        status: 'failed',
        step: 'failed',
        percent: 60,
        message: normalizeProviderErrorMessage(error),
      })
    }
  }

  private async processVideoTask(
    taskId: string,
    task: NonNullable<ReturnType<AppDatabase['getTask']>>,
    provider: NonNullable<ReturnType<AppDatabase['getProviderProfile']>>,
  ) {
    try {
      const inputImages = this.db.listTaskImages(taskId).filter((image) => image.kind === 'input' || image.kind === 'video_input')
      const apiKey = decryptText(provider.apiKeyEncrypted, this.config.appSecret)
      const params = JSON.parse(task.paramsJson) as {
        aspect_ratio?: 'auto' | '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'
        resolution: '480p' | '720p' | '1080p'
        duration: 6 | 10 | 15
      }

      if (!this.emit(taskId, { status: 'submitted', step: 'submitted', percent: 10, message: '已提交到视频接口' })) return
      const requestId = await submitVideoGeneration(
        {
          prompt: task.prompt,
          params,
          provider,
          inputImages: inputImages.map((image) => ({
            filePath: path.join(this.config.mediaDir, image.filePath),
            mimeType: image.mimeType,
          })),
        },
        apiKey,
      )
      this.db.updateTaskProgress({
        id: taskId,
        status: 'processing',
        progressPercent: 15,
        currentStep: 'processing',
        upstreamRequestId: requestId,
      })

      const startedAt = Date.now()
      const timeoutMs = Math.max(30, provider.timeoutSeconds) * 1000
      let finalVideoUrl = ''
      let finalDuration: number | null = null
      let finalUsage: unknown = null

      while (!this.isTaskInactive(taskId)) {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error('视频生成超时')
        }
        await new Promise((resolve) => setTimeout(resolve, 5000))
        const result = await pollVideoGeneration(provider, apiKey, requestId)
        finalUsage = result.usage ?? null

        if (result.status === 'failed') {
          throw new Error(result.error?.message || '视频生成失败')
        }

        const progress = Math.max(15, Math.min(95, Number(result.progress) || 15))
        if (result.status !== 'done') {
          if (!this.emit(taskId, {
            status: 'processing',
            step: 'processing',
            percent: progress,
            message: `视频生成中 ${progress}%`,
          })) return
          continue
        }

        if (result.video?.respect_moderation === false || !result.video?.url) {
          throw new Error('视频未通过审核或未返回可下载地址')
        }
        finalVideoUrl = result.video.url
        finalDuration = result.video.duration ?? null
        break
      }

      if (!finalVideoUrl || this.isTaskInactive(taskId)) return
      if (!this.emit(taskId, { status: 'downloading', step: 'downloading', percent: 96, message: '正在保存视频' })) return

      const outputDir = path.join(this.config.outputsDir, taskId)
      const written = await downloadVideoOutput(outputDir, finalVideoUrl, finalDuration, provider.timeoutSeconds)
      const outputVideoId = crypto.randomUUID()
      const saved = this.db.addTaskImage({
        id: outputVideoId,
        taskId,
        kind: 'video_output',
        filePath: path.join('outputs', taskId, written.fileName),
        mimeType: written.mimeType,
        bytes: written.bytes,
        sha256: written.sha256,
        metadataJson: written.metadataJson,
      })
      if (!saved) return
      try {
        const posterDir = path.join(this.config.thumbsDir, taskId)
        const poster = await generateVideoPoster(path.join(outputDir, written.fileName), posterDir)
        this.db.addTaskImage({
          id: crypto.randomUUID(),
          taskId,
          kind: 'thumb',
          filePath: path.join('thumbs', taskId, poster.fileName),
          mimeType: poster.mimeType,
          bytes: poster.bytes,
          sha256: poster.sha256,
          metadataJson: JSON.stringify({ videoId: outputVideoId }),
        })
      } catch (error) {
        console.warn('生成视频预览图失败', error)
      }

      this.db.updateTaskProgress({
        id: taskId,
        status: 'downloading',
        progressPercent: 98,
        currentStep: 'downloading',
        upstreamUsageJson: finalUsage ? JSON.stringify(finalUsage) : null,
      })
      if (task.ownerKind === 'usage_code' && task.ownerUsageCodeId) {
        this.db.recordUsageCodeOutputVideos({
          usageCodeId: task.ownerUsageCodeId,
          count: 1,
        })
        this.db.insertUsageCodeActivityLog({
          usageCodeId: task.ownerUsageCodeId,
          taskId,
          actorKind: 'user',
          eventType: 'video_task_succeeded',
          message: '使用码用户生成视频 1 个',
        })
      }
      this.emit(taskId, { status: 'succeeded', step: 'succeeded', percent: 100, message: '视频生成完成' })
    } catch (error) {
      if (this.isTaskInactive(taskId)) return
      this.emit(taskId, {
        status: 'failed',
        step: 'failed',
        percent: 60,
        message: normalizeProviderErrorMessage(error),
      })
    }
  }
}
