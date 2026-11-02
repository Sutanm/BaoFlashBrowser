declare module '*.user.js?native' {
  const install: (gm: unknown, locale: string) => () => void;
  export default install;
}
