/**
 * Tagged console logger. Matches the existing bot's `[component]` prefix style.
 */

type Level = 'info' | 'warn' | 'error'

export function makeLogger(tag: string) {
  const prefix = `[${tag}]`
  return {
    info: (...args: unknown[]) => console.log(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
    child: (sub: string) => makeLogger(`${tag}:${sub}`),
    log: (level: Level, ...args: unknown[]) => {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      fn(prefix, ...args)
    },
  }
}

export type Logger = ReturnType<typeof makeLogger>
