const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

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
    'win-dpapi': 'commonjs win-dpapi',
  },
  node: {
    __dirname: false,
    __filename: false,
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'node_modules/@ruffle-rs/ruffle/ruffle.js', to: 'lib/ruffle/ruffle.js' },
        { from: 'node_modules/@ruffle-rs/ruffle', to: 'lib/ruffle', globOptions: { ignore: ['**/*.map', '**/README.md', '**/package.json', '**/LICENSE*'] } },
        { from: 'assets/simhei.ttf', to: 'lib/ruffle/simhei.ttf' },
      ],
    }),
  ],
};
