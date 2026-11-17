// For tests: after every call on the store, what the call changed is saved at
// once and compared with the whole board, so a change that said too little
// about what it touched (see Dirty) fails the call, and not a restart later.
// Before a call, anything a test changed on a board with its own hands is saved
// whole, so it isn't mistaken for the call's.
export function checkAfterEachCall<T extends object>(store: T, prototype: object, except: string[], saveAll: () => void, check: () => void): void {
  let depth = 0;
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const method = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    if (name === 'constructor' || except.includes(name) || typeof method !== 'function') continue;
    (store as Record<string, unknown>)[name] = (...args: unknown[]) => {
      if (depth++ === 0) saveAll();
      try {
        return method.apply(store, args);
      } finally {
        if (--depth === 0) check();
      }
    };
  }
}
