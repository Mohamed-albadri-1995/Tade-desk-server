// Minimal CommonJS shim for the ESM 'uuid' package used only in Jest.
let _counter = 0;
module.exports.v4 = function v4() {
  _counter++;
  return 'test-' + Date.now().toString(36) + '-' + _counter.toString(36);
};
