// Shared registry and late-bound cross-module seam for the Log Manager card.
//
// The concern modules used to import each other directly, which produced a
// dense bidirectional import graph. Instead each module registers its mutable
// API object here at load time and other modules reach it through
// `concern(name)`. The registry has no imports of its own, so the static
// import graph stays acyclic:
//
//   views -> card-core.js (leaf)
//   views -> card-utils.js (leaf)
//
// `concern(name)` returns a proxy that resolves the named API object at call
// time, so module evaluation order does not matter and a module that has not
// been loaded yet is a no-op lookup rather than a stale binding.
//
// The returned proxy forwards to the same object the module exports, so the
// test harness's `jest.spyOn(apiObject, "fn")` still intercepts production
// calls.

export const registry = {};

export function concern(name) {
  return new Proxy({}, {
    get(_target, prop) {
      const module = registry[name];
      if (!module) {
        throw new Error(`card module "${name}" is not loaded`);
      }
      return module[prop];
    },
    has(_target, prop) {
      const module = registry[name];
      return !!module && prop in module;
    },
    get ownKeys() {
      const module = registry[name];
      return module ? Reflect.ownKeys(module) : [];
    },
  });
}

// Register a concern module's mutable API object under its registry name.
export function registerConcern(name, apiObject) {
  registry[name] = apiObject;
}
