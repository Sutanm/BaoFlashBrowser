// seq-exec.js — GIT_SEQUENCE_EDITOR: 第一个 pick 后插入 exec 修 author
const fs = require('fs');
const todoFile = process.argv[2];
let content = fs.readFileSync(todoFile, 'utf-8');
// 在第一行 pick 后插入 exec
const lines = content.split('\n');
lines.splice(1, 0, 'exec git commit --amend --author="Sutanm <954708543@qq.com>" --no-edit');
fs.writeFileSync(todoFile, lines.join('\n'), 'utf-8');
