// Compatibility entry point for callers that used this script directly.
process.argv.splice(2, 0, 'smoke')
require('./test.cjs')
