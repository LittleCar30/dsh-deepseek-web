/** 串行化共享浏览器/会话操作；排队时可取消，失败不会阻塞后续请求。 */
export class AsyncLock {
  private tail: Promise<void> = Promise.resolve()

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    const previous = this.tail
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    this.tail = previous.then(() => gate)
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          if (!signal) return
          onAbort = () => reject(signal.reason ?? new Error('请求已取消'))
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        }),
      ])
      signal?.throwIfAborted()
      return release
    } catch (error) {
      release()
      throw error
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
  }
}
