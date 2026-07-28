var path = require('path');
var MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
  mode: 'development',
  entry: {
    bundle: './renderer/js/main.js',
    style: './renderer/style.css'
  },
  output: {
    path: path.join(__dirname, 'renderer', 'dist'),
    filename: '[name].js'
  },
  target: 'web',
  devtool: 'source-map',
  resolve: {
    modules: [path.join(__dirname, 'renderer', 'js'), 'node_modules']
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: [
          MiniCssExtractPlugin.loader,
          'css-loader',
          'postcss-loader'
        ]
      }
    ]
  },
  plugins: [
    new MiniCssExtractPlugin({
      filename: 'style.css'
    })
  ]
};
