declare const __PKG_VERSION__: string;

export const VERSION: string = typeof __PKG_VERSION__ !== 'undefined'
  ? __PKG_VERSION__
  : 'dev';
