// Preloaded with `node --import` to make onnxruntime-node's native binding
// unresolvable -- the exact failure an Intel Mac gets from onnxruntime-node
// 1.24+, which ships no darwin/x64 binary. Used by
// tests/embedWorkerFallback.integration.test.ts to exercise the real
// fallback path on a machine whose native runtime would otherwise load.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/onnxruntime_binding\.node$/.test(specifier)) {
      // Same shape as Node's own message for a missing require() target.
      const err = new Error(`Cannot find module '${specifier}'\nRequire stack:\n- ${context.parentURL ?? '<unknown>'}`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return nextResolve(specifier, context);
  },
});
