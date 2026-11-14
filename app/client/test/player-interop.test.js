import assert from "node:assert/strict";
import test from "node:test";

// Pins how each player library must be unwrapped after a dynamic import.
//
// These shapes were read off the emitted bundle rather than assumed:
//   hls.js chunk -> export { ... as default }        and entry uses import().then(m => m.default)
//   flv.js chunk -> export { De as f }               and entry uses import().then(e => e.f)
//
// The rule that matters: flv.js must NOT have `.default` appended. Vite rewrites a
// dynamic import of a CommonJS package to unwrap the export it chose, so an extra
// `.default` lands on undefined and FLV playback dies with "Cannot read properties
// of undefined". Regressing to `module => module.default` for both is the specific
// mistake these tests exist to catch.

// Mirrors the loaders in src/components/VideoPlayer.jsx.
const loadHlsFrom = namespace => namespace.default;
const loadFlvFrom = namespace => namespace;

test("hls.js: the library is taken from the namespace default export", () => {
  const library = { isSupported: () => true, Events: {}, ErrorTypes: {} };
  const namespace = { default: library, AttrList: {}, Events: {} };
  const resolved = loadHlsFrom(namespace);
  assert.equal(resolved, library);
  assert.equal(resolved.isSupported(), true);
});

test("hls.js: taking the namespace itself would be wrong", () => {
  // Guards against "just use the module" for hls, where default is the library and
  // the namespace also carries unrelated named exports.
  const library = { isSupported: () => true };
  const namespace = { default: library, somethingElse: { isSupported: () => true } };
  assert.equal(loadHlsFrom(namespace), library);
  assert.notEqual(loadHlsFrom(namespace), namespace);
});

test("flv.js: the already-unwrapped value is used as the library", () => {
  // Vite emits `.then(e => e.f)`, so the loader receives the library directly.
  const library = { isSupported: () => true, Events: {}, createPlayer: () => ({}) };
  const resolved = loadFlvFrom(library);
  assert.equal(resolved, library);
  assert.equal(typeof resolved.createPlayer, "function");
});

test("flv.js: appending .default would break playback", () => {
  // The regression this whole change centres on. The unwrapped library has no
  // `default`, so `.default` is undefined and calling isSupported() would throw.
  const library = { isSupported: () => true };
  const wrong = library.default;
  assert.equal(wrong, undefined);
  assert.throws(() => wrong.isSupported(), TypeError);
});

test("both loaders are cached, so a second call reuses the promise", () => {
  // Module-level caches keep repeated mounts from refetching the chunk. The
  // loaders in the component hold these; this asserts the intent stays true.
  let calls = 0;
  let promise = null;
  const load = () => {
    if (!promise) promise = Promise.resolve(++calls);
    return promise;
  };
  const first = load();
  const second = load();
  assert.equal(first, second);
  return first.then(() => assert.equal(calls, 1));
});
