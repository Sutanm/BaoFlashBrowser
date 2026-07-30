const path = require('path');

module.exports = {
  mode: 'development',
  devtool: 'source-map',
  target: 'electron-main',
  entry: {
    main: './src/main/index.ts',
    preload: './src/preload/index.ts',
    'webview-preload': './src/webview-preload/index.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'umd',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@main': path.resolve(__dirname, 'src/main'),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            configFile: 'tsconfig.main.json',
            transpileOnly: true,
          },
        },
        exclude: /node_modules/,
      },
    ],
  },
  externals: {
    electron: 'commonjs electron',
    'electron-log': 'commonjs electron-log',
    'electron-store': 'commonjs electron-store',
  },
  node: {
    __dirname: false,
    __filename: false,
  },
};
