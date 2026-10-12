/**
 * volatile 配置引用的透明化。
 *
 * schemastery 的 `.volatile()` 会把字段解析成引用对象 `Volatile<T>`，真值须经 `.get()`。
 * dsh 0.2 的设置服务只把这类字段投影进插件配置表单（见 `config.ts` 的说明），
 * 因此本插件的 `Config` 必须使用 `.volatile()`；但 50 余处内部读取不该为此改写。
 *
 * `liveConfig()` 在 `apply()` 边界包一层 Proxy：
 * - 读到 volatile 引用时调用 `.get()`，**每次访问都重新取**，因此 Loader 原地提交
 *   新值（`Entry._commitVolatile`）后，内部代码读到的是最新值，热更新语义得以保留；
 * - 读到普通对象时再包一层 Proxy，递归下去；
 * - 数组与原始值原样返回。
 *
 * 注意 `.volatile()` 的引用对象序列化会得到 `{}`，而本函数不会改变外层对象标识，
 * 只是让读取路径经过 `.get()`，所以 `JSON.stringify(liveConfig(cfg))` 反而能拿到真实值。
 *
 * @module dsh-deepseek-web/live-config
 */

/** volatile 引用的最小可判定形状。 */
interface VolatileRef {
  get(): unknown
}

/** 是否是一个 schemastery volatile 引用。 */
function isVolatileRef(value: unknown): value is VolatileRef {
  return typeof value === 'object' && value !== null && typeof (value as VolatileRef).get === 'function'
}

/**
 * 返回一个按普通值读取的配置视图。
 *
 * @param value - Loader 传入的配置（含 volatile 引用）。
 * @returns 读取时自动解引用的等价配置。
 */
export function liveConfig<T>(value: T): T {
  if (isVolatileRef(value)) return liveConfig(value.get() as T)
  if (value === null || typeof value !== 'object') return value
  // 数组不参与 volatile（本插件的 volatile 字段都是标量或数组本身），原样返回即可
  if (Array.isArray(value)) return value
  return new Proxy(value as object, {
    get(target, key, receiver) {
      return liveConfig(Reflect.get(target, key, receiver))
    },
  }) as T
}
