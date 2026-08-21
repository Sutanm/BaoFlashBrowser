import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

const provenance = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'provenance.json'), 'utf8')) as {
  project: string;
  author: string;
  origin: string;
  year: number;
  fingerprint: string;
};
const provenanceShortId = `bfb:${provenance.fingerprint.slice(7, 23)}`;
const provenanceBanner = `/*! ${provenance.project} | Copyright (c) ${provenance.year} ${provenance.author} | ${provenanceShortId} | ${provenance.origin} */`;

export default defineConfig({
  root: 'src/renderer',
  plugins: [
    react(),
    {
      name: 'bao-provenance-banner',
      enforce: 'post',
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk') output.code = `${provenanceBanner}\n${output.code}`;
        }
      },
    },
    // Electron loadFile() 使用 file:// 协议，绝对路径 /bundle.js 会解析到磁盘根目录
    // 强制所有路径为相对路径，确保 file:// 下正确加载
    {
      name: 'fix-file-protocol-paths',
      enforce: 'post',
      transformIndexHtml(html) {
        // file:// 协议下绝对路径解析到磁盘根目录，全部转相对路径
        return html
          .replace(/ src="\/bundle\.js"/g, ' src="./bundle.js"')
          .replace(/ href="\/bundle\.css"/g, ' href="./bundle.css"');
      },
    },
  ],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
  build: {
    target: 'chrome87',
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/renderer/index.html'),
      output: {
        entryFileNames: 'bundle.js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) return 'bundle.css';
          return '[name][extname]';
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
