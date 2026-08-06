// TypeScript declaration for embedding built-in userscript sources as text
// (esbuild loader: { '.user.js': 'text' }).
declare module '*.user.js' {
  const source: string;
  export default source;
}
